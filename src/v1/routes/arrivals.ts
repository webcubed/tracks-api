import type { ApiArrivals } from "@/services/arrivals";
import { getArrivals } from "@/services/arrivals";
import { type ApiResponse } from "@/types/api";
import { optionalAgency } from "@/v1/middleware";
import { Hono } from "hono";

export const arrivals = new Hono();

arrivals.get("/", optionalAgency, async (c) => {
	const stop = c.req.query("stop");

	if (!stop) {
		return c.json(
			{
				error: {
					code: "MISSING_STOP",
					message: "Missing required query parameter 'stop'",
				},
			},
			400
		);
	}

	const data = await getArrivals(stop, c.req.query("route"), c.get("agency"));

	if (!data) {
		return c.json(
			{
				error: {
					code: "STOP_NOT_FOUND",
					message: `No stop found with id '${stop}'`,
				},
			},
			404
		);
	}

	return c.json<ApiResponse<ApiArrivals>>({ data });
});
