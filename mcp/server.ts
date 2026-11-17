import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/**
 * Local stdio MCP server for tracks-api.
 *
 * It holds no data and does no transit work: every tool is one HTTP call to the
 * deployed API. That keeps it out of the API's memory budget and means an MCP
 * session costs one small Node process on the machine running the agent.
 *
 * Output is trimmed for a model's context: route shapes and stop point geometry
 * are dropped unless a tool explicitly asks for them, and every list is capped.
 */

const DEFAULT_API_URL = "https://tracks-api-ol28.onrender.com";
const API_URL = trimTrailingSlashes(
	process.env.TRACKS_API_URL ?? DEFAULT_API_URL
);

function trimTrailingSlashes(value: string): string {
	let end = value.length;
	while (end > 0 && value[end - 1] === "/") end -= 1;
	return value.slice(0, end);
}

type ApiEnvelope<T> = {
	data?: T;
	error?: { code?: string; message?: string };
};

class TracksApiError extends Error {
	constructor(
		readonly code: string,
		message: string
	) {
		super(message);
		this.name = "TracksApiError";
	}
}

async function apiGet<T>(
	path: string,
	query: Record<string, string | number | boolean | undefined> = {}
): Promise<T> {
	const url = new URL(`${API_URL}${path}`);
	for (const [key, value] of Object.entries(query)) {
		if (value !== undefined && value !== "") {
			url.searchParams.set(key, String(value));
		}
	}

	const response = await fetch(url, {
		// Render's free tier wakes from idle in tens of seconds.
		signal: AbortSignal.timeout(45_000),
		headers: { accept: "application/json" },
	});

	let body: ApiEnvelope<T>;
	try {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		body = (await response.json()) as ApiEnvelope<T>;
	} catch {
		throw new TracksApiError(
			"INVALID_RESPONSE",
			`${url.pathname} returned no JSON (HTTP ${response.status})`
		);
	}

	if (!response.ok || body.error) {
		throw new TracksApiError(
			body.error?.code ?? `HTTP_${response.status}`,
			body.error?.message ?? `tracks-api returned HTTP ${response.status}`
		);
	}

	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return body.data as T;
}

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
};

function json(value: unknown): ToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify(value) }],
	};
}

function fail(message: string): ToolResult {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
	};
}

async function attempt(action: () => Promise<ToolResult>): Promise<ToolResult> {
	try {
		return await action();
	} catch (error) {
		if (error instanceof TracksApiError) {
			return fail(`${error.code}: ${error.message}`);
		}

		return fail(error instanceof Error ? error.message : String(error));
	}
}

const agency = z
	.enum([
		"subway",
		"lirr",
		"bus_bx",
		"bus_b",
		"bus_busco",
		"bus_m",
		"bus_si",
		"bus_q",
	])
	.optional()
	.describe(
		"Feed id. Needed to pin a stop id that repeats across feeds, such as 237 at LIRR Penn Station."
	);

type Stop = {
	id: string;
	name: string;
	location: { lat: number; lon: number };
	geometry?: unknown;
	agency: string;
	routes: string[];
	distance?: number;
	wheelchairAccessible?: boolean;
};

type Route = {
	id: string;
	agency: string;
	shortName: string;
	longName: string;
	type: string;
	color: string;
	textColor: string;
	shape?: unknown;
	branches?: unknown[];
};

type Vehicle = {
	id: string;
	label?: string;
	route: string;
	location?: { lat: number; lon: number };
	geometry?: unknown;
	bearing?: number;
	speed?: number;
	nextStop?: string;
	nextStopId?: string;
	occupancy?: string;
};

type Departure = {
	route: string;
	headsign: string;
	departureTime: string;
	tripId: string;
	direction: string;
};

type Alert = {
	id: string;
	agency: string;
	routes: string[];
	severity: string;
	effect: string;
	header: string;
	description?: string;
	activePeriod?: { start?: string; end?: string };
};

function trimStop(stop: Stop): Omit<Stop, "geometry"> {
	const { geometry, ...rest } = stop;
	return rest;
}

function trimRoute(route: Route, includeShape: boolean): Omit<Route, "shape"> {
	if (includeShape) return route;

	const { shape, branches, ...rest } = route;
	return rest;
}

function trimVehicle(vehicle: Vehicle): Omit<Vehicle, "geometry"> {
	const { geometry, ...rest } = vehicle;
	return rest;
}

const nowFormatter = new Intl.DateTimeFormat("en-CA", {
	timeZone: "America/New_York",
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hourCycle: "h23",
});

