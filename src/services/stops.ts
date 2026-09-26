import type { AgencyId } from "@/constants";
import type { Stops } from "@/types/static";
import { AGENCY_IDS, CALENDAR_FREE_FEEDS, getStaticFeedUrl } from "@/constants";
import { distanceMeters } from "@/lib/geo";
import { loadTable } from "@/lib/loadTable";
import { memoize } from "@/lib/memoize";
import { runQuery } from "@/lib/parquet";

export type ApiStop = {
	id: string;
	name: string;
	location: { lat: number; lon: number };
	geometry: { type: "Point"; coordinates: [number, number] };
	agency: string;
	routes: string[];
	/** Metres from the query point; set only by `?lat=&lon=&radius=`. */
	distance?: number;
	/** Only set when the feed says so; LIRR is the only one that ships it. */
	wheelchairAccessible?: boolean;
};

export type Proximity = { lat: number; lon: number; radius: number };

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
	const lon = Number(row.stop_lon);

	const stop: ApiStop = {
		id: row.stop_id,
		name: row.stop_name,
		location: { lat, lon },
		geometry: { type: "Point", coordinates: [lon, lat] },
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
	route?: string,
	near?: Proximity
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

	if (!near) return stops;

	return stops
		.map((stop) => ({ stop, distance: distanceMeters(near, stop.location) }))
		.filter((entry) => entry.distance <= near.radius)
		.toSorted((a, b) => a.distance - b.distance)
		.map((entry) => ({ ...entry.stop, distance: Math.round(entry.distance) }));
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
async function resolveStop(
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

/** With `feed`, resolve the id from that feed alone (an LIRR Penn shadowed by
 * a colliding subway id becomes reachable). */
export async function getStop(
	id: string,
	feed?: AgencyId
): Promise<ApiStop | undefined> {
	const resolved = await resolveStop(id, feed);
	if (!resolved) return undefined;

	return toApi(resolved.agency, resolved.row, resolved.index.routes.get(id));
}

export type ResolvedStopIds = {
	agency: AgencyId;
	stop: ApiStop;
	ids: string[];
};

/**
 * What `/v1/arrivals` needs from a stop: its response object, and every id a
 * feed may reference it by (GTFS-RT names platforms, like `127N` and `127S`).
 */
export async function resolveStopIds(
	id: string,
	feed?: AgencyId
): Promise<ResolvedStopIds | undefined> {
	const resolved = await resolveStop(id, feed);
	if (!resolved) return undefined;

	const { agency, index, row } = resolved;

	return {
		agency,
		stop: toApi(agency, row, index.routes.get(row.stop_id)),
		ids: [row.stop_id, ...childIds(index, row.stop_id)],
	};
}

export type StopRef = {
	id: string;
	name: string;
	location?: { lat: number; lon: number };
};

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

function directionOf(shape: ShapeEnds): string {
	const lat = shape.lat1 - shape.lat0;
	const lon = shape.lon1 - shape.lon0;

	if (Math.abs(lat) >= Math.abs(lon)) {
		return lat >= 0 ? "northbound" : "southbound";
	}

	return lon >= 0 ? "eastbound" : "westbound";
}

/** Platform ids below a station; `stop_times` only ever reference those. */
function childIds(index: FeedStops, parentId: string): string[] {
	const ids: string[] = [];
	for (const stop of index.byId.values()) {
		if (stop.parent_station === parentId) ids.push(stop.stop_id);
	}

	return ids;
}

/** Today in the service's own timezone, not the server's. */
export function today(): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: "America/New_York",
	}).format(new Date());
}

/**
 * Strict `YYYY-MM-DD`: parse it, then check the round trip. Rejects
 * `2026-2-3`, `garbage` and impossible dates like `2026-02-31` (which parse
 * as March 3rd), and needs no regex flags: `tsconfig` targets ES2017, which
 * can't compile the `v` flag xo asks for.
 */
export function isValidDate(value: string): boolean {
	const date = new Date(`${value}T00:00:00Z`);

	if (Number.isNaN(date.getTime())) return false;

	return date.toISOString().slice(0, 10) === value;
}

export type Station = { id: string; location: { lat: number; lon: number } };

/**
 * Top-level stops of a feed (stations, plus standalone stops) that have
 * usable coordinates, for proximity matching.
 */
export async function getStations(agency: AgencyId): Promise<Station[]> {
	const index = await stopIndex(agency);

	return index.topLevel.flatMap((row) => {
		const lat = Number(row.stop_lat);
		const lon = Number(row.stop_lon);

		return Number.isFinite(lat) && Number.isFinite(lon)
			? [{ id: row.stop_id, location: { lat, lon } }]
			: [];
	});
}

/**
 * `service_id`s running on `date`: the calendar weekday row, plus
 * `calendar_dates` additions, minus its removals. LIRR ships no
 * `calendar.txt`; naming it would 404, so its weekday half is skipped.
 */
export function activeServices(
	agency: AgencyId,
	date: string
): { sql: string; parameters: string[] } {
	const gfsDate = date.replaceAll("-", "");
	const weekday = WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
	const hasCalendar = !Object.hasOwn(CALENDAR_FREE_FEEDS, agency);
	const datesUrl = getStaticFeedUrl(agency, "calendar_dates");
	const additions = `SELECT service_id FROM read_parquet('${datesUrl}')
		 WHERE ? = date AND exception_type = '1'`;
	const removals = `SELECT service_id FROM read_parquet('${datesUrl}')
		 WHERE ? = date AND exception_type = '2'`;
	const weekly = hasCalendar
		? `SELECT service_id FROM read_parquet('${getStaticFeedUrl(agency, "calendar")}')
		 WHERE ? BETWEEN start_date AND end_date AND ${weekday} = '1'`
		: undefined;
	const sql = weekly
		? `((${additions}) UNION (${weekly})) EXCEPT (${removals})`
		: `(${additions}) EXCEPT (${removals})`;
	const parameters = weekly ? [gfsDate, gfsDate, gfsDate] : [gfsDate, gfsDate];

	return { sql, parameters };
}

/**
 * Departures from a stop on `date` (YYYY-MM-DD), ordered by departure time.
 */
export async function getSchedule(
	id: string,
	date: string,
	feed?: AgencyId
): Promise<ApiSchedule | undefined> {
	const resolved = await resolveStop(id, feed);
	if (!resolved) return undefined;

	const { agency, index, row } = resolved;
	const stopIds = [id, ...childIds(index, id)];
	const service = activeServices(agency, date);

	const [departures, directions] = await Promise.all([
		runQuery<DepartureRow>(
			`SELECT t.trip_id, t.route_id, t.trip_headsign, t.shape_id, st.departure_time
			 FROM read_parquet('${getStaticFeedUrl(agency, "stop_times")}') st
			 JOIN read_parquet('${getStaticFeedUrl(agency, "trips")}') t ON t.trip_id = st.trip_id
			 WHERE st.stop_id IN (${stopIds.map(() => "?").join(", ")})
			   AND st.departure_time <> ''
			   AND t.service_id IN (${service.sql})
			 ORDER BY st.departure_time`,
			...stopIds,
			...service.parameters
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
