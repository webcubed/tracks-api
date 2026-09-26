import type { ApiVehicle } from "@/services/vehicles";
import { getVehicles } from "@/services/vehicles";
import { type ApiResponse } from "@/types/api";
import { optionalAgency } from "@/v1/middleware";
import { Hono } from "hono";

export const vehicles = new Hono();

vehicles.get("/", optionalAgency, async (c) => {
	const route = c.req.query("route");

	if (!route) {
		return c.json(
			{
				error: {
					code: "MISSING_ROUTE",
					message: "Missing required query parameter 'route'",
				},
			},
			400
		);
	}

	const data = await getVehicles(route, c.get("agency"));

	if (!data) {
		return c.json(
			{
				error: {
					code: "ROUTE_NOT_FOUND",
					message: `No route found with id '${route}'`,
				},
			},
			404
		);
	}

	return c.json<ApiResponse<ApiVehicle[]>>({ data });
});
