import type { AgencyId } from "@/constants";
import type {
	Label,
	Network,
	Search,
	TimelineRow,
} from "@/services/journey/types";
import type { Station, StopRef } from "@/services/network";
import { AGENCY_IDS, getJourneyIndexUrl, getStaticFeedUrl } from "@/constants";
import { memoize } from "@/lib/memoize";
import { runQuery } from "@/lib/parquet";
import { cachedParquet } from "@/lib/parquetCache";
import { clockOf, clockSeconds } from "@/lib/time";
import { admit, cellKey, drainWalks } from "@/services/journey/labels";
import {
	MAX_ITINERARIES,
	TRANSFER_S,
	WINDOW_S,
} from "@/services/journey/types";
import { getStations, getStopRefs, stopIdsOf } from "@/services/network";
import { activeServices } from "@/services/schedule";

/**
 * Cap the number of stations queried per bus feed in a single round so a
 * dense frontier never generates a 1,000-placeholder DuckDB query over a
 * 20 MB remote Parquet file.
 */
const MAX_BUS_FRONTIER_STATIONS = 48;

/**
 * Once we have at least `MAX_ITINERARIES` destination arrivals, prune frontier
 * labels that are already past `earliestDestinationArrival + SLACK_S` so late
 * rounds don't keep scanning unreachable branches.
 */
const DESTINATION_PRUNE_SLACK_S = 4200;

function hasEnoughDestinationArrivals(search: Search): boolean {
	const destLabels = search.labels.get(search.destKey);
	if (!destLabels || destLabels.length < MAX_ITINERARIES) return false;
	const patterns = new Set(destLabels.map((label) => label.pattern));
	return patterns.size >= 3 || destLabels.length >= 12;
}

function destinationCutoff(search: Search): number {
	const destLabels = search.labels.get(search.destKey);
	if (!destLabels || destLabels.length === 0) return Number.POSITIVE_INFINITY;

	const sorted = destLabels
		.map((label) => label.arrival)
		.toSorted((a, b) => a - b);
	const earliest = sorted[0] ?? Number.POSITIVE_INFINITY;
	if (sorted.length >= MAX_ITINERARIES) {
		const fifth = sorted[MAX_ITINERARIES - 1] ?? earliest;
		return Math.min(fifth + 1200, earliest + DESTINATION_PRUNE_SLACK_S);
	}

	return earliest + DESTINATION_PRUNE_SLACK_S;
}

function collectRoundFrontier(
	search: Search,
	round: number,
	cutoff: number
): Map<AgencyId, Label[]> {
	// Only the final round gives up on bus labels. Skipping them a round early
	// dropped slower but useful mixed trips (bus, then two subway legs) before
	// they reached the destination.
	const skipBusFeeds =
		round === 4 &&
		hasEnoughDestinationArrivals(search) &&
		!search.destKey.startsWith("bus_");
	const frontierByFeed = new Map<AgencyId, Label[]>();

	for (const labels of search.labels.values()) {
		for (const label of labels) {
			if (label.rides !== round - 1 || label.arrival > cutoff) continue;
			if (skipBusFeeds && label.feed.startsWith("bus_")) continue;

			const frontier = frontierByFeed.get(label.feed);
			if (frontier) frontier.push(label);
			else frontierByFeed.set(label.feed, [label]);
		}
	}

	return frontierByFeed;
}

function shouldSkipFeedScan(
	search: Search,
	round: number,
	feed: AgencyId
): boolean {
	return (
		round === 4 &&
		feed.startsWith("bus_") &&
		hasEnoughDestinationArrivals(search) &&
		!search.destKey.startsWith("bus_")
	);
}

/**
 * Board every ride feed from each frontier label (those carrying exactly
 * `round - 1` rides): fetch the timelines of trips they can catch and ride
 * each one forward, admitting labels at every stop it makes.
 */
