import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { AGENCY_IDS, getJourneyIndexUrl } from "./constants";
import { experimental } from "./experimental";
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
 * journey indexes are in. It is not rebuilt by the hourly refresh, which would
 * stall live queries for the length of the scan; `scheduleDailyWarm` rebuilds it
 * for each new date instead.
 */
async function warmFrequency(): Promise<void> {
	const warmupStartedAt = Date.now();
	try {
		const report = await getBusFrequency(today());
		console.info(
			`[startup] Bus timetable rhythm ready in ${elapsed(warmupStartedAt)}: ${report?.trips ?? 0} departures`
		);
	} catch (error) {
		console.error("[startup] Bus timetable rhythm warmup failed:", error);
	}
}

const SECONDS_PER_DAY = 86_400;
/** Five minutes past the timetable's midnight, after any clock skew settles. */
const DAILY_WARM_SECONDS = 300;

/** New York wall clock, the timezone the timetable's dates are written in. */
function newYorkClockSeconds(): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: "America/New_York",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).formatToParts(new Date());
	const value = (type: "hour" | "minute" | "second"): number =>
		Number(parts.find((part) => part.type === type)?.value ?? 0);

	return value("hour") * 3600 + value("minute") * 60 + value("second");
}

/**
 * The supplemented timetable is republished hourly, so a report is not final for
 * its date and its cache can only age. Rebuild just after midnight, when the new
 * date starts: otherwise the first bus request of the day pays the full
 * twenty-second scan. A chain of one-day timeouts rather than a 24-hour interval
 * keeps the tick at midnight across a DST change.
 */
function scheduleDailyWarm(): void {
	let waitSeconds = DAILY_WARM_SECONDS - newYorkClockSeconds();
	if (waitSeconds <= 0) waitSeconds += SECONDS_PER_DAY;

	console.info(
		`[schedule] Bus timetable rhythm rebuild in ${(waitSeconds / 3600).toFixed(1)}h`
	);

	setTimeout(() => {
		clearFrequencyCache();
		warmFrequency()
			.then(scheduleDailyWarm)
			.catch((error: unknown) => {
				console.error("daily timetable warm failed:", error);
				scheduleDailyWarm();
			});
	}, waitSeconds * 1000);
}

// Spec: static tables refresh hourly. Clear-then-warm means requests during
// the ~10s reload wait for fresh data rather than serving yesterday's tables.
// honey: a failed refresh leaves the caches empty; the next request retries
// through memoize's self-eviction instead of serving stale rows.
// The bus rhythm is deliberately absent: rescanning six borough feeds here put
// a twenty-second queue in front of live queries every hour. The cost is that a
// report describes the timetable as it stood when it was built, not as it
// stands now, because the supplemented feed is republished hourly; the daily
// midnight rebuild is what refreshes it, so a service change can lag until then.
setInterval(() => {
	clearMemoized();
	warmStatic("refresh")
		.then(warmJourneyIndexes)
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
/** Both caches are optional infrastructure: readiness never waits on them. */
async function warmInBackground(): Promise<void> {
	try {
		await warmJourneyIndexes();
	} catch (error) {
		console.error("journey timetable warmup failed:", error);
	}

	await warmFrequency();
	scheduleDailyWarm();
}

// eslint-disable-next-line unicorn/prefer-top-level-await -- readiness must not wait on timetable downloads
void warmInBackground();
export default app;
