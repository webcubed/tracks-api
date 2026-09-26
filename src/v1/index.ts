import { Hono } from "hono";
import { agencies } from "./routes/agencies";
import { routes } from "./routes/routes";
import { stops } from "./routes/stops";

export const v1 = new Hono();
v1.route("/agencies", agencies);
v1.route("/routes", routes);
v1.route("/stops", stops);
