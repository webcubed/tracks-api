import type { AgencyId } from "@/constants";
import type { FeedEntity, FeedMessage } from "@/types/realtime";
import path from "node:path";
import { getStaticFeedUrl, REALTIME_FEEDS, subwayFeedUrls } from "@/constants";
import { memoize } from "@/lib/memoize";
import { runQuery } from "@/lib/parquet";
import { Root } from "protobufjs";

/** An upstream we can't read: surfaced as 502, never as a quietly empty board. */
export class FeedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FeedError";
	}
}

const protoRoot = path.resolve(import.meta.dirname, "../proto");
const NEW_YORK = "America/New_York";

/**
 * One root for trip/vehicle feeds: the core spec plus the NYCT and railroad
 * extensions. Mercury can't join — it reuses field 1001 on FeedHeader — and
 * alerts are read as JSON anyway (`@/types/realtime`).
 */
const feedMessage = memoize(async () => {
	const root = new Root();

	// The extension protos import "com/google/transit/…" by package path, which
	// resolves against src/proto rather than against the importing file.
	root.resolvePath = (_origin, target) =>
		path.isAbsolute(target) ? target : path.join(protoRoot, target);
	root.loadSync(
		[
			"com/google/transit/realtime/gtfs-realtime.proto",
			"gtfs-realtime-NYCT.proto",
			"gtfs-realtime-MTARR.proto",
		].map((file) => path.join(protoRoot, file)),
		{ keepCase: false }
	);

	return root.lookupType("transit_realtime.FeedMessage");
});

/**
 * Realtime responses share one upstream fetch for this long. The spec allows
 * 15-30s; feeds update every 30s, so the worst case is one update behind.
 * Failures are never cached (memoize evicts rejected entries itself).
 */
export const FEED_TTL_MS = 15_000;

export const fetchFeed = memoize(async (url: string): Promise<FeedEntity[]> => {
	const response = await fetch(url, {
		signal: AbortSignal.timeout(15_000),
	});

	if (!response.ok) {
		throw new FeedError(`${url} responded ${response.status}`);
	}

	const buffer = new Uint8Array(await response.arrayBuffer());
	const type = await feedMessage();
	const decoded = type.decode(buffer);
	const message = type.toObject(decoded, {
		enums: String,
		longs: String,
		defaults: false,
	}) as FeedMessage;

	return message.entity ?? [];
}, FEED_TTL_MS);

function feedUrls(
	agency: AgencyId,
	kind: "trips" | "vehicles",
	routes: readonly string[]
): string[] {
	if (agency === "subway") return subwayFeedUrls(routes);
	if (agency === "lirr") return [REALTIME_FEEDS.LIRR];

	return [
		kind === "trips"
			? REALTIME_FEEDS.BUS.TRIP_UPDATES
			: REALTIME_FEEDS.BUS.VEHICLE_POSITIONS,
	];
}

/**
 * Every endpoint for an agency, one request each: trip updates *and* vehicle
 * positions (subway and LIRR publish both in the same payload, so the URL set
 * dedupes to one). A feed that answers empty is fine; feeds that all fail
 * raise FeedError instead of reporting a half-empty service.
 */
export async function fetchRealtime(
	agency: AgencyId,
	routes: readonly string[]
): Promise<FeedEntity[]> {
	const urls = [
		...new Set([
			...feedUrls(agency, "trips", routes),
			...feedUrls(agency, "vehicles", routes),
		]),
	];
	const results = await Promise.allSettled(
		urls.map(async (url) => fetchFeed(url))
	);
	const failures = results.filter(
		(result): result is PromiseRejectedResult => result.status === "rejected"
	);

	if (failures.length === results.length && failures[0]) {
		throw new FeedError(
			`realtime feed unavailable: ${String(failures[0].reason)}`
		);
	}

	return results.flatMap((result) =>
		result.status === "fulfilled" ? result.value : []
	);
}

export type StaticTrip = {
	routeId?: string;
	headsign?: string;
	shapeId?: string;
};

type TripRow = {
	trip_id: string;
	route_id?: string;
	trip_headsign?: string;
	shape_id?: string;
};

/**
 * Trip ids → static facts the real-time feed leaves out: headsigns (nowhere in
 * GTFS-RT), route ids (LIRR's trips carry only trip + date) and the shape that
 * says which way the trip runs.
 */
export async function lookupTrips(
	agency: AgencyId,
	tripIds: readonly string[]
): Promise<Map<string, StaticTrip>> {
	const index = new Map<string, StaticTrip>();

	if (tripIds.length === 0) return index;

	const rows = await runQuery<TripRow>(
		`SELECT trip_id, route_id, trip_headsign, shape_id
		 FROM read_parquet('${getStaticFeedUrl(agency, "trips")}')
		 WHERE trip_id IN (${tripIds.map(() => "?").join(", ")})`,
		...tripIds
	);

	for (const row of rows) {
		if (!row.trip_id) continue;

		index.set(row.trip_id, {
			routeId: row.route_id,
			headsign: row.trip_headsign,
			shapeId: row.shape_id,
		});
	}

	return index;
}

/**
 * Epoch seconds → `2026-08-17T14:32:00-04:00`, the offset-bearing local time
 * the spec shows. `sv-SE` formats as `YYYY-MM-DD HH:MM:SS`.
 */
export function isoNewYork(epoch: number): string {
	const instant = new Date(epoch * 1000);
	const local = new Intl.DateTimeFormat("sv-SE", {
		timeZone: NEW_YORK,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).format(instant);
	const zone =
		new Intl.DateTimeFormat("en-US", {
			timeZone: NEW_YORK,
			timeZoneName: "longOffset",
		})
			.formatToParts(instant)
			.find((part) => part.type === "timeZoneName")?.value ?? "GMT";

	return `${local.replace(" ", "T")}${zone === "GMT" ? "+00:00" : zone.replace("GMT", "")}`;
}
