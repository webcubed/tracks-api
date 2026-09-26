/**
 * Ad-hoc GTFS-RT decoder: `pnpm exec tsx scripts/rt.ts <url> [entities]
 * [nyct|mercury]`. Decodes with the local `src/proto/*` and prints the first N
 * entities as JSON. `mercury` loads the alert extensions instead of the
 * NYCT/railroad ones (both claim field 1001 on FeedHeader).
 */

import path from "node:path";
import process from "node:process";
import { Root } from "protobufjs";

const protoRoot = path.resolve(import.meta.dirname, "../src/proto");
const [url, count, extension] = process.argv.slice(2);

if (!url) {
	throw new Error("usage: tsx scripts/rt.ts <url> [entities] [nyct|mercury]");
}

const root = new Root();

// Extension protos import "com/google/transit/realtime/gtfs-realtime.proto",
// which resolves against src/proto, not against the importing file. NYCT and
// Mercury both claim field 1001 on FeedHeader, so they need separate roots.
root.resolvePath = (_origin, target) =>
	path.isAbsolute(target) ? target : path.join(protoRoot, target);
root.loadSync(
	[
		"com/google/transit/realtime/gtfs-realtime.proto",
		extension === "mercury"
			? "gtfs-realtime-service-status.proto"
			: "gtfs-realtime-NYCT.proto",
		...(extension === "mercury" ? [] : ["gtfs-realtime-MTARR.proto"]),
	].map((file) => path.join(protoRoot, file)),
	{ keepCase: false }
);

const FeedMessage = root.lookupType("transit_realtime.FeedMessage");

type FeedEntity = {
	id?: string;
	tripUpdate?: {
		delay?: number;
		vehicle?: { id?: string };
		trip?: { routeId?: string; tripId?: string; directionId?: number };
		stopTimeUpdate?: Array<Record<string, unknown>>;
	};
	vehicle?: { trip?: { routeId?: string } };
	alert?: Record<string, unknown>;
};

type DecodedFeed = {
	header?: Record<string, unknown>;
	entity?: FeedEntity[];
};

const response = await fetch(url);

if (!response.ok) {
	throw new Error(`HTTP ${response.status} ${response.statusText}`);
}

const buffer = new Uint8Array(await response.arrayBuffer());
const message = FeedMessage.decode(buffer);
const decoded = FeedMessage.toObject(message, {
	enums: String,
	longs: String,
	defaults: false,
}) as DecodedFeed;

const entities = (decoded.entity ?? []).slice(0, Number(count ?? 3));
console.log(JSON.stringify(entities, null, 1));
const kinds = new Map<string, number>();
const routeIds = new Set<string>();

for (const entity of decoded.entity ?? []) {
	const kind = Object.keys(entity)
		.filter((key) => key !== "id")
		.join("+");
	kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
	const trip = entity.tripUpdate?.trip ?? entity.vehicle?.trip;
	if (trip?.routeId) routeIds.add(trip.routeId);
}

console.error(
	`entities: ${(decoded.entity ?? []).length} ${JSON.stringify(Object.fromEntries(kinds))}`
);
console.error(`routes: ${[...routeIds].toSorted().join(",")}`);
