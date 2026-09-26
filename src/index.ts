import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { AGENCY_IDS } from "./constants";
import { loadTable } from "./lib/loadTable";
import { v1 } from "./v1";

const app = new Hono();
// app.use("*", logger());
app.use("*", cors());
app.get("/", (context) => context.text("ok"));
app.route("v1", v1);

// Static tables are small; warm them so the first request isn't the slow one.
await Promise.all(
	AGENCY_IDS.flatMap((id) => [loadTable(id, "agency"), loadTable(id, "routes")])
);

serve({
	fetch: app.fetch,
	port: 3000,
	hostname: "0.0.0.0",
});

console.log("server up on port 3000");
export default app;