/** The timetable's own timezone, for trimming today's departures. */
function newYorkNow(): { date: string; clock: string } {
	const parts = nowFormatter.formatToParts(new Date());
	const value = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((part) => part.type === type)?.value ?? "00";

	return {
		date: `${value("year")}-${value("month")}-${value("day")}`,
		clock: `${value("hour")}:${value("minute")}:${value("second")}`,
	};
}

function capped<T>(
	items: T[],
	limit: number
): { count: number; returned: number; items: T[] } {
	return {
		count: items.length,
		returned: Math.min(items.length, limit),
		items: items.slice(0, limit),
	};
}

const server = new McpServer(
	{ name: "tracks", version: "1.0.0" },
	{
		instructions:
			"Live New York City transit data: subway, LIRR, and MTA buses. " +
			"Resolve stop ids with find_stops before calling get_arrivals or plan_journey. " +
			"Pass agency when an id may repeat across feeds. " +
			"Route shapes are large GeoJSON and stay out of responses unless includeShape is true. " +
			"plan_journey uses the static timetable; arrivals, vehicles, alerts, and departures are live.",
	}
);

server.registerTool(
	"list_agencies",
	{
		title: "List transit feeds",
		description:
			"The eight feeds this API serves (subway, LIRR, six borough bus feeds) with names, timezones, and modes.",
		annotations: { readOnlyHint: true, openWorldHint: true },
	},
	async () =>
		attempt(async () => {
			const data =
				await apiGet<
					Array<{ id: string; name: string; timezone: string; modes: string[] }>
				>("/v1/agencies");
			return json(data);
		})
);

server.registerTool(
	"list_routes",
	{
		title: "List routes in a feed",
		description:
			"Route ids, names, mode, and official MTA colours. Geometry is omitted to keep the response small.",
		inputSchema: {
			agency: agency.unwrap(),
			limit: z
				.number()
				.int()
				.min(1)
				.max(400)
				.optional()
				.describe("Maximum routes to return. Defaults to 100."),
		},
		annotations: { readOnlyHint: true, openWorldHint: true },
	},
	async ({ agency: feed, limit }) =>
		attempt(async () => {
			const data = await apiGet<Route[]>("/v1/routes", { agency: feed });
			return json({
				agency: feed,
				...capped(
					data.map((route) => trimRoute(route, false)),
					limit ?? 100
				),
			});
		})
);

server.registerTool(
	"get_route",
	{
		title: "Get one route",
		description:
			"One route's names and colours, plus its GeoJSON alignment when includeShape is true.",
		inputSchema: {
			agency: agency.unwrap(),
			route: z.string().min(1).describe("Route id, such as 1, A, or BX12."),
			includeShape: z
				.boolean()
				.optional()
				.describe(
					"Include the route's GeoJSON shape and any branches. Large; off by default."
				),
		},
		annotations: { readOnlyHint: true, openWorldHint: true },
	},
	async ({ agency: feed, route, includeShape }) =>
		attempt(async () => {
			const data = await apiGet<Route>(
				`/v1/routes/${encodeURIComponent(route)}`,
				{ agency: feed }
			);
			return json(trimRoute(data, includeShape ?? false));
		})
);

server.registerTool(
	"find_stops",
	{
		title: "Find stops",
		description:
			"Stops in a feed, stops served by a route, or stops within a radius of a point. Nearby results include distance in metres and are sorted nearest first.",
		inputSchema: {
			agency,
			route: z.string().optional().describe("Only stops served by this route."),
			lat: z.number().min(-90).max(90).optional().describe("Latitude."),
			lon: z.number().min(-180).max(180).optional().describe("Longitude."),
			radius: z
				.number()
				.positive()
				.optional()
				.describe("Search radius in metres. Requires lat and lon."),
			limit: z
				.number()
				.int()
				.min(1)
				.max(100)
				.optional()
				.describe("Maximum stops to return. Defaults to 25."),
		},
		annotations: { readOnlyHint: true, openWorldHint: true },
	},
	async ({ agency: feed, route, lat, lon, radius, limit }) =>
		attempt(async () => {
			const hasNearby =
				lat !== undefined || lon !== undefined || radius !== undefined;

			if (!hasNearby && feed === undefined && route === undefined) {
				return fail(
					"Pass agency, route, or all of lat, lon and radius. Without one of those, /v1/stops would return every stop on the network."
				);
			}

			const data = await apiGet<Stop[]>("/v1/stops", {
				agency: feed,
				route,
				lat,
				lon,
				radius,
			});

			return json({
				...(hasNearby ? { radius, lat, lon } : {}),
				...capped(
					data.map((stop) => trimStop(stop)),
					limit ?? 25
				),
			});
		})
);

