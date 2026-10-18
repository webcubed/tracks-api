import type { AgencyId } from "@/constants";
import type { Routes } from "@/types/static";
import { AGENCIES, getStaticFeedUrl } from "@/constants";
import { loadTable } from "@/lib/loadTable";
import { memoize } from "@/lib/memoize";
import { runQuery } from "@/lib/parquet";

/**
 * How much of a route's widest extent a shape may be missing and still count
 * as a full-length variant, in bounding-box degrees (~5.5 km). Comfortably
 * wider than the ~1.8 km Penn/Grand Central gap and far narrower than a
 * short-turn, which is typically tens of kilometres short.
 */
const SPAN_SLACK = 0.05;

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

/** GeoJSON: coordinates are `[lon, lat]`. */
export type GeoJsonLineString = {
	type: "LineString";
	coordinates: Array<[number, number]>;
};

// DuckDB returns SQL NULL for routes with no geometry; `typeof` guards below.
type TripRow = { route_id: string; lon?: number; lat?: number };

type TripIndex = {
	/** Routes this feed actually runs. */
	routes: Set<string>;
	/** `route_id` → fullest polyline the route runs. */
	shapes: Map<string, Array<[number, number]>>;
};

/**
 * Per feed: which routes have trips, plus one representative polyline each
 * (routes run several variants — local/express, different terminals — and the
 * spec shows a single LineString per route).
 *
 * Extent matters, because the most-*used* variant is often a short-turn that
 * truncates the route: the LIRR Montauk Branch runs 169 Babylon→Patchogue
 * short-turns against two full Penn→Montauk runs, so a pure trip-count pick
 * stops drawing a third of the way down the island.
 *
 * Extent alone is not enough either, and that is what `SPAN_SLACK` fixes.
 * Grand Central Madison sits ~1.8 km east of Penn Station, so every New York
 * terminal variant reaches ~1.8 km less far west and loses a raw "widest
 * shape" comparison — even on branches where Grand Central carries almost all
 * of the service (Oyster Bay 50 GCT trips to 3 Penn, Montauk 163 to 6, the
 * City Terminal Zone 253 to 4). Slack that terminal gap out of the ranking and
 * let trip count decide the rest, so the drawn line follows the terminal the
 * trains actually use while still covering the whole route.
 *
 * Routes are taken from `trips`, not from `routes.txt`: the five borough bus
 * feeds all ship the same 307-route table, of which each runs only its own
 * subset.
 */
const tripIndex = memoize(async (agency: AgencyId) => {
	const shapesUrl = getStaticFeedUrl(agency, "shapes");
	const tripsUrl = getStaticFeedUrl(agency, "trips");

	// Every parquet column is VARCHAR (convert.ts reads with all_varchar), so
	// coordinates and sequence both have to be cast before they sort. Span is
	// the bounding-box width plus height: cheap, and a faithful stand-in for
	// length on these overwhelmingly linear shapes. The LEFT JOINs keep routes
	// that have trips but no usable shape, and ties fall back to the
	// most-run variant and then the densest shape.
	const rows = await runQuery<TripRow>(
		`WITH shape_stats AS (
			SELECT shape_id,
				count(*) AS points,
				(max(CAST(shape_pt_lon AS DOUBLE)) - min(CAST(shape_pt_lon AS DOUBLE)))
					+ (max(CAST(shape_pt_lat AS DOUBLE)) - min(CAST(shape_pt_lat AS DOUBLE))) AS span
			FROM read_parquet('${shapesUrl}')
			GROUP BY shape_id
		),
		route_shapes AS (
			SELECT route_id, shape_id, count(*) AS trips
			FROM read_parquet('${tripsUrl}')
			GROUP BY route_id, shape_id
		),
		-- Shapes within SPAN_SLACK of the route's widest are "full length" as far
		-- as this pick is concerned; among them the busiest variant wins, which
		-- is what makes the drawn line follow the terminal and the pattern the
		-- service actually runs. A route whose shapes all lack geometry still
		-- qualifies, so it keeps its place in the index without a line.
		candidates AS (
			SELECT rs.route_id, rs.shape_id, rs.trips, ss.span, ss.points,
				max(ss.span) OVER (PARTITION BY rs.route_id) AS widest
			FROM route_shapes rs
			LEFT JOIN shape_stats ss ON ss.shape_id = rs.shape_id
		),
		representative AS (
			SELECT route_id, shape_id
			FROM (
				SELECT route_id, shape_id,
					row_number() OVER (
						PARTITION BY route_id
						ORDER BY trips DESC, span DESC NULLS LAST, points DESC, shape_id
					) AS rank
				FROM candidates
				WHERE span IS NULL OR span >= widest - ${SPAN_SLACK}
			)
			WHERE rank = 1
		)
		SELECT t.route_id, CAST(s.shape_pt_lon AS DOUBLE) AS lon, CAST(s.shape_pt_lat AS DOUBLE) AS lat
		FROM representative t
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
