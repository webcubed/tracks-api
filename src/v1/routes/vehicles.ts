import type { AgencyId } from "@/constants";
import type { ApiVehicle, ApiVehicleSearchResult } from "@/services/vehicles";
import { isAgencyId } from "@/constants";
import { getTrainRoute } from "@/services/trainRoute";
import {
	getVehicles,
	getVehiclesForAgency,
	searchVehicles,
} from "@/services/vehicles";
import { type ApiResponse } from "@/types/api";
import { optionalAgency } from "@/v1/middleware";
import { Hono } from "hono";

export const vehicles = new Hono();

/**
 * Find a live vehicle by the id a rider types: a subway train id or run token,
 * a bus fleet number, or an LIRR train number. Feed search is citywide, so the
 * vehicle does not need to be inside the current map viewport.
 */
vehicles.get("/search", optionalAgency, async (c) => {
	const query = c.req.query("q")?.trim() ?? "";
	const data =
		query.length < 2 ? [] : await searchVehicles(query, c.get("agency"));
	return c.json<ApiResponse<ApiVehicleSearchResult[]>>({ data });
});

/** One response per feed, optionally narrowed to the visible routes and map box. */
vehicles.get("/feed", async (c) => {
	const rawAgency = c.req.query("agency");
	if (!rawAgency || !isAgencyId(rawAgency)) {
		return c.json(
			{
				error: {
					code: "AGENCY_NOT_FOUND",
					message: `No agency found with id '${rawAgency ?? ""}'`,
				},
			},
			404
		);
	}

	const routeParameter = c.req.query("routes");
	const routes = routeParameter
		? routeParameter
				.split(",")
				.map((route) => route.trim())
				.filter(Boolean)
		: undefined;
	const boundsValues = ["west", "south", "east", "north"].map((key) =>
		c.req.query(key)
	);
	const hasBounds = boundsValues.some((value) => value !== undefined);
	if (
		hasBounds &&
		boundsValues.some(
			(value) => value === undefined || !Number.isFinite(Number(value))
		)
	) {
		return c.json(
			{
				error: {
					code: "INVALID_BOUNDS",
					message: "west, south, east and north must be finite coordinates",
				},
			},
			400
		);
	}

	const [west, south, east, north] = boundsValues.map((value) =>
		value === undefined ? Number.NaN : Number(value)
	);
	const validBounds =
		Number.isFinite(west) &&
		Number.isFinite(south) &&
		Number.isFinite(east) &&
		Number.isFinite(north) &&
		west >= -180 &&
		west <= east &&
		east <= 180 &&
		south >= -90 &&
		south <= north &&
		north <= 90;
	if (hasBounds && !validBounds) {
		return c.json(
			{
				error: {
					code: "INVALID_BOUNDS",
					message: "Bounds must be ordered longitude/latitude coordinates",
				},
			},
			400
		);
	}

	const bounds = hasBounds ? { west, south, east, north } : undefined;
	const data = await getVehiclesForAgency(rawAgency, routes, bounds);
	return c.json<ApiResponse<ApiVehicle[]>>({ data });
});

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

// The train's own run: every station, yard and interlocking the tracking
// system has it touching, with the track it uses at each. `route` is required
// for the same reason the listing needs it — vehicle ids are only unique
// inside a route, and finding one otherwise would mean polling every feed.
vehicles.get("/:id/route", optionalAgency, async (c) => {
	const id = c.req.param("id");
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

	const data = await getTrainRoute(id, route, c.get("agency"));

	if (!data) {
		return c.json(
			{
				error: {
					code: "VEHICLE_NOT_FOUND",
					message: `No vehicle '${id}' is running on route '${route}'`,
				},
			},
			404
		);
	}

	return c.json({ data });
});
