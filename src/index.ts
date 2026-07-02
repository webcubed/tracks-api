import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";

const app = new Hono();
app.use("*", cors());
app.get("/", (context) => context.text("ok"));

serve({
	fetch: app.fetch,
	port: 3000,
	hostname: "0.0.0.0",
});

console.log("server up on port 3000");
export default app;
