import type { AgencyId } from "@/constants";
import { isAgencyId } from "@/constants";
import { getSchedule, getStop, getStops, today } from "@/services/stops";
import { Hono } from "hono";

export const stops = new Hono();

stops.get("/", async (c) => {
	const route = c.req.query("route");
	const raw = c.req.query("agency");
	let agency: AgencyId | undefined;

	if (raw !== undefined) {
		if (!isAgencyId(raw)) {
			return c.json(
				{
					error: {
						code: "AGENCY_NOT_FOUND",
						message: `No agency found with id '${raw}'`,
					},
				},
				404
			);
		}

		agency = raw;
	}

	const data = await getStops(agency, route);
	return c.json({ data });
});

stops.get("/:id/schedule", async (c) => {
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

	const schedule = await getSchedule(id, date);

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

stops.get("/:id", async (c) => {
	const id = c.req.param("id");
	const stop = await getStop(id);

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

/**
 * Strict `YYYY-MM-DD`: parse it, then check the round trip. Rejects
 * `2026-2-3`, `garbage` and impossible dates like `2026-02-31` (which parse
 * as March 3rd), and needs no regex flags — `tsconfig` targets ES2017, which
 * can't compile the `v` flag xo asks for.
 */
function isValidDate(value: string): boolean {
	const date = new Date(`${value}T00:00:00Z`);

	if (Number.isNaN(date.getTime())) return false;

	return date.toISOString().slice(0, 10) === value;
}
