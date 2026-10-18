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
import { clockOf, clockSeconds } from "@/lib/time";
import { admit, cellKey, drainWalks } from "@/services/journey/labels";
import { TRANSFER_S, WINDOW_S } from "@/services/journey/types";
import { getStations, getStopRefs, stopIdsOf } from "@/services/network";
import { activeServices } from "@/services/schedule";

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
	const frontierByFeed = new Map<AgencyId, Label[]>();
	for (const labels of search.labels.values()) {
		for (const label of labels) {
			if (label.rides !== round - 1) continue;
			const frontier = frontierByFeed.get(label.feed);
			if (frontier) frontier.push(label);
			else frontierByFeed.set(label.feed, [label]);
		}
	}

	if (frontierByFeed.size === 0) return 0;

	let added = 0;
	// One feed at a time. They share the process's single DuckDB connection, so
	// overlapping the scans only queues them behind one another — measured
	// three times slower end to end than reading them in turn.
	for (const feed of feeds) {
		const frontier = frontierByFeed.get(feed);
		if (!frontier) continue;
		// eslint-disable-next-line no-await-in-loop
		const scan = await planFeed(feed, frontier, date);
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

	const earliest = Math.min(...frontierInFeed.map((label) => label.arrival));
	const stationLists = await Promise.all(
		[...byStation.keys()].map(async (id) => stopIdsOf(feed, id))
	);
	const ids = [...new Set(stationLists.flat())].toSorted();
	if (ids.length === 0) return undefined;

	// Timetable rows are minute-granularity. Expand each search window to
	// five-minute boundaries so nearby requests reuse the same remote scan;
	// rideTrip still checks every departure against the exact label time.
	const window = {
		min: Math.max(0, Math.floor((earliest - TRANSFER_S) / 300) * 300),
		max: Math.ceil((earliest + WINDOW_S) / 300) * 300,
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
		const indexBase = process.env.JOURNEY_INDEX_URL_BASE?.replace(/\/$/, "");
		const boardingUrl = indexBase
			? `${indexBase}/${agency}_journey_boarding.parquet`
			: getJourneyIndexUrl(agency, "boarding");
		const timelineUrl = indexBase
			? `${indexBase}/${agency}_journey_timeline.parquet`
			: getJourneyIndexUrl(agency, "timeline");
		const stopTimesUrl = getStaticFeedUrl(agency, "stop_times");
		const tripsUrl = getStaticFeedUrl(agency, "trips");
		const rows = await runQuery<TimelineRow>(
			`WITH boardable_trips AS (
				SELECT DISTINCT b.trip_id
				FROM read_parquet('${boardingUrl}') b
				WHERE b.stop_id IN (${stopIds.map(() => "?").join(", ")})
				  AND b.departure_time >= ? AND b.departure_time <= ?
				  AND b.service_id IN (${service.sql})
			)
			SELECT t.trip_id, t.stop_id, t.arrival_time, t.departure_time,
				t.route_id, t.trip_headsign, t.shape_id
			FROM read_parquet('${timelineUrl}') t
			JOIN boardable_trips b ON b.trip_id = t.trip_id
			ORDER BY t.trip_id, CAST(t.stop_sequence AS INTEGER)`,
			...stopIds,
			clockOf(window.min),
			clockOf(window.max),
			...service.parameters
		);

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
	5 * 60_000
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