export async function boardRound(
	search: Search,
	round: number,
	feeds: readonly AgencyId[],
	date: string
): Promise<number> {
	if (round >= 4 && hasEnoughDestinationArrivals(search)) return 0;

	const frontierByFeed = collectRoundFrontier(
		search,
		round,
		destinationCutoff(search)
	);
	if (frontierByFeed.size === 0) return 0;

	// Scan rail feeds first so fast rail arrivals establish a tight cutoff before
	// scanning any bus feeds in the same round.
	const orderedFeeds = [
		...feeds.filter((feed) => !feed.startsWith("bus_")),
		...feeds.filter((feed) => feed.startsWith("bus_")),
	];

	let added = 0;
	for (const feed of orderedFeeds) {
		const frontier = frontierByFeed.get(feed);
		if (!frontier || shouldSkipFeedScan(search, round, feed)) continue;

		const currentCutoff = destinationCutoff(search);
		const activeFrontier = frontier.filter(
			(label) => label.arrival <= currentCutoff
		);
		if (activeFrontier.length === 0) continue;

		// eslint-disable-next-line no-await-in-loop
		const scan = await planFeed(feed, activeFrontier, date);
		if (!scan) continue;

		for (const rows of scan.trips.values()) {
			added += rideTrip(search, { ...scan, rows, round });
		}
	}

	drainWalks(search);

	return added;
}

type FeedScan = {
	feed: AgencyId;
	byStation: Map<string, Label[]>;
	trips: Map<string, TimelineRow[]>;
	stationOf: Map<string, StopRef | undefined>;
};

/** One feed's round: the frontier's stop ids and the timelines of trips
 * boardable from them. New labels belong to a later round and cannot board
 * during this scan. */
async function planFeed(
	feed: AgencyId,
	frontierInFeed: Label[],
	date: string
): Promise<FeedScan | undefined> {
	const byStation = new Map<string, Label[]>();
	for (const label of frontierInFeed) {
		const existing = byStation.get(label.station);
		if (existing) existing.push(label);
		else byStation.set(label.station, [label]);
	}

	let stationKeys = [...byStation.keys()];
	if (
		feed.startsWith("bus_") &&
		stationKeys.length > MAX_BUS_FRONTIER_STATIONS
	) {
		stationKeys = stationKeys
			.toSorted((a, b) => {
				const minA = Math.min(
					...(byStation.get(a)?.map((l) => l.arrival) ?? [Infinity])
				);
				const minB = Math.min(
					...(byStation.get(b)?.map((l) => l.arrival) ?? [Infinity])
				);
				return minA - minB;
			})
			.slice(0, MAX_BUS_FRONTIER_STATIONS);
	}

	const earliest = Math.min(...frontierInFeed.map((label) => label.arrival));
	const stationLists = await Promise.all(
		stationKeys.map(async (id) => stopIdsOf(feed, id))
	);
	const ids = [...new Set(stationLists.flat())].toSorted();
	if (ids.length === 0) return undefined;

	// Timetable rows are minute-granularity. Expand each search window to
	// five-minute boundaries so nearby requests reuse the same remote scan;
	// rideTrip still checks every departure against the exact label time.
	const windowSpan = feed.startsWith("bus_") ? 5400 : WINDOW_S;
	const window = {
		min: Math.max(0, Math.floor((earliest - TRANSFER_S) / 300) * 300),
		max: Math.ceil((earliest + windowSpan) / 300) * 300,
	};
	const trips = await timelines(feed, ids, activeServices(feed, date), window);
	const stationOf = await stationIndexByStop(feed, trips);

	return { feed, byStation, trips, stationOf };
}

type RideScan = {
	feed: AgencyId;
	rows: TimelineRow[];
	byStation: Map<string, Label[]>;
	stationOf: Map<string, StopRef | undefined>;
	round: number;
};

/**
 * One trip: board at the first stop a frontier label can catch, then drop a
 * label at every stop it makes after that. Boarding earlier always dominates
 * boarding later on the same trip.
 */
