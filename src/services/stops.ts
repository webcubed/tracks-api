import type { AgencyId } from "@/constants";
import type { Stops } from "@/types/static";
import { AGENCY_IDS, getStaticFeedUrl } from "@/constants";
import { loadTable } from "@/lib/loadTable";
import { memoize } from "@/lib/memoize";
import { runQuery } from "@/lib/parquet";

export type ApiStop = {
	id: string;
	name: string;
	location: { lat: number; lng: number };
	geometry: { type: "Point"; coordinates: [number, number] };
	agency: string;
	routes: string[];
	/** Only set when the feed says so — LIRR is the only one that ships it. */
	wheelchairAccessible?: boolean;
};

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

const stopIndex = memoize(async (agency: AgencyId): Promise<FeedStops> => {
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
});

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

function toApi(
	agency: AgencyId,
	row: Stops,
	routes: Set<string> | undefined
): ApiStop {
	const lat = Number(row.stop_lat);
	const lng = Number(row.stop_lon);

	const stop: ApiStop = {
		id: row.stop_id,
		name: row.stop_name,
		location: { lat, lng },
		geometry: { type: "Point", coordinates: [lng, lat] },
		agency,
		routes: [...(routes ?? [])].toSorted((a, b) =>
			a.localeCompare(b, undefined, { numeric: true })
		),
	};

	// GTFS: "1" accessible, "2" not accessible, "0"/absent = no information.
	if (row.wheelchair_boarding === "1") stop.wheelchairAccessible = true;
	else if (row.wheelchair_boarding === "2") stop.wheelchairAccessible = false;

	return stop;
}

export async function getStops(
	agency?: AgencyId,
	route?: string
): Promise<ApiStop[]> {
	const feeds = agency ? [agency] : AGENCY_IDS;
	const indexes = await Promise.all(feeds.map(async (feed) => stopIndex(feed)));
	const stops: ApiStop[] = [];

	for (const [i, id] of feeds.entries()) {
		const index = indexes[i];
		for (const row of index.topLevel) {
			if (route && !index.routes.get(row.stop_id)?.has(route)) continue;

			stops.push(toApi(id, row, index.routes.get(row.stop_id)));
		}
	}

	return stops;
}

/**
 * Stop ids are feed-scoped and 977 of them repeat between subway and LIRR
 * ("127", "101", …). The spec's `GET /v1/stops/:id` has no `agency` param, so
 * feeds are searched in `AGENCY_IDS` order and the first hit wins — subway
 * first, matching the spec's `stop=127` subway example.
 */
export async function getStop(id: string): Promise<ApiStop | undefined> {
	const indexes = await Promise.all(
		AGENCY_IDS.map(async (feed) => stopIndex(feed))
	);

	for (const [i, feed] of AGENCY_IDS.entries()) {
		const row = indexes[i].byId.get(id);
		if (row) return toApi(feed, row, indexes[i].routes.get(id));
	}

	return undefined;
}
