import type { AgencyId } from "@/constants";
import type { Stops } from "@/types/static";
import { AGENCY_IDS, getStaticFeedUrl } from "@/constants";
import { loadTable } from "@/lib/loadTable";
import { memoize } from "@/lib/memoize";
import { runQuery } from "@/lib/parquet";

export type StopRef = {
	id: string;
	name: string;
	location?: { lat: number; lon: number };
};

export type Station = { id: string; location: { lat: number; lon: number } };

export type TransferIndex = Map<string, Map<string, number>>;

type FeedStops = {
	byId: Map<string, Stops>;
	/** Rows without a `parent_station`: stations and standalone stops. */
	topLevel: Stops[];
	/** Stop id → routes serving it, platforms already unioned into parents. */
	routes: Map<string, Set<string>>;
};

/** `stop_id` → every `route_id` with a trip serving it. */
const routesByStop = memoize(async (agency: AgencyId) => {
	const stopTimesUrl = getStaticFeedUrl(agency, "stop_times");
	const tripsUrl = getStaticFeedUrl(agency, "trips");

	const rows = await runQuery<{ stop_id: string; route_id: string }>(
		`SELECT DISTINCT st.stop_id, t.route_id
		 FROM read_parquet('${stopTimesUrl}') st
		 JOIN read_parquet('${tripsUrl}') t ON t.trip_id = st.trip_id`
	);

	const index = new Map<string, Set<string>>();

	for (const row of rows) {
		let routes = index.get(row.stop_id);
		if (!routes) {
			routes = new Set();
			index.set(row.stop_id, routes);
		}

		routes.add(row.route_id);
	}

	return index;
});

/**
 * The per-feed stop index: every row by id, the top-level subset, and the
 * routes serving each stop.
 */
export const stopIndex = memoize(
	async (agency: AgencyId): Promise<FeedStops> => {
		const [rows, served] = await Promise.all([
			loadTable(agency, "stops"),
			routesByStop(agency),
		]);

		const byId = new Map<string, Stops>();
		const topLevel: Stops[] = [];
		const routes = new Map<string, Set<string>>();

		for (const row of rows) {
			byId.set(row.stop_id, row);
			if (!row.parent_station) topLevel.push(row);
		}

		// Subway stop_times only reference platforms (127N/127S), so a station's
		// routes come from its children.
		for (const [stopId, routeIds] of served) {
			assign(routes, stopId, routeIds);
			const parentId = byId.get(stopId)?.parent_station;
			if (parentId) assign(routes, parentId, routeIds);
		}

		return { byId, topLevel, routes };
	}
);

function assign(
	index: Map<string, Set<string>>,
	stopId: string,
	routeIds: Set<string>
): void {
	let routes = index.get(stopId);
	if (!routes) {
		routes = new Set();
		index.set(stopId, routes);
	}

	for (const routeId of routeIds) routes.add(routeId);
}

type ResolvedStop = { agency: AgencyId; index: FeedStops; row: Stops };

/**
 * Stop ids are feed-scoped and 977 of them repeat between subway and LIRR
 * ("127", "101", …), and the spec's `GET /v1/stops/:id` has no `agency` param.
 * An explicit feed narrows the search to it; otherwise feeds are searched in
 * `AGENCY_IDS` order and the first hit wins: subway first, matching the spec's
 * `stop=127` subway example.
 *
 * Sequential rather than Promise.all: a common id (subway) then loads one stop
 * index instead of cold-loading all eight on the first request of a boot.
 */
export async function resolveStop(
	id: string,
	agency?: AgencyId
): Promise<ResolvedStop | undefined> {
	const feeds = agency ? [agency] : AGENCY_IDS;

	for (const feed of feeds) {
		// Sequential on purpose: loading only up to the first match is the whole
		// point of not using Promise.all here, so the awaits are the feature.
		// eslint-disable-next-line no-await-in-loop
		const index = await stopIndex(feed);
		const row = index.byId.get(id);
		if (row) return { agency: feed, index, row };
	}

	return undefined;
}

/**
 * Label for a stop id a real-time feed mentions: platforms resolve to their
 * station (the spec's `nextStopId: "125"` / `nextStop: "72 St"`), and the
 * station's coordinates stand in for a vehicle that reports no position.
 */
export async function getStopRef(
	agency: AgencyId,
	stopId: string
): Promise<StopRef | undefined> {
	const index = await stopIndex(agency);
	const row = index.byId.get(stopId);
	if (!row) return undefined;

	const parent = row.parent_station
		? index.byId.get(row.parent_station)
		: undefined;
	const target = parent ?? row;
	const lat = Number(target.stop_lat);
	const lon = Number(target.stop_lon);

	return {
		id: target.stop_id,
		name: target.stop_name,
		location:
			Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : undefined,
	};
}