server.registerTool(
	"get_stop",
	{
		title: "Get one stop",
		description:
			"One stop's name, coordinates, feed, and the routes that serve it.",
		inputSchema: {
			stop: z
				.string()
				.min(1)
				.describe("Stop id, such as 127 for Times Sq-42 St."),
			agency,
		},
		annotations: { readOnlyHint: true, openWorldHint: true },
	},
	async ({ stop, agency: feed }) =>
		attempt(async () => {
			const data = await apiGet<Stop>(`/v1/stops/${encodeURIComponent(stop)}`, {
				agency: feed,
			});
			return json(trimStop(data));
		})
);

server.registerTool(
	"get_arrivals",
	{
		title: "Live arrivals",
		description:
			"Live arrivals at a stop from GTFS-Realtime: route, direction, headsign, time, minutes away, delay, occupancy, and vehicle id where the feed reports them.",
		inputSchema: {
			stop: z.string().min(1).describe("Stop id."),
			route: z.string().optional().describe("Only arrivals on this route."),
			agency,
		},
		annotations: { readOnlyHint: true, openWorldHint: true },
	},
	async ({ stop, route, agency: feed }) =>
		attempt(async () => {
			const data = await apiGet<{
				stop: { id: string; name: string };
				arrivals: unknown[];
			}>("/v1/arrivals", { stop, route, agency: feed });
			return json(data);
		})
);

server.registerTool(
	"get_schedule",
	{
		title: "Scheduled departures",
		description:
			"Timetable departures for a stop and service date, with service-day exceptions applied. Today's board starts at the current New York time.",
		inputSchema: {
			stop: z.string().min(1).describe("Stop id."),
			agency,
			date: z
				.string()
				.optional()
				.describe("Service date as YYYY-MM-DD. Defaults to today."),
			limit: z
				.number()
				.int()
				.min(1)
				.max(200)
				.optional()
				.describe("Maximum departures to return. Defaults to 30."),
		},
		annotations: { readOnlyHint: true, openWorldHint: true },
	},
	async ({ stop, agency: feed, date, limit }) =>
		attempt(async () => {
			const data = await apiGet<{
				stop: { id: string; name: string };
				departures: Departure[];
			}>(`/v1/stops/${encodeURIComponent(stop)}/schedule`, {
				agency: feed,
				date,
			});

			const today = newYorkNow();
			const serviceDate = date ?? today.date;
			const upcoming =
				serviceDate === today.date
					? data.departures.filter(
							(departure) => departure.departureTime >= today.clock
						)
					: data.departures;

			return json({
				stop: data.stop,
				date: serviceDate,
				...(upcoming.length === 0 && data.departures.length > 0
					? { note: "No departures left on this service date." }
					: {}),
				...capped(upcoming, limit ?? 30),
			});
		})
);

server.registerTool(
	"get_departures",
	{
		title: "Station departure board",
		description:
			"The LIRR departure board with posted track assignments, train numbers, stops, and on-time or held status. Other feeds return an empty board.",
		inputSchema: {
			stop: z.string().min(1).describe("LIRR stop id, such as 237."),
			agency,
		},
		annotations: { readOnlyHint: true, openWorldHint: true },
	},
	async ({ stop, agency: feed }) =>
		attempt(async () => {
			const data = await apiGet<Record<string, unknown>>(
				`/v1/stops/${encodeURIComponent(stop)}/departures`,
				{ agency: feed }
			);
			return json(data);
		})
);

server.registerTool(
	"get_vehicles",
	{
		title: "Live vehicles on a route",
		description:
			"Live vehicle positions for one route: location, bearing, speed, next stop, and occupancy where reported. LIRR entries also carry the track section and position source.",
		inputSchema: {
			route: z.string().min(1).describe("Route id."),
			agency: agency.describe(
				"Feed id. Needed when route ids repeat across feeds."
			),
			limit: z
				.number()
				.int()
				.min(1)
				.max(200)
				.optional()
				.describe("Maximum vehicles to return. Defaults to 50."),
		},
		annotations: { readOnlyHint: true, openWorldHint: true },
	},
	async ({ route, agency: feed, limit }) =>
		attempt(async () => {
			const data = await apiGet<Vehicle[]>("/v1/vehicles", {
				route,
				agency: feed,
			});
			return json({
				route,
				...(feed ? { agency: feed } : {}),
				...capped(
					data.map((vehicle) => trimVehicle(vehicle)),
					limit ?? 50
				),
			});
		})
);

