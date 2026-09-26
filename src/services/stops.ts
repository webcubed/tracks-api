import type { AgencyId } from "@/constants";
import type { Stops } from "@/types/static";
import { AGENCY_IDS, CALENDAR_FREE_FEEDS, getStaticFeedUrl } from "@/constants";
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

type ResolvedStop = { agency: AgencyId; index: FeedStops; row: Stops };

/**
 * Stop ids are feed-scoped and 977 of them repeat between subway and LIRR
 * ("127", "101", …). The spec's `GET /v1/stops/:id` has no `agency` param, so
 * feeds are searched in `AGENCY_IDS` order and the first hit wins — subway
 * first, matching the spec's `stop=127` subway example.
 */
async function resolveStop(id: string): Promise<ResolvedStop | undefined> {
	const indexes = await Promise.all(
		AGENCY_IDS.map(async (feed) => stopIndex(feed))
	);

	for (const [i, feed] of AGENCY_IDS.entries()) {
		const row = indexes[i].byId.get(id);
		if (row) return { agency: feed, index: indexes[i], row };
	}

	return undefined;
}

export async function getStop(id: string): Promise<ApiStop | undefined> {
	const resolved = await resolveStop(id);
	if (!resolved) return undefined;

	return toApi(resolved.agency, resolved.row, resolved.index.routes.get(id));
}

export type Departure = {
	route: string;
	headsign: string;
	departureTime: string;
	tripId: string;
	/** Travel direction of the trip, derived from its shape's endpoints. */
	direction: string;
};

export type ApiSchedule = {
	stop: { id: string; name: string };
	departures: Departure[];
};

type DepartureRow = {
	route_id: string;
	trip_headsign?: string;
	trip_id: string;
	shape_id?: string;
	departure_time: string;
};

type ShapeEnds = {
	shape_id: string;
	lon0: number;
	lat0: number;
	lon1: number;
	lat1: number;
};

const WEEKDAYS = [
	"sunday",
	"monday",
	"tuesday",
	"wednesday",
	"thursday",
	"friday",
	"saturday",
];

/**
 * `shape_id` → "northbound" / "southbound" / "eastbound" / "westbound", from
 * comparing the shape's first and last point. `trips.direction_id` means
 * nothing portable across feeds (subway, LIRR and bus number it differently);
 * the geometry is the same fact for all of them.
 */
const directionIndex = memoize(async (agency: AgencyId) => {
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

function directionOf(shape: ShapeEnds): string {
	const lat = shape.lat1 - shape.lat0;
	const lon = shape.lon1 - shape.lon0;

	if (Math.abs(lat) >= Math.abs(lon)) {
		return lat >= 0 ? "northbound" : "southbound";
	}

	return lon >= 0 ? "eastbound" : "westbound";
}

/** Platform ids below a station — `stop_times` only ever reference those. */
function childIds(index: FeedStops, parentId: string): string[] {
	const ids: string[] = [];
	for (const stop of index.byId.values()) {
		if (stop.parent_station === parentId) ids.push(stop.stop_id);
	}

	return ids;
}

/**
 * Departures from a stop on `date` (YYYY-MM-DD), ordered by departure time.
 * A service runs if its calendar covers that weekday, plus its
 * `calendar_dates` additions, minus its removals.
 */
export async function getSchedule(
	id: string,
	date: string
): Promise<ApiSchedule | undefined> {
	const resolved = await resolveStop(id);
	if (!resolved) return undefined;

	const { agency, index, row } = resolved;
	const stopIds = [id, ...childIds(index, id)];
	const gfsDate = date.replaceAll("-", "");
	const weekday = WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
	const hasCalendar = !Object.hasOwn(CALENDAR_FREE_FEEDS, agency);

	const datesUrl = getStaticFeedUrl(agency, "calendar_dates");
	const additions = `SELECT service_id FROM read_parquet('${datesUrl}')
		 WHERE ? = date AND exception_type = '1'`;
	const removals = `SELECT service_id FROM read_parquet('${datesUrl}')
		 WHERE ? = date AND exception_type = '2'`;
	// LIRR ships no calendar.txt, so naming it would 404 — calendar_dates only.
	const weekly = hasCalendar
		? `SELECT service_id FROM read_parquet('${getStaticFeedUrl(agency, "calendar")}')
		 WHERE ? BETWEEN start_date AND end_date AND ${weekday} = '1'`
		: undefined;
	const serviceSql = weekly
		? `((${additions}) UNION (${weekly})) EXCEPT (${removals})`
		: `(${additions}) EXCEPT (${removals})`;
	const serviceParameters = weekly
		? [gfsDate, gfsDate, gfsDate]
		: [gfsDate, gfsDate];

	const [departures, directions] = await Promise.all([
		runQuery<DepartureRow>(
			`SELECT t.trip_id, t.route_id, t.trip_headsign, t.shape_id, st.departure_time
			 FROM read_parquet('${getStaticFeedUrl(agency, "stop_times")}') st
			 JOIN read_parquet('${getStaticFeedUrl(agency, "trips")}') t ON t.trip_id = st.trip_id
			 WHERE st.stop_id IN (${stopIds.map(() => "?").join(", ")})
			   AND st.departure_time <> ''
			   AND t.service_id IN (${serviceSql})
			 ORDER BY st.departure_time`,
			...stopIds,
			...serviceParameters
		),
		directionIndex(agency),
	]);

	return {
		stop: { id: row.stop_id, name: row.stop_name },
		departures: departures.map((departure) => ({
			route: departure.route_id,
			headsign: departure.trip_headsign ?? "",
			departureTime: departure.departure_time,
			tripId: departure.trip_id,
			direction: directions.get(departure.shape_id ?? "") ?? "",
		})),
	};
}