/** Platform ids below a station; `stop_times` only ever reference those. */
export function childIds(index: FeedStops, parentId: string): string[] {
	const ids: string[] = [];
	for (const stop of index.byId.values()) {
		if (stop.parent_station === parentId) ids.push(stop.stop_id);
	}

	return ids;
}

/**
 * `shape_id` → "northbound" / "southbound" / "eastbound" / "westbound", from
 * comparing the shape's first and last point. `trips.direction_id` means
 * nothing portable across feeds (subway, LIRR and bus number it differently);
 * the geometry is the same fact for all of them.
 */
export const directionIndex = memoize(async (agency: AgencyId) => {
	const shapesUrl = getStaticFeedUrl(agency, "shapes");
	const rows = await runQuery<ShapeEnds>(
		`SELECT shape_id,
			arg_min(CAST(shape_pt_lon AS DOUBLE), CAST(shape_pt_sequence AS INTEGER)) AS lon0,
			arg_min(CAST(shape_pt_lat AS DOUBLE), CAST(shape_pt_sequence AS INTEGER)) AS lat0,
			arg_max(CAST(shape_pt_lon AS DOUBLE), CAST(shape_pt_sequence AS INTEGER)) AS lon1,
			arg_max(CAST(shape_pt_lat AS DOUBLE), CAST(shape_pt_sequence AS INTEGER)) AS lat1
		 FROM read_parquet('${shapesUrl}')
		 GROUP BY shape_id`
	);

	const index = new Map<string, string>();
	for (const shape of rows) index.set(shape.shape_id, directionOf(shape));

	return index;
});

type ShapeEnds = {
	shape_id: string;
	lon0: number;
	lat0: number;
	lon1: number;
	lat1: number;
};

function directionOf(shape: ShapeEnds): string {
	const lat = shape.lat1 - shape.lat0;
	const lon = shape.lon1 - shape.lon0;

	if (Math.abs(lat) >= Math.abs(lon)) {
		return lat >= 0 ? "northbound" : "southbound";
	}

	return lon >= 0 ? "eastbound" : "westbound";
}

/**
 * Top-level stops of a feed (stations, plus standalone stops) that have
 * usable coordinates, for proximity matching. Reads the stops table straight,
 * skipping the heavier join-backed index the other endpoints need.
 */
export async function getStations(agency: AgencyId): Promise<Station[]> {
	const rows = await loadTable(agency, "stops");

	return rows.flatMap((row) => {
		if (row.parent_station) return [];

		const lat = Number(row.stop_lat);
		const lon = Number(row.stop_lon);

		return Number.isFinite(lat) && Number.isFinite(lon)
			? [{ id: row.stop_id, location: { lat, lon } }]
			: [];
	});
}

/** The station's own id plus its platforms; stop_times reference platforms. */
export async function stopIdsOf(
	agency: AgencyId,
	stationId: string
): Promise<string[]> {
	const index = await stopIndex(agency);

	return [stationId, ...childIds(index, stationId)];
}

/**
 * Station-level transfer edges from transfers.txt, keyed by each FROM
 * station's top-level id (platform rows resolve to their parents). Only the
 * subway and LIRR ship this file; bus feeds have no such table at all.
 */
export const transferIndex = memoize(async (agency: AgencyId) => {
	const index: TransferIndex = new Map();
	if (agency !== "subway" && agency !== "lirr") return index;

	const [rows, stops] = await Promise.all([
		loadTable(agency, "transfers"),
		stopIndex(agency),
	]);

	for (const row of rows) {
		const fromRow = stops.byId.get(row.from_stop_id);
		const toRow = stops.byId.get(row.to_stop_id);
		if (!fromRow || !toRow) continue;

		// GTFS uses "" or NULL for top-level stops' parent_station; both mean
		// the row itself, so a plain `??` wouldn't be right.
		const fromParent =
			fromRow.parent_station === "" || fromRow.parent_station === undefined
				? fromRow.stop_id
				: fromRow.parent_station;
		const toParent =
			toRow.parent_station === "" || toRow.parent_station === undefined
				? toRow.stop_id
				: toRow.parent_station;
		if (fromParent === toParent) continue;

		const seconds = Number(row.min_transfer_time) || 60;
		const edges = index.get(fromParent) ?? new Map<string, number>();
		const known = edges.get(toParent);
		if (known === undefined || seconds < known) edges.set(toParent, seconds);
		index.set(fromParent, edges);
	}

	return index;
});
