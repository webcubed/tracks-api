import type { AgencyId } from "@/constants";
import type { Label, Search } from "@/services/journey/types";
import type { Station } from "@/services/network";
import { distanceMeters } from "@/lib/geo";
import {
	CELL_DEGREES,
	TRANSFER_S,
	WALK_M,
	WALK_S,
} from "@/services/journey/types";

/** Keep a useful mix without letting route-history combinations explode. */
const MAX_PATTERNS_PER_STATION = 8;
/** Nearby walk candidates per feed are bounded to avoid flooding the frontier. */
const MAX_WALK_LINKS_PER_FEED = 8;

function compareLabels(left: Label, right: Label): number {
	return left.arrival - right.arrival || left.rides - right.rides;
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
				(other) => other.arrival <= label.arrival && other.rides <= label.rides
			)
		)
			return false;

		let survivors = existing.filter(
			(other) =>
				other.pattern !== label.pattern ||
				!(label.arrival <= other.arrival && label.rides <= other.rides)
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
		// A walk label is a boarding point, not permission to walk another 500 m
		// and then another. Chaining nearby bus stops let one origin's walk graph
		// flood the whole city, causing every journey to scan every bus feed.
		// Ride/start labels can walk once to a directly adjacent feed; that new
		// label can board, and a later ride opens the next transfer.
		if (label.via.kind !== "walk") soakLabel(search, label);
		// Keep same-feed station complexes reachable even after one cross-feed
		// walk; only cross-feed walking itself is non-transitive.
		transferLabel(search, label);
	}

	queue.length = 0;
}

/** Every cross-feed station within walking distance of `label` gains a label
 * for being reached on foot. Same-feed neighbours come from transfers.txt
 * instead: in-feed coordinates can't be trusted at station-complex level. */
function soakLabel(search: Search, label: Label): void {
	for (const [feed, grid] of search.grids) {
		if (feed === label.feed) continue;

		for (const station of near(grid, label)) {
			admit(search, {
				feed,
				station: station.id,
				lat: station.location.lat,
				lon: station.location.lon,
				arrival: label.arrival + WALK_S,
				rides: label.rides,
				pattern: label.pattern,
				round: label.round,
				via: { kind: "walk", from: label },
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

		admit(search, {
			feed: label.feed,
			station: target.id,
			lat: target.location.lat,
			lon: target.location.lon,
			arrival: label.arrival + Math.max(seconds, TRANSFER_S),
			rides: label.rides,
			pattern: label.pattern,
			round: label.round,
			via: { kind: "walk", from: label },
		});
	}
}

/** Nearest cross-feed stations within walking distance in nearby cells. */
function near(grid: Map<string, Station[]>, label: Label): Station[] {
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

	return found
		.toSorted((a, b) => a.distance - b.distance)
		.slice(0, MAX_WALK_LINKS_PER_FEED)
		.map(({ station }) => station);
}

export function cellKey(point: { lat: number; lon: number }): string {
	return `${Math.floor(point.lat / CELL_DEGREES)}:${Math.floor(point.lon / CELL_DEGREES)}`;
}
