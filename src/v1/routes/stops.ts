import type { Proximity } from "@/services/stops";
import {
	getSchedule,
	getStop,
	getStops,
	isValidDate,
	today,
} from "@/services/stops";
import { optionalAgency } from "@/v1/middleware";
import { Hono } from "hono";

export const stops = new Hono();

stops.get("/", optionalAgency, async (c) => {
	const route = c.req.query("route");
	const parsed = parseNear(
		c.req.query("lat"),
		c.req.query("lon"),
		c.req.query("radius")
	);

	if (parsed.error) {
		return c.json(
			{ error: { code: "INVALID_LOCATION", message: parsed.error } },
			400
		);
	}

	const data = await getStops(c.get("agency"), route, parsed.near);
	return c.json({ data });
});

stops.get("/:id/schedule", optionalAgency, async (c) => {
	const id = c.req.param("id");
	const raw = c.req.query("date");
	const date = raw ?? today();

	if (!isValidDate(date)) {
		return c.json(
			{
				error: {
					code: "INVALID_DATE",
					message: `Invalid date '${date}', expected YYYY-MM-DD`,
				},
			},
			400
		);
	}

	const schedule = await getSchedule(id, date, c.get("agency"));

	if (!schedule) {
		return c.json(
			{
				error: {
					code: "STOP_NOT_FOUND",
					message: `No stop found with id '${id}'`,
				},
			},
			404
		);
	}

	return c.json({ data: schedule });
});

stops.get("/:id", optionalAgency, async (c) => {
	const id = c.req.param("id");
	const stop = await getStop(id, c.get("agency"));

	if (!stop) {
		return c.json(
			{
				error: {
					code: "STOP_NOT_FOUND",
					message: `No stop found with id '${id}'`,
				},
			},
			404
		);
	}

	return c.json({ data: stop });
});

type NearResult = { near?: Proximity; error?: string };

/** `lat`, `lon` and `radius` (metres) arrive together or not at all. */
function parseNear(lat?: string, lon?: string, radius?: string): NearResult {
	if (lat === undefined && lon === undefined && radius === undefined) {
		return {};
	}

	if (lat === undefined || lon === undefined || radius === undefined) {
		return { error: "lat, lon and radius must be provided together" };
	}

	const near: Proximity = {
		lat: Number(lat),
		lon: Number(lon),
		radius: Number(radius),
	};
	const valid =
		Number.isFinite(near.lat) &&
		Math.abs(near.lat) <= 90 &&
		Number.isFinite(near.lon) &&
		Math.abs(near.lon) <= 180 &&
		Number.isFinite(near.radius) &&
		near.radius > 0;

	if (!valid) {
		return {
			error:
				"lat and lon must be coordinates and radius a positive number of metres",
		};
	}

	return { near };
}