function rideTrip(search: Search, scan: RideScan): number {
	const { feed, rows, byStation, stationOf, round } = scan;
	// One scheduled trip may be reachable from several useful route patterns at
	// a transfer point. Record each label's first boardable stop; choosing only
	// the earliest label here erased alternatives before ranking got a chance to
	// show them (e.g. LIRR → Penn and Q28 → 7 converging on the same train).
	const boarding = new Map<Label, number>();

	for (const [index, row] of rows.entries()) {
		if (row.departure_time === "") continue;

		const ref = stationOf.get(row.stop_id);
		if (!ref) continue;

		const departure = clockSeconds(row.departure_time);
		for (const label of byStation.get(ref.id) ?? []) {
			if (
				!boarding.has(label) &&
				departure - transferBuffer(label) >= label.arrival
			)
				boarding.set(label, index);
		}
	}

	let added = 0;
	for (const [boardLabel, boardIndex] of boarding) {
		const boardRow = rows[boardIndex];
		const routeLeg = `${feed}:${boardRow.route_id}`;
		if (
			boardLabel.pattern === routeLeg ||
			boardLabel.pattern.endsWith(`|${routeLeg}`)
		)
			continue;

		for (let index = boardIndex + 1; index < rows.length; index++) {
			const row = rows[index];
			if (row.arrival_time === "") continue;

			const ref = stationOf.get(row.stop_id);
			if (!ref?.location) continue;

			const accepted = admit(search, {
				feed,
				station: ref.id,
				lat: ref.location.lat,
				lon: ref.location.lon,
				arrival: clockSeconds(row.arrival_time),
				rides: round,
				walkSeconds: boardLabel.walkSeconds,
				walkMeters: boardLabel.walkMeters,
				pattern: appendRoute(boardLabel.pattern, feed, row.route_id),
				round,
				via: {
					kind: "ride",
					leg: {
						agency: feed,
						route: row.route_id,
						headsign: row.trip_headsign ?? undefined,
						tripId: row.trip_id,
						shapeId: row.shape_id,
						boardStop: boardRow.stop_id,
						boardTime: boardRow.departure_time,
						alightStop: row.stop_id,
						alightTime: row.arrival_time,
						stops: index - boardIndex,
					},
					from: boardLabel,
				},
			});

			if (accepted) added++;
		}
	}

	return added;
}

/** Add the actual line ridden; keep route order as part of the search label. */
function appendRoute(pattern: string, feed: AgencyId, route: string): string {
	const leg = `${feed}:${route}`;
	return pattern ? `${pattern}|${leg}` : leg;
}

/** Boarding requires a minute when the label came from another ride. */
function transferBuffer(label: Label): number {
	return label.via.kind === "ride" ? TRANSFER_S : 0;
}

/**
 * Feeds where the pre-built `_journey_boarding` and `_journey_timeline` parquet
 * assets returned 404 from the release, so subsequent scans go straight to the
 * single-pass `stop_times` + `trips` query without retrying the 404 URL.
 */
const missingJourneyIndexFeeds = new Set<AgencyId>();

async function queryTimelinesFallback(
	agency: AgencyId,
	stopIds: readonly string[],
	service: { sql: string; parameters: string[] },
	window: { min: number; max: number }
): Promise<TimelineRow[]> {
	const stopTimesUrl = getStaticFeedUrl(agency, "stop_times");
	const tripsUrl = getStaticFeedUrl(agency, "trips");

	// Semi-join shape: find the boardable trip ids first (a small distinct
	// set), then pull only those trips' stop rows. The window-function shape
	// this replaces buffered every active stop_time of the day — ~800k rows for
	// a bus feed — to decide `is_boardable`, which is what pushed the process
	// past 512 MB on Render's free tier.
	return runQuery<TimelineRow>(
		`WITH active_trips AS (
			SELECT trip_id, route_id, trip_headsign, shape_id
			FROM read_parquet('${tripsUrl}')
			WHERE service_id IN (${service.sql})
		),
		boardable_trips AS (
			SELECT DISTINCT st.trip_id
			FROM read_parquet('${stopTimesUrl}') st
			JOIN active_trips a ON a.trip_id = st.trip_id
			WHERE st.stop_id IN (${stopIds.map(() => "?").join(", ")})
			  AND st.departure_time >= ? AND st.departure_time <= ?
		)
		SELECT st.trip_id, st.stop_id, st.arrival_time, st.departure_time,
			a.route_id, a.trip_headsign, a.shape_id
		FROM read_parquet('${stopTimesUrl}') st
		JOIN boardable_trips b ON b.trip_id = st.trip_id
		JOIN active_trips a ON a.trip_id = st.trip_id
		ORDER BY st.trip_id, CAST(st.stop_sequence AS INTEGER)`,
		...service.parameters,
		...stopIds,
		clockOf(window.min),
		clockOf(window.max)
	);
}

