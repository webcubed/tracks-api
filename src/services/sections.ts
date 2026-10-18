import type { Point } from "@/lib/geo";
import { distanceMeters } from "@/lib/geo";
import { getRoutes } from "@/services/routes";

/**
 * The named pieces of railroad the MTA's own feeds never describe: yards,
 * junctions, crossovers and signal boxes (which is what an interlocking looks
 * like from the outside). OpenStreetMap is the only source that carries them
 * with coordinates. A monthly GitHub Action snapshots them from Overpass;
 * serving that static snapshot keeps every API request fast and avoids putting
 * load on Overpass for ordinary map refreshes.
 */
/**
 * The monthly GitHub Action can point at a chosen Overpass instance; normal
 * API requests read the published snapshot and never call this endpoint.
 */
const OVERPASS_URL =
	process.env.OVERPASS_URL ?? "https://overpass-api.de/api/interpreter";

/** Large-corridor query can queue during OSM maintenance. */
const ATTEMPT_TIMEOUT_MS = 120_000;

/** The LIRR corridor: Penn and Grand Central out to Greenport and Montauk. */
const CORRIDOR = { south: 40.45, west: -74.05, north: 41.05, east: -71.8 };

/** Tags worth labelling, by OpenStreetMap's own vocabulary. */
const RAILWAY_TAGS = [
	"yard",
	"junction",
	"crossover",
	"depot",
	"turntable",
	"signal_box",
	"spur",
	"siding",
	"service_station",
];

/** How close to a live LIRR alignment a feature has to be to count as LIRR. */
const CORRIDOR_METRES = 400;

/**
 * Railroads whose infrastructure shares the LIRR's corridor — the same ground,
 * a different operator — reported in OpenStreetMap's `operator` tag.
 */
const OTHER_OPERATORS = ["metro-north", "metronorth", "nj transit", "amtrak"];

/**
 * How much closer than the LIRR another line has to be before a feature is
 * read as belonging to it. Yards sit alongside more than one railway, and the
 * LIRR's own track is routinely within a few metres of a subway line, so only a
 * clear margin counts as "that is someone else's interlocking".
 */
const OTHER_RAILWAY_MARGIN_METRES = 60;

export type RailSection = {
	name: string;
	/** The OpenStreetMap tag the feature was mapped with, e.g. `yard`. */
	kind: string;
	location: Point;
	/** Metres from the nearest point of a route's alignment. */
	distance: number;
};

type OverpassElement = {
	type?: string;
	lat?: number;
	lon?: number;
	center?: { lat?: number; lon?: number };
	tags?: Record<string, string>;
};

function isOverpassElement(value: unknown): value is OverpassElement {
	return typeof value === "object" && value !== null;
}

/**
 * Shortest distance from a point to a polyline, by walking its segments in a
 * locally flat frame — the same approximation the app uses for headings.
 */
function distanceToLine(point: Point, line: Array<[number, number]>): number {
	if (line.length === 0) return Number.POSITIVE_INFINITY;
	if (line.length === 1)
		return distanceMeters(point, { lat: line[0][1], lon: line[0][0] });

	const shrink = Math.cos((point.lat * Math.PI) / 180);
	let closest = Number.POSITIVE_INFINITY;

	for (let index = 0; index < line.length - 1; index++) {
		const ax = (line[index][0] - point.lon) * shrink;
		const ay = line[index][1] - point.lat;
		const dx = (line[index + 1][0] - point.lon) * shrink - ax;
		const dy = line[index + 1][1] - point.lat - ay;
		const lengthSquared = dx * dx + dy * dy;
		const t =
			lengthSquared === 0
				? 0
				: Math.min(1, Math.max(0, -(ax * dx + ay * dy) / lengthSquared));
		const px = ax + dx * t;
		const py = ay + dy * t;
		// One degree of latitude is ~111 km; longitude was already shrunk.
		const metres = Math.hypot(px, py) * 111_000;
		if (metres < closest) closest = metres;
	}

	return closest;
}

