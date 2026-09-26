import type { AgencyId } from "@/constants";
import type {
	Label,
	Network,
	Search,
	TimelineRow,
} from "@/services/journey/types";
import type { Station, StopRef } from "@/services/network";
import { AGENCY_IDS, getStaticFeedUrl } from "@/constants";
import { runQuery } from "@/lib/parquet";
import { clockOf, clockSeconds } from "@/lib/time";
import { admit, cellKey, drainWalks } from "@/services/journey/labels";
import { RAIL_FEEDS, TRANSFER_S, WINDOW_S } from "@/services/journey/types";
import { getStations, getStopRef, stopIdsOf } from "@/services/network";
import { activeServices } from "@/services/schedule";

/**
 * Board the rail feeds from every frontier label (those carrying exactly
 * `round - 1` rides): fetch the timelines of trips they can catch and ride
 * each one forward, admitting labels at every stop it makes.
 */
export async function boardRound(
	search: Search,
	round: number,
	date: string
): Promise<number> {
	const hasFrontier = [...search.labels.values()]
		.flat()
		.some((label) => label.rides === round - 1);
	if (!hasFrontier) return 0;

	let added = 0;
	// Feeds run sequentially: both mutate the shared label set, and parallel
	// scans of the same frontier would race the walk queue.
	for (const feed of RAIL_FEEDS) {
		// eslint-disable-next-line no-await-in-loop
		added += await boardFeed(search, feed, round, date);
	}

	drainWalks(search);

	return added;
}

async function boardFeed(
	search: Search,
	feed: AgencyId,
	round: number,
	date: string
): Promise<number> {
	const frontierInFeed = frontierFor(search, feed, round);
	if (frontierInFeed.length === 0) return 0;

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
	const ids = stationLists.flat();

	const trips = await timelines(feed, ids, activeServices(feed, date), {
		min: Math.max(0, earliest - TRANSFER_S),
		max: earliest + WINDOW_S,
	});
	const stationOf = await stationIndexByStop(feed, trips);

	let added = 0;
	for (const rows of trips.values()) {
		added += rideTrip(search, { feed, rows, byStation, stationOf, round });
	}

	return added;
}

const frontierFor = (search: Search, feed: AgencyId, round: number): Label[] =>
	[...search.labels.values()]
		.flat()
		.filter((label) => label.feed === feed && label.rides === round - 1);

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
	let board = -1;
	let boardLabel: Label | undefined;

	for (const [i, row] of rows.entries()) {
		if (row.departure_time === "") continue;

		const ref = stationOf.get(row.stop_id);
		if (!ref) continue;

		const departure = clockSeconds(row.departure_time);
		boardLabel = byStation
			.get(ref.id)
			?.filter((label) => departure - transferBuffer(label) >= label.arrival)
			.toSorted((a, b) => a.arrival - b.arrival || a.rides - b.rides)[0];

		if (boardLabel) {
			board = i;
			break;
		}
	}

	if (boardLabel === undefined) return 0;

	const boardRow = rows[board];
	let added = 0;

	for (const row of rows.slice(board + 1)) {
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

	return added;
}

/** Boarding requires a minute when the label came from another ride. */
function transferBuffer(label: Label): number {
	return label.via.kind === "ride" ? TRANSFER_S : 0;
}

/**
 * Full stop-by-stop timelines of every active trip boardable from `stopIds`
 * inside the departure window; rows come back grouped by trip, in stop order.
 */
async function timelines(
	agency: AgencyId,
	stopIds: readonly string[],
	service: { sql: string; parameters: string[] },
	window: { min: number; max: number }
): Promise<Map<string, TimelineRow[]>> {
	const stopTimesUrl = getStaticFeedUrl(agency, "stop_times");
	const tripsUrl = getStaticFeedUrl(agency, "trips");

	const rows = await runQuery<TimelineRow>(
		`SELECT st.trip_id, st.stop_id, st.arrival_time, st.departure_time,
			t.route_id, t.trip_headsign, t.shape_id
		 FROM read_parquet('${stopTimesUrl}') st
		 JOIN read_parquet('${tripsUrl}') t ON t.trip_id = st.trip_id
		 WHERE st.trip_id IN (
			 SELECT s.trip_id FROM read_parquet('${stopTimesUrl}') s
			 JOIN read_parquet('${tripsUrl}') t2 ON t2.trip_id = s.trip_id
			 WHERE s.stop_id IN (${stopIds.map(() => "?").join(", ")})
			   AND s.departure_time >= ? AND s.departure_time <= ?
			   AND t2.service_id IN (${service.sql})
		 )
		 ORDER BY st.trip_id, CAST(st.stop_sequence AS INTEGER)`,
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
}

/** Platform rows to the station they belong to, resolved in one batch. */
async function stationIndexByStop(
	agency: AgencyId,
	legs: Map<string, TimelineRow[]>
): Promise<Map<string, StopRef | undefined>> {
	const stopIds = [
		...new Set([...legs.values()].flat().map((row) => row.stop_id)),
	];
	const refs = await Promise.all(
		stopIds.map(async (stopId) => getStopRef(agency, stopId))
	);

	const stations = new Map<string, StopRef | undefined>();
	for (const [i, stopId] of stopIds.entries()) stations.set(stopId, refs[i]);

	return stations;
}

/**
 * All feeds' stations in coarse spatial grids plus an id index, so walking
 * transfers are local lookups instead of all-pairs scans.
 */
export async function stationGrids(): Promise<Network> {
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
}
