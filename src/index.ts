import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { AGENCY_IDS } from "./constants";
import { experimental } from "./experimental";
import { loadTable } from "./lib/loadTable";
import { clearMemoized } from "./lib/memoize";
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

const port = Number(process.env.PORT ?? 3000);
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

// Spec: static tables refresh hourly. Clear-then-warm means requests during
// the ~10s reload wait for fresh data rather than serving yesterday's tables.
// honey: a failed refresh leaves the caches empty; the next request retries
// through memoize's self-eviction instead of serving stale rows.
setInterval(() => {
	clearMemoized();
	warmStatic("refresh").catch((error: unknown) => {
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
export default app;
