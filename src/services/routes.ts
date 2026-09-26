import type { AgencyId } from "@/constants";
import type { Routes } from "@/types/static";
import { AGENCIES } from "@/constants";
import { loadTable } from "@/lib/loadTable";
import { memoize } from "@/lib/memoize";

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

function toApi(agency: AgencyId, row: Routes): ApiRoute {
	return {
		id: row.route_id,
		agency,
		shortName: row.route_short_name ?? "",
		longName: row.route_long_name,
		type: AGENCIES[agency].mode,
		color: hex(row.route_color),
		textColor: hex(row.route_text_color),
	};
}

function hex(color: string): string {
	return color ? `#${color}` : "";
}

const routeIndex = memoize(async (agency: AgencyId) => {
	const rows = await loadTable(agency, "routes");
	const index = new Map<string, ApiRoute>();

	for (const row of rows) {
		index.set(row.route_id, toApi(agency, row));
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
