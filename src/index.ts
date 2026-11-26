import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
	createRecorder,
	FLUSH_MS,
	recordingTrigger,
	SAMPLE_MS,
} from "./archive/runner";
import { AGENCY_IDS, getJourneyIndexUrl } from "./constants";
import { experimental } from "./experimental";
import { missingB2Env } from "./lib/b2";
import { loadTable } from "./lib/loadTable";
import { clearMemoized } from "./lib/memoize";
import { cachedParquet } from "./lib/parquetCache";
import { today } from "./lib/time";
import { clearFrequencyCache, getBusFrequency } from "./services/analytics";
import { getStations } from "./services/network";
import { getRoutes } from "./services/routes";
import { v1 } from "./v1";

const app = new Hono();
app.use("*", cors());
app.get("/", (context) => context.text("ok"));
app.get("/docs", (context) => context.redirect("/docs/"));
app.use(
	"/docs/*",
	serveStatic({
		root: resolve("docs/.vitepress/dist"),
		rewriteRequestPath(path) {
			const filePath = path.startsWith("/docs/")
				? path.slice("/docs".length)
				: path;

			if (filePath.endsWith("/")) return `${filePath}index.html`;

			return filePath.includes(".") ? filePath : `${filePath}.html`;
		},
	})
);
app.route("v1", v1);
app.route("experimental", experimental);

// `PORT` may be set but empty (a zero-byte .env exports nothing, but a shell
// can export PORT=""): Number("") is 0, which asks the OS for a random port and
// silently breaks health checks. Fall back to 3000 for anything unusable.
const requestedPort = Number(process.env.PORT);
const port =
	Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : 3000;
const startupStartedAt = Date.now();

// Static tables are small; warm them sequentially so DuckDB never allocates
// eight concurrent hash/window buffers at once on 512 MB hosts (e.g. Render free tier).
async function warmStatic(phase: "startup" | "refresh"): Promise<void> {
	const warmupStartedAt = Date.now();
	const firstBootNote =
		phase === "startup"
			? " First boot commonly takes ~10 seconds while remote data is loaded sequentially."
			: "";

	console.info(
		`[${phase}] Warming agency and route data for ${AGENCY_IDS.length} feeds.${firstBootNote}`
	);

	for (const id of AGENCY_IDS) {
		const feedStartedAt = Date.now();
		console.info(`[${phase}] ${id}: loading agency and route data`);

		try {
			// eslint-disable-next-line no-await-in-loop
			await Promise.all([
				loadTable(id, "agency"),
				getRoutes(id),
				getStations(id),
			]);
		} catch (error) {
			console.error(
				`[${phase}] ${id}: warmup failed after ${elapsed(feedStartedAt)}`,
				error
			);
			throw error;
		}

		console.info(`[${phase}] ${id}: ready in ${elapsed(feedStartedAt)}`);
	}

	console.info(`[${phase}] All feeds ready in ${elapsed(warmupStartedAt)}`);
}

console.info(
	`[startup] Initializing tracks-api on port ${port}; HTTP will be available after static data warmup.`
);
await warmStatic("startup");

function elapsed(startedAt: number): string {
	return `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
}

/**
 * Cache journey timetable indexes after the server starts accepting requests.
 * The first journey otherwise pays for up to a dozen 10-20 MB downloads while
 * its search waits; warming in feed order shares those in-flight downloads.
 */
async function warmJourneyIndexes(): Promise<void> {
	if (process.env.JOURNEY_PARQUET_PREWARM === "0") return;
	const startedAt = Date.now();
	console.info("[startup] Warming journey timetable indexes");

	for (const feed of AGENCY_IDS) {
		for (const index of ["boarding", "timeline"] as const) {
			// eslint-disable-next-line no-await-in-loop
			await cachedParquet(getJourneyIndexUrl(feed, index));
		}
	}

	console.info(
		`[startup] Journey timetable indexes ready in ${elapsed(startedAt)}`
	);
}

/**
 * The bus tab's rhythm merges six borough feeds: twenty seconds of parquet that
 * no page load should wait for, so it is built once in the background after the
 * journey indexes are in, and rebuilt by the hourly refresh on its own DuckDB
 * connection (see `services/analytics.ts`).
 */
async function warmFrequency(
	phase: "startup" | "refresh" = "startup"
): Promise<void> {
	const warmupStartedAt = Date.now();
	try {
		const report = await getBusFrequency(today());
		console.info(
			`[${phase}] Bus timetable rhythm ready in ${elapsed(warmupStartedAt)}: ${report?.trips ?? 0} departures`
		);
	} catch (error) {
		console.error(`[${phase}] Bus timetable rhythm warmup failed:`, error);
	}
}

/**
 * Drop the cached scans and rebuild today's report from the timetable as it is
 * published now. The supplemented feed is republished hourly, so a report that
 * is never rebuilt describes service changes that have since moved.
 */
async function refreshFrequency(): Promise<void> {
	clearFrequencyCache();
	await warmFrequency("refresh");
}

// Spec: static tables refresh hourly. Clear-then-warm means requests during
// the ~10s reload wait for fresh data rather than serving yesterday's tables.
// honey: a failed refresh leaves the caches empty; the next request retries
// through memoize's self-eviction instead of serving stale rows.
// The bus rhythm follows the same tick, on its own DuckDB connection: sharing
// the live one cost a live request about 0.6 s of queue time and stretched the
// scan itself, so the rebuild now runs beside it instead of in front of it.
setInterval(() => {
	clearMemoized();
	warmStatic("refresh")
		.then(warmJourneyIndexes)
		.then(refreshFrequency)
		.catch((error: unknown) => {
			console.error("static refresh failed:", error);
		});
}, 3_600_000);

serve({
	fetch: app.fetch,
	port,
	hostname: "0.0.0.0",
});

console.info(
	`[startup] Server ready at http://localhost:${port} (startup took ${elapsed(startupStartedAt)})`
);

/**
 * Recording in process: Render keeps this server awake anyway and gets it unasked; a dev server with bucket credentials in `.env` stays off.
 */
function startRecording(): void {
	const trigger = recordingTrigger();
	if (!trigger) return;

	const missing = missingB2Env();
	if (missing.length > 0) {
		console.warn(`[record] not recording: set ${missing.join(", ")}`);
		return;
	}

	const recorder = createRecorder();

	// A deploy or a recycle restarts this process, so the flush on the way out is
	// what keeps the archive continuous instead of losing a quarter hour of it.
	const shutdown = (): void => {
		recorder
			.stop()
			.catch((error: unknown) => {
				console.error("[record] shutdown failed:", error);
			})
			.finally(() => {
				// eslint-disable-next-line unicorn/no-process-exit
				process.exit(0);
			});
	};

	process.once("SIGTERM", shutdown);
	process.once("SIGINT", shutdown);

	recorder.start();
	console.info(
		`[record] recording in process (${trigger === "render" ? "Render host" : "ARCHIVE_RECORD=1"}), sampling every ${SAMPLE_MS / 1000}s, flushing every ${FLUSH_MS / 1000}s`
	);
}

startRecording();
/** Both caches are optional infrastructure: readiness never waits on them. */
async function warmInBackground(): Promise<void> {
	try {
		await warmJourneyIndexes();
	} catch (error) {
		console.error("journey timetable warmup failed:", error);
	}

	await warmFrequency();
}

// eslint-disable-next-line unicorn/prefer-top-level-await -- readiness must not wait on timetable downloads
void warmInBackground();
export default app;