function stripTrailingSlash(url: string | undefined): string | undefined {
	if (!url) return undefined;
	return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * Full stop-by-stop timelines of active trips boardable from `stopIds` inside
 * the departure window; nearby identical scans share this five-minute cache.
 */
const timelines = memoize(
	async (
		agency: AgencyId,
		stopIds: readonly string[],
		service: { sql: string; parameters: string[] },
		window: { min: number; max: number }
	): Promise<Map<string, TimelineRow[]>> => {
		const indexBase = stripTrailingSlash(process.env.JOURNEY_INDEX_URL_BASE);
		let rows: TimelineRow[];

		if (!missingJourneyIndexFeeds.has(agency) || indexBase) {
			const boardingUrl = indexBase
				? `${indexBase}/${agency}_journey_boarding.parquet`
				: getJourneyIndexUrl(agency, "boarding");
			const timelineUrl = indexBase
				? `${indexBase}/${agency}_journey_timeline.parquet`
				: getJourneyIndexUrl(agency, "timeline");

			try {
				const [boardingSource, timelineSource] = await Promise.all([
					cachedParquet(boardingUrl),
					cachedParquet(timelineUrl),
				]);
				rows = await runQuery<TimelineRow>(
					`WITH boardable_trips AS (
						SELECT DISTINCT b.trip_id
						FROM read_parquet('${boardingSource}') b
						WHERE b.stop_id IN (${stopIds.map(() => "?").join(", ")})
						  AND b.departure_time >= ? AND b.departure_time <= ?
						  AND b.service_id IN (${service.sql})
					)
										SELECT t.trip_id, t.stop_id, t.arrival_time, t.departure_time,
						t.route_id, t.trip_headsign, t.shape_id
					FROM read_parquet('${timelineSource}') t
					JOIN boardable_trips b ON b.trip_id = t.trip_id
					ORDER BY t.trip_id, CAST(t.stop_sequence AS INTEGER)`,
					...stopIds,
					clockOf(window.min),
					clockOf(window.max),
					...service.parameters
				);
			} catch {
				if (!indexBase) missingJourneyIndexFeeds.add(agency);
				rows = await queryTimelinesFallback(agency, stopIds, service, window);
			}
		} else {
			rows = await queryTimelinesFallback(agency, stopIds, service, window);
		}

		const trips = new Map<string, TimelineRow[]>();
		for (const row of rows) {
			let timeline = trips.get(row.trip_id);
			if (!timeline) {
				timeline = [];
				trips.set(row.trip_id, timeline);
			}

			timeline.push(row);
		}

		return trips;
	},
	5 * 60_000,
	// Each entry holds every stop row of every boardable trip in a window —
	// tens of megabytes for a wide bus scan — so the cache is capped low. A
	// journey shares its scans across rounds; later ones miss and rescan rather
	// than hold the peak footprint of a 512 MB host hostage.
	6
);

/** Platform rows to the station they belong to, resolved in one batch. */
async function stationIndexByStop(
	agency: AgencyId,
	legs: Map<string, TimelineRow[]>
): Promise<Map<string, StopRef | undefined>> {
	const stopIds = [
		...new Set([...legs.values()].flat().map((row) => row.stop_id)),
	];
	return getStopRefs(agency, stopIds);
}

/**
 * All feeds' stations in coarse spatial grids plus an id index, so walking
 * transfers are local lookups instead of all-pairs scans.
 */
export const stationGrids = memoize(async (): Promise<Network> => {
	const stationsPerFeed = await Promise.all(
		AGENCY_IDS.map(async (feed) => getStations(feed))
	);
	const grids = new Map<AgencyId, Map<string, Station[]>>();
	const byId = new Map<AgencyId, Map<string, Station>>();

	for (const [i, feed] of AGENCY_IDS.entries()) {
		const grid = new Map<string, Station[]>();
		const idIndex = new Map<string, Station>();

		for (const station of stationsPerFeed[i]) {
			const key = cellKey(station.location);
			const cell = grid.get(key);
			if (cell) cell.push(station);
			else grid.set(key, [station]);
			idIndex.set(station.id, station);
		}

		grids.set(feed, grid);
		byId.set(feed, idIndex);
	}

	return { grids, byId };
});
