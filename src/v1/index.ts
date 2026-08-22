import { Hono } from "hono";
import { agencies } from "./routes/agencies";
import { routes } from "./routes/routes";

export const v1 = new Hono();
v1.route("/agencies", agencies);
v1.route("/routes", routes);
