import type { AgencyId } from "@/constants";
import type { Routes } from "@/types/static";
import { AGENCIES, getStaticFeedUrl } from "@/constants";
import { loadTable } from "@/lib/loadTable";
import { memoize } from "@/lib/memoize";
import { runQuery } from "@/lib/parquet";

export type ApiRoute = {
	id: string;
	agency: string;
	shortName: string;
	longName: string;
	type: string;
	color: string;
	textColor: string;
	shape?: GeoJsonLineString;
};

/** GeoJSON: coordinates are `[lng, lat]`. */
export type GeoJsonLineString = {
	type: "LineString";
	coordinates: Array<[number, number]>;
};

// DuckDB returns SQL NULL for routes with no geometry; `typeof` guards below.
type TripRow = { route_id: string; lon?: number; lat?: number };

type TripIndex = {
	/** Routes this feed actually runs. */
	routes: Set<string>;
	/** `route_id` → representative polyline. */
	shapes: Map<string, Array<[number, number]>>;
};

/**
 * Per feed: which routes have trips, plus one representative polyline each —
 * the most-used `shape_id` (routes run several variants: local/express,
 * different terminals, and the spec shows a single LineString per route).
 *
 * Routes are taken from `trips`, not from `routes.txt`: the five borough bus
 * feeds all ship the same 307-route table, of which each runs only its own
 * subset.
 */
const tripIndex = memoize(async (agency: AgencyId) => {
	const shapesUrl = getStaticFeedUrl(agency, "shapes");
	const tripsUrl = getStaticFeedUrl(agency, "trips");

	// Every parquet column is VARCHAR (convert.ts reads with all_varchar), so
	// coordinates and sequence both have to be cast before they sort. The LEFT
	// JOIN keeps routes that have trips but no usable shape.
	const rows = await runQuery<TripRow>(
		`SELECT t.route_id, CAST(s.shape_pt_lon AS DOUBLE) AS lon, CAST(s.shape_pt_lat AS DOUBLE) AS lat
		 FROM (
			SELECT route_id, mode(shape_id) AS shape_id
			FROM read_parquet('${tripsUrl}')
			GROUP BY route_id
		 ) t
		 LEFT JOIN read_parquet('${shapesUrl}') s ON s.shape_id = t.shape_id
		 ORDER BY t.route_id, CAST(s.shape_pt_sequence AS INTEGER)`
	);

	const routes = new Set<string>();
	const shapes = new Map<string, Array<[number, number]>>();

	for (const row of rows) {
		routes.add(row.route_id);

		if (typeof row.lon !== "number" || typeof row.lat !== "number") continue;

		let points = shapes.get(row.route_id);
		if (!points) {
			points = [];
			shapes.set(row.route_id, points);
		}

		points.push([row.lon, row.lat]);
	}

	return { routes, shapes };
});

function toApi(
	agency: AgencyId,
	row: Routes,
	points?: Array<[number, number]>
): ApiRoute {
	return {
		id: row.route_id,
		agency,
		shortName: row.route_short_name ?? "",
		longName: row.route_long_name,
		type: AGENCIES[agency].mode,
		color: hex(row.route_color),
		textColor: hex(row.route_text_color),
		shape: points ? { type: "LineString", coordinates: points } : undefined,
	};
}

function hex(color: string): string {
	return color ? `#${color}` : "";
}

const routeIndex = memoize(async (agency: AgencyId) => {
	const [rows, trips] = await Promise.all([
		loadTable(agency, "routes"),
		tripIndex(agency),
	]);
	const index = new Map<string, ApiRoute>();

	for (const row of rows) {
		if (!trips.routes.has(row.route_id)) continue;

		index.set(row.route_id, toApi(agency, row, trips.shapes.get(row.route_id)));
	}

	return index;
});

export async function getRoutes(agency: AgencyId): Promise<ApiRoute[]> {
	const index = await routeIndex(agency);
	return [...index.values()];
}

export async function getRoute(
	agency: AgencyId,
	id: string
): Promise<ApiRoute | undefined> {
	const index = await routeIndex(agency);
	return index.get(id);
}
