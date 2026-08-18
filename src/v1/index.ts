import { Hono } from "hono";
import { agencies } from "./routes/agencies";

export const v1 = new Hono();
v1.route("/agencies", agencies);