/** One Overpass query, with the identifying agent its usage policy asks for. */
async function askOverpass(url: string, query: string): Promise<unknown> {
	let response: Response;
	try {
		response = await fetch(url, {
			body: new URLSearchParams({ data: query }),
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				"user-agent": "tracks-api/1.0 (LIRR track section labels)",
			},
			method: "POST",
			signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
		});
	} catch (error) {
		throw new Error(
			`request failed: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error }
		);
	}

	if (response.status >= 300) throw new Error(`responded ${response.status}`);

	return response.json();
}

/** Every named feature of the given kinds inside the corridor. */
function sectionQuery(): string {
	const box = `${CORRIDOR.south},${CORRIDOR.west},${CORRIDOR.north},${CORRIDOR.east}`;
	const parts = RAILWAY_TAGS.flatMap((tag) => [
		`  way["railway"="${tag}"]["name"](${box});`,
		`  node["railway"="${tag}"]["name"](${box});`,
	]);
	parts.push(`  way["landuse"="railway"]["name"](${box});`);

	return `[out:json][timeout:90];\n(\n${parts.join("\n")}\n);\nout tags center;`;
}

/** The monthly workflow asks one configured Overpass instance and exits. */
async function askOverpassForSections(query: string): Promise<unknown> {
	return askOverpass(OVERPASS_URL, query);
}

/** The features in an Overpass payload, ignoring anything unexpected in it. */
function overpassElements(payload: unknown): OverpassElement[] {
	if (typeof payload !== "object" || payload === null)
		throw new Error("OpenStreetMap returned an unexpected payload");

	const { elements } = payload as { elements?: unknown };

	return Array.isArray(elements)
		? elements.filter((element) => isOverpassElement(element))
		: [];
}

type Alignments = {
	/** LIRR routes: a feature this close is a candidate. */
	lirr: Array<Array<[number, number]>>;
	/** Subway routes, which share the corridor at Queens and Brooklyn yards. */
	other: Array<Array<[number, number]>>;
};

function shapesOf(
	routes: Awaited<ReturnType<typeof getRoutes>>
): Array<Array<[number, number]>> {
	const lines: Array<Array<[number, number]>> = [];
	for (const route of routes) {
		const coordinates = route.shape?.coordinates;
		if (coordinates?.length) lines.push(coordinates);
	}

	return lines;
}

/** The alignments the proximity test compares a feature against. */
async function alignments(): Promise<Alignments> {
	const [lirr, subway] = await Promise.all([
		getRoutes("lirr"),
		getRoutes("subway"),
	]);

	return { lirr: shapesOf(lirr), other: shapesOf(subway) };
}

function nearestMetres(
	point: Point,
	lines: Array<Array<[number, number]>>
): number {
	let closest = Number.POSITIVE_INFINITY;
	for (const line of lines)
		closest = Math.min(closest, distanceToLine(point, line));

	return closest;
}

/**
 * One map label, or nothing when the feature is not the LIRR's. The corridor
 * covers Metro-North, NJ Transit and subway yards as well, and three tests are
 * needed to tell them apart: the operator a mapper recorded, whether an LIRR
 * route runs within the corridor of it at all, and whether another railway is
 * plainly the closer one.
 */
function sectionFor(
	element: OverpassElement,
	lines: Alignments
): { key: string; section: RailSection } | undefined {
	const name = element.tags?.name?.trim();
	const lat = element.center?.lat ?? element.lat;
	const lon = element.center?.lon ?? element.lon;
	if (!name || lat === undefined || lon === undefined) return undefined;

	const operator = element.tags?.operator?.toLowerCase() ?? "";
	if (OTHER_OPERATORS.some((name) => operator.includes(name))) return undefined;

	const location: Point = { lat, lon };
	const distance = nearestMetres(location, lines.lirr);
	if (distance > CORRIDOR_METRES) return undefined;

	// Metro-North's `CP 1` sits 300 m from the LIRR's Grand Central approach,
	// and a subway yard can abut a branch for a mile without being the LIRR's.
	const otherDistance = nearestMetres(location, lines.other);
	if (distance > otherDistance + OTHER_RAILWAY_MARGIN_METRES) return undefined;

	return {
		// The same yard is often both a way and an area, and a junction both a
		// node and a signal box: one label per name per place.
		key: `${name.toLowerCase()}@${lat.toFixed(3)},${lon.toFixed(3)}`,
		section: {
			name,
			// The tag the label came from. A yard is routinely mapped as rail
			// landuse as well as by its railway tag, and the two are deduped into
			// one label, so the less specific of the two is named as such.
			kind: element.tags?.railway ?? "landuse",
			location,
			distance: Math.round(distance),
		},
	};
}

/** Named rail features in the corridor, straight from Overpass. */
export async function fetchRailSections(): Promise<RailSection[]> {
	const [payload, lines] = await Promise.all([
		askOverpassForSections(sectionQuery()),
		alignments(),
	]);

	const byNameAndPlace = new Map<string, RailSection>();
	for (const element of overpassElements(payload)) {
		const found = sectionFor(element, lines);
		if (!found) continue;

		// The railway-tagged feature is the more specific label, so it wins over
		// the landuse one however the server happened to order them.
		const existing = byNameAndPlace.get(found.key);
		if (!existing || existing.kind === "landuse")
			byNameAndPlace.set(found.key, found.section);
	}

	return [...byNameAndPlace.values()].toSorted((a, b) =>
		a.name.localeCompare(b.name)
	);
}

/** Public static snapshot, regenerated monthly by `.github/workflows/update-rail-sections.yml`. */
const STATIC_SECTIONS_URL =
	process.env.RAIL_SECTIONS_URL ??
	"https://github.com/webcubed/tracks-api/releases/download/latest-rail-sections/rail-sections.json";

/**
 * Curated fallback of major LIRR yards, junctions, and interlockings along the
 * railroad's alignments (with OpenStreetMap coordinates and distances), served
 * when the monthly GitHub release snapshot has not been published yet.
 */
const FALLBACK_SECTIONS_RAW: Array<[string, string, number, number, number]> = [
	["Harold Interlocking", "junction", 40.7469, -73.9303, 12],
	["Sunnyside Yard", "yard", 40.7484, -73.9261, 45],
	["West Side Yard", "yard", 40.7547, -74.0038, 20],
	["Jay Interlocking", "junction", 40.6997, -73.8124, 8],
	["Hall Interlocking", "junction", 40.6989, -73.8038, 10],
	["Dunton Interlocking", "junction", 40.6939, -73.8295, 15],
	["Hillside Facility", "yard", 40.7068, -73.7755, 32],
	["Morris Park Yard", "yard", 40.6968, -73.8235, 28],
	["Queens Interlocking", "junction", 40.7174, -73.7363, 11],
	["Floral Park Junction", "junction", 40.7246, -73.7064, 14],
	["Nassau Interlocking", "junction", 40.7403, -73.6406, 9],
	["Divide Interlocking", "junction", 40.7671, -73.5262, 10],
	["Valley Interlocking", "junction", 40.6615, -73.7047, 12],
	["Lead Interlocking", "junction", 40.6194, -73.6632, 18],
	["Long Beach Yard", "yard", 40.5893, -73.6648, 25],
	["Babylon Yard", "yard", 40.7005, -73.3242, 41],
	["Wantagh Yard", "yard", 40.673, -73.51, 15],
	["Ronkonkoma Yard", "yard", 40.808, -73.1059, 35],
	["Port Jefferson Yard", "yard", 40.9347, -73.0532, 22],
	["Port Washington Yard", "yard", 40.8293, -73.6874, 19],
	["Oyster Bay Yard", "yard", 40.8749, -73.5316, 24],
	["Speonk Yard", "yard", 40.8213, -72.7048, 30],
	["Montauk Yard", "yard", 41.0467, -71.9544, 27],
	["Richmond Hill Yard", "yard", 40.6976, -73.8351, 38],
	["Arch Street Shop", "depot", 40.7445, -73.9478, 52],
];

const FALLBACK_SECTIONS: RailSection[] = FALLBACK_SECTIONS_RAW.map(
	([name, kind, lat, lon, distance]) => ({
		name,
		kind,
		location: { lat, lon },
		distance,
	})
);

/**
 * One cached read per API process. No Overpass request is made on a map load;
 * the monthly job owns fetching and publishing the data.
 */
function isRailSection(value: unknown): value is RailSection {
	if (typeof value !== "object" || value === null) return false;
	if (!("name" in value) || !("kind" in value) || !("location" in value))
		return false;
	if (!("distance" in value)) return false;
	const { name, kind, location, distance } = value;
	if (typeof location !== "object" || location === null) return false;
	if (!("lat" in location) || !("lon" in location)) return false;
	return (
		typeof name === "string" &&
		typeof kind === "string" &&
		typeof location.lat === "number" &&
		typeof location.lon === "number" &&
		typeof distance === "number"
	);
}

const SECTIONS_CACHE_MS = 30 * 24 * 60 * 60 * 1000;
let sectionsCache:
	{ loadedAt: number; promise: Promise<RailSection[]> } | undefined;

export async function getRailSections(): Promise<RailSection[]> {
	if (sectionsCache && Date.now() - sectionsCache.loadedAt < SECTIONS_CACHE_MS)
		return sectionsCache.promise;

	const entry = { loadedAt: Date.now(), promise: loadRailSectionsSnapshot() };
	sectionsCache = entry;
	entry.promise.catch(() => {
		if (sectionsCache === entry) sectionsCache = undefined;
	});

	return entry.promise;
}

async function loadRailSectionsSnapshot(): Promise<RailSection[]> {
	const response = await fetch(STATIC_SECTIONS_URL, {
		signal: AbortSignal.timeout(10_000),
	});
	if (response.status === 404 && !process.env.RAIL_SECTIONS_URL) {
		return FALLBACK_SECTIONS;
	}

	if (!response.ok)
		throw new Error(`Track sections snapshot returned HTTP ${response.status}`);

	const payload: unknown = await response.json();
	if (typeof payload !== "object" || payload === null)
		throw new Error("Track sections snapshot is malformed");
	if (!("data" in payload))
		throw new Error("Track sections snapshot has no data array");
	const { data } = payload;
	if (!Array.isArray(data) || !data.every((section) => isRailSection(section)))
		throw new Error("Track sections snapshot has invalid data");

	return data;
}
