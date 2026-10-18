import type { AgencyId } from "@/constants";
import type { Label, Search } from "@/services/journey/types";
import type { Station } from "@/services/network";
import { distanceMeters } from "@/lib/geo";
import {
	CELL_DEGREES,
	TRANSFER_S,
	WALK_M,
	walkMetrics,
} from "@/services/journey/types";

/** Keep a useful mix without letting route-history combinations explode. */
const MAX_PATTERNS_PER_STATION = 6;
/** Nearby walk candidates per feed are bounded to avoid flooding the frontier. */
const MAX_WALK_LINKS_PER_RAIL_FEED = 6;
const MAX_WALK_LINKS_PER_BUS_FEED = 2;
/**
 * Maximum distance from origin or destination (in metres) at which a rail
 * station is allowed to fan out into nearby local bus stops, so local buses
 * act as realistic first-mile / last-mile / cross-corridor feeders rather than
 * expanding every intermediate subway stop across all five boroughs.
 */
const BUS_FEEDER_RADIUS_M = 3500;

/**
 * Rough geographic bounding boxes for each borough bus feed. Walking to a bus
 * feed is only useful when the walk is in that borough, and when either the
 * current position or the destination is in that borough's reach.
 */
const BUS_BOUNDS: Partial<
	Record<
		AgencyId,
		{ minLat: number; maxLat: number; minLon: number; maxLon: number }
	>
> = {
	bus_bx: { minLat: 40.79, maxLat: 40.92, minLon: -73.95, maxLon: -73.77 },
	bus_b: { minLat: 40.57, maxLat: 40.74, minLon: -74.05, maxLon: -73.83 },
	bus_m: { minLat: 40.7, maxLat: 40.88, minLon: -74.02, maxLon: -73.9 },
	bus_q: { minLat: 40.54, maxLat: 40.81, minLon: -73.96, maxLon: -73.7 },
	bus_si: { minLat: 40.49, maxLat: 40.65, minLon: -74.26, maxLon: -74.05 },
	bus_busco: { minLat: 40.56, maxLat: 40.92, minLon: -74.02, maxLon: -73.7 },
};

function inBusBounds(
	feed: AgencyId,
	point: { lat: number; lon: number }
): boolean {
	const box = BUS_BOUNDS[feed];
	if (!box) return true;
	return (
		point.lat >= box.minLat &&
		point.lat <= box.maxLat &&
		point.lon >= box.minLon &&
		point.lon <= box.maxLon
	);
}

function compareLabels(left: Label, right: Label): number {
	return (
		left.arrival - right.arrival ||
		left.rides - right.rides ||
		left.walkSeconds - right.walkSeconds
	);
}

/**
 * Keep nondominated labels per route pattern. An earlier arrival on the same
 * pattern can board everything a later one can, but an earlier arrival on a
 * different pattern must not erase it: that was hiding alternatives such as
 * Q28 → 7 while an earlier LIRR label at the same station continued to win.
 * The destination is exempt so later trains on the same pattern can still be
 * offered. Bound the patterns per station to keep the search finite.
 */
export function admit(search: Search, label: Label): boolean {
	const key = `${label.feed}:${label.station}`;
	const existing = search.labels.get(key) ?? [];

	if (key === search.destKey) {
		existing.push(label);
		search.labels.set(key, existing);
	} else {
		const samePattern = existing.filter(
			(other) => other.pattern === label.pattern
		);
		if (
			samePattern.some(
				(other) =>
					other.arrival <= label.arrival &&
					other.rides <= label.rides &&
					other.walkSeconds <= label.walkSeconds + 30
			)
		)
			return false;

		let survivors = existing.filter(
			(other) =>
				other.pattern !== label.pattern ||
				!(
					label.arrival <= other.arrival &&
					label.rides <= other.rides &&
					label.walkSeconds <= other.walkSeconds + 30
				)
		);
		if (survivors.length >= MAX_PATTERNS_PER_STATION) {
			const slowest = survivors.toSorted(compareLabels).at(-1);
			if (!slowest || compareLabels(label, slowest) >= 0) return false;
			survivors = survivors.filter((other) => other !== slowest);
		}

		survivors.push(label);
		search.labels.set(key, survivors);
	}

	search.walkQueue.push(label);

	return true;
}

export function drainWalks(search: Search): void {
	const queue = search.walkQueue;
	// Array iteration includes labels appended by transfers, without the
	// repeated O(n) shifts that made a large station-complex queue quadratic.
	for (const label of queue) {
		// A walk label is a boarding point, not permission to walk another 600 m
		// and then another. Chaining nearby bus stops let one origin's walk graph
		// flood the whole city, causing every journey to scan every bus feed.
		// Ride/start labels can walk once to an adjacent station; that new label
		// can board, and a later ride opens the next transfer.
		if (label.via.kind !== "walk") soakLabel(search, label);
		// Keep same-feed station complexes reachable even after one street walk;
		// only street walking itself is non-transitive.
		transferLabel(search, label);
	}

	queue.length = 0;
}

function canTransferToBus(search: Search, label: Label): boolean {
	if (label.rides === 0) return true;
	// After 2 rides, transferring onto a 3rd ride that is a local bus is only
	// useful right near the destination (last-mile feeder).
	const maxDist = label.rides >= 2 ? 2000 : BUS_FEEDER_RADIUS_M;
	return distanceMeters(label, search.destLocation) <= maxDist;
}