server.registerTool(
	"search_vehicles",
	{
		title: "Find a live vehicle",
		description:
			"Find a live vehicle by the id a rider types: subway train id or run token, bus fleet number, LIRR train number, car number, or fleet class such as M9.",
		inputSchema: {
			query: z
				.string()
				.min(2)
				.describe("Train number, fleet number, run token, or trip id."),
			agency,
		},
		annotations: { readOnlyHint: true, openWorldHint: true },
	},
	async ({ query, agency: feed }) =>
		attempt(async () => {
			const data = await apiGet<Array<Vehicle & { agency: string }>>(
				"/v1/vehicles/search",
				{ q: query, agency: feed }
			);
			return json(data.map((vehicle) => trimVehicle(vehicle)));
		})
);

server.registerTool(
	"get_train_run",
	{
		title: "Get a train's run",
		description:
			"Every station, yard, junction, and interlocking an LIRR train touches in order, with the track used at each, plus the current track section. LIRR only.",
		inputSchema: {
			vehicle: z
				.string()
				.min(1)
				.describe("Vehicle id from get_vehicles or search_vehicles."),
			route: z
				.string()
				.min(1)
				.describe(
					"The vehicle's route, required because ids are unique only within a route."
				),
			agency: agency.describe("Use lirr."),
		},
		annotations: { readOnlyHint: true, openWorldHint: true },
	},
	async ({ vehicle, route, agency: feed }) =>
		attempt(async () => {
			const data = await apiGet<Record<string, unknown>>(
				`/v1/vehicles/${encodeURIComponent(vehicle)}/route`,
				{ route, agency: feed }
			);
			return json(data);
		})
);

server.registerTool(
	"get_alerts",
	{
		title: "Service alerts",
		description:
			"Active MTA service alerts with affected routes, severity, effect, and active period.",
		inputSchema: {
			agency,
			route: z.string().optional().describe("Only alerts naming this route."),
			limit: z
				.number()
				.int()
				.min(1)
				.max(100)
				.optional()
				.describe("Maximum alerts to return. Defaults to 20."),
		},
		annotations: { readOnlyHint: true, openWorldHint: true },
	},
	async ({ agency: feed, route, limit }) =>
		attempt(async () => {
			const data = await apiGet<Alert[]>("/v1/alerts", {
				agency: feed,
				route,
			});
			return json(capped(data, limit ?? 20));
		})
);

server.registerTool(
	"plan_journey",
	{
		title: "Plan a journey",
		description:
			"Earliest-arrival itineraries on the static timetable, with up to four rides, station-level transfers, and walk connections between nearby stops. Not delay-aware.",
		inputSchema: {
			from: z.string().min(1).describe("Origin stop id."),
			to: z.string().min(1).describe("Destination stop id."),
			agency: agency.describe("Pins the origin feed for a colliding stop id."),
			date: z
				.string()
				.optional()
				.describe("Service date as YYYY-MM-DD. Defaults to today."),
			time: z
				.string()
				.optional()
				.describe("New York local time as HH:MM:SS. Defaults to now."),
			toAgency: agency.describe("Pins the destination feed."),
			preference: z
				.enum(["fastest", "fewerTransfers", "lessWalking"])
				.optional()
				.describe("Ranking order. Defaults to fastest."),
			modes: z
				.array(z.enum(["subway", "rail", "bus"]))
				.optional()
				.describe("Transit modes to include."),
			limit: z
				.number()
				.int()
				.min(1)
				.max(5)
				.optional()
				.describe("Maximum itineraries to return. Defaults to 3."),
		},
		annotations: { readOnlyHint: true, openWorldHint: true },
	},
	async ({
		from,
		to,
		agency: fromAgency,
		date,
		time,
		toAgency,
		preference,
		modes,
		limit,
	}) =>
		attempt(async () => {
			const data = await apiGet<{
				from: { id: string; name: string };
				to: { id: string; name: string };
				date: string;
				time: string;
				itineraries: unknown[];
			}>("/v1/journey", {
				from,
				to,
				fromAgency,
				toAgency,
				date,
				time,
				preference,
				modes: modes?.join(","),
			});

			return json({
				...data,
				...capped(data.itineraries, limit ?? 3),
			});
		})
);

server.registerTool(
	"get_fares",
	{
		title: "Fares",
		description:
			"Curated MTA fares per feed: base, reduced, express, and CityTicket where they apply. Some rail prices vary by zone and peak period and carry no fixed amount.",
		inputSchema: { agency },
		annotations: { readOnlyHint: true, openWorldHint: true },
	},
	async ({ agency: feed }) =>
		attempt(async () => {
			const data = await apiGet<unknown>("/v1/fares", { agency: feed });
			return json(data);
		})
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`tracks MCP server ready, proxying ${API_URL}`);
