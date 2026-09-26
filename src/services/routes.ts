import type { Routes } from "@/types/static";
import { loadTable } from "@/lib/loadTable";

export type ApiRoute = {
	id: string;
	agency: string;
	shortName: string;
	longName: string;
	type: string;
	color: string;
	textColor: string;
	// honey: needs the routes -> trips -> shapes join; not derivable from the routes table alone.
	shape?: {
		type: string;
		points: Array<{ lat: number; lon: number }>;
	};
};

function toApi(agency: string, row: Routes): ApiRoute {
	return {
		id: `${agency}:${row.route_id}`,
		agency,
		shortName: row.route_short_name ?? "",
		longName: row.route_long_name,
		type: String(row.route_type),
		color: row.route_color,
		textColor: row.route_text_color,
	};
}

let index: Map<string, ApiRoute>;

async function byId(): Promise<Map<string, ApiRoute>> {
	if (!index) {
		const rows = await loadTable("routes");
		index = new Map(
			rows.map((row) => {
				const route = toApi(row.agency_id, row);
				return [route.id, route];
			})
		);
	}

	return index;
}

export async function getRoutes(): Promise<ApiRoute[]> {
	const routes = await byId();
	return [...routes.values()];
}

export async function getRoute(id: string): Promise<ApiRoute | undefined> {
	const routes = await byId();
	return routes.get(id);
}