/**
 * Nearby stations within walking distance of `label` gain a label for being
 * reached on foot. Covers both cross-feed transfers (e.g. subway ↔ LIRR ↔ bus)
 * and short out-of-system same-feed street walks (e.g. Penn Station to Herald Sq).
 */
function soakLabel(search: Search, label: Label): void {
	const inComplexTargets = search.transfers.get(label.feed)?.get(label.station);
	const allowBusTarget = canTransferToBus(search, label);

	for (const [feed, grid] of search.grids) {
		if (!search.allowedFeeds.has(feed)) continue;

		const isBusFeed = feed.startsWith("bus_");
		if (isBusFeed && !allowBusTarget) continue;

		// Same-feed street walks only make sense between rail stations (e.g.
		// Penn Station ↔ Herald Sq), not between two bus stops on the same feed.
		if (feed === label.feed && isBusFeed) continue;

		if (isBusFeed && !inBusBounds(feed, label)) continue;

		// Avoid expanding `bus_busco` (MTA Bus Company express routes into
		// Manhattan) unless the walk or destination is outside Manhattan's core
		// where MTA Bus Company local routes run (Queens/Brooklyn/Bronx).
		if (
			feed === "bus_busco" &&
			inBusBounds("bus_m", label) &&
			inBusBounds("bus_m", search.destLocation)
		)
			continue;

		const maxLinks = isBusFeed
			? MAX_WALK_LINKS_PER_BUS_FEED
			: MAX_WALK_LINKS_PER_RAIL_FEED;

		for (const { station, distance } of near(grid, label, maxLinks)) {
			if (feed === label.feed && station.id === label.station) continue;
			if (feed === label.feed && inComplexTargets?.has(station.id)) continue;

			const { distanceMeters: walkDist, durationSeconds: walkDur } =
				walkMetrics(distance);
			const nextArrival = label.arrival + walkDur;

			admit(search, {
				feed,
				station: station.id,
				lat: station.location.lat,
				lon: station.location.lon,
				arrival: nextArrival,
				rides: label.rides,
				walkSeconds: label.walkSeconds + walkDur,
				walkMeters: label.walkMeters + walkDist,
				pattern: label.pattern,
				round: label.round,
				via: {
					kind: "walk",
					walk: {
						distanceMeters: walkDist,
						durationSeconds: walkDur,
						transferType: "street",
						fromFeed: label.feed,
						fromStation: label.station,
						fromLat: label.lat,
						fromLon: label.lon,
						fromTime: label.arrival,
						toFeed: feed,
						toStation: station.id,
						toLat: station.location.lat,
						toLon: station.location.lon,
						toTime: nextArrival,
					},
					from: label,
				},
			});
		}
	}
}

/** Same-feed in-complex transfers from transfers.txt (Times Sq's 127 to
 * R16/N/Q/R/W, Jamaica's coordinated LIRR interchanges). */
function transferLabel(search: Search, label: Label): void {
	const edges = search.transfers.get(label.feed)?.get(label.station);
	if (!edges) return;

	for (const [station, seconds] of edges) {
		const target = search.stationsById.get(label.feed)?.get(station);
		if (!target) continue;

		const durationSeconds = Math.max(seconds, TRANSFER_S);
		const straight = distanceMeters(label, target.location);
		const distanceMetersValue = Math.max(
			15,
			Math.round(straight > 0 ? straight : durationSeconds * 0.8)
		);
		const nextArrival = label.arrival + durationSeconds;

		admit(search, {
			feed: label.feed,
			station: target.id,
			lat: target.location.lat,
			lon: target.location.lon,
			arrival: nextArrival,
			rides: label.rides,
			walkSeconds: label.walkSeconds + durationSeconds,
			walkMeters: label.walkMeters + distanceMetersValue,
			pattern: label.pattern,
			round: label.round,
			via: {
				kind: "walk",
				walk: {
					distanceMeters: distanceMetersValue,
					durationSeconds,
					transferType: "in-complex",
					fromFeed: label.feed,
					fromStation: label.station,
					fromLat: label.lat,
					fromLon: label.lon,
					fromTime: label.arrival,
					toFeed: label.feed,
					toStation: target.id,
					toLat: target.location.lat,
					toLon: target.location.lon,
					toTime: nextArrival,
				},
				from: label,
			},
		});
	}
}

/** Nearest stations within walking distance in nearby cells. */
function near(
	grid: Map<string, Station[]>,
	label: Label,
	maxLinks: number
): Array<{ station: Station; distance: number }> {
	const row = Math.floor(label.lat / CELL_DEGREES);
	const column = Math.floor(label.lon / CELL_DEGREES);
	const found: Array<{ station: Station; distance: number }> = [];

	for (let r = row - 2; r <= row + 2; r++) {
		for (let c = column - 2; c <= column + 2; c++) {
			for (const station of grid.get(`${r}:${c}`) ?? []) {
				const distance = distanceMeters(label, station.location);
				if (distance <= WALK_M) found.push({ station, distance });
			}
		}
	}

	return found.toSorted((a, b) => a.distance - b.distance).slice(0, maxLinks);
}

export function cellKey(point: { lat: number; lon: number }): string {
	return `${Math.floor(point.lat / CELL_DEGREES)}:${Math.floor(point.lon / CELL_DEGREES)}`;
}
