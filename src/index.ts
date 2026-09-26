import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { AGENCY_IDS } from "./constants";
import { loadTable } from "./lib/loadTable";
import { clearMemoized } from "./lib/memoize";
import { getRoutes } from "./services/routes";
import { v1 } from "./v1";

const app = new Hono();
app.use("*", cors());
app.get("/", (context) => context.text("ok"));
app.route("v1", v1);

// Static tables are small; warm them so the first request isn't the slow one.
// getRoutes() pulls in the per-feed trips + shapes geometry as well.
async function warmStatic(): Promise<void> {
	await Promise.all(
		AGENCY_IDS.flatMap((id) => [loadTable(id, "agency"), getRoutes(id)])
	);
}

await warmStatic();

// Spec: static tables refresh hourly. Clear-then-warm means requests during
// the ~10s reload wait for fresh data rather than serving yesterday's tables.
// honey: a failed refresh leaves the caches empty; the next request retries
// through memoize's self-eviction instead of serving stale rows.
setInterval(() => {
	clearMemoized();
	warmStatic().catch((error: unknown) => {
		console.error("static refresh failed:", error);
	});
}, 3_600_000);

serve({
	fetch: app.fetch,
	port: 3000,
	hostname: "0.0.0.0",
});

console.log("server up on port 3000");
export default app;
