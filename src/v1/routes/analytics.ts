import type { AgencyId } from "@/constants";
import { isAgencyId } from "@/constants";
import { missingB2Env } from "@/lib/b2";
import { isValidDate, today } from "@/lib/time";
import {
	clampHours,
	getBusFrequency,
	getCarHistory,
	getCoverage,
	getFrequency,
	getReliability,
	getStopReliability,
} from "@/services/analytics";
import { type ApiResponse } from "@/types/api";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";

export const analytics = new Hono();

/** History is optional infrastructure: without it the archive routes say so. */
const requiresArchive = createMiddleware(async (c, next) => {
	const missing = missingB2Env();
	if (missing.length > 0) {
		return c.json(
			{
				error: {
					code: "ARCHIVE_NOT_CONFIGURED",
					message: `Archive storage is not configured: ${missing.join(", ")}`,
				},
			},
			503
		);
	}

	return next();
});

analytics.use("*", requiresArchive);

function agencyNotFound(agency: string) {
	return {
		error: {
			code: "AGENCY_NOT_FOUND",
			message: `No agency found with id '${agency}'`,
		},
	};
}

analytics.get("/coverage", async (c) =>
	c.json<ApiResponse<Awaited<ReturnType<typeof getCoverage>>>>({
		data: await getCoverage(),
	})
);

/** What one car has been pulling, and where those trains went. */
analytics.get("/fleet", async (c) => {
	const raw = c.req.query("car") ?? "";
	const car = Number(raw);
	if (!raw || !Number.isInteger(car) || car <= 0) {
		return c.json(
			{
				error: {
					code: "INVALID_CAR",
					message: `'${raw}' is not a car number`,
				},
			},
			400
		);
	}

	const hours = clampHours(
		c.req.query("hours") === undefined
			? undefined
			: Number(c.req.query("hours"))
	);

	return c.json({ data: await getCarHistory(car, hours) });
});

/** On-time share and delay distribution, by route and by stop. */
analytics.get("/reliability", async (c) => {
	const rawAgency = c.req.query("agency");
	let agency: AgencyId | undefined;
	if (rawAgency) {
		if (!isAgencyId(rawAgency)) return c.json(agencyNotFound(rawAgency), 404);
		agency = rawAgency;
	}

	const hours = clampHours(
		c.req.query("hours") === undefined
			? undefined
			: Number(c.req.query("hours"))
	);

	return c.json({
		data: await getReliability({
			agency,
			route: c.req.query("route") ?? undefined,
			hours,
		}),
	});
});

/** Reliability at one station, across the routes and platforms it serves. */
analytics.get("/stops/:id", async (c) => {
	const rawAgency = c.req.query("agency");
	let agency: AgencyId | undefined;
	if (rawAgency) {
		if (!isAgencyId(rawAgency)) return c.json(agencyNotFound(rawAgency), 404);
		agency = rawAgency;
	}

	const hours = clampHours(
		c.req.query("hours") === undefined
			? undefined
			: Number(c.req.query("hours"))
	);
	const data = await getStopReliability(c.req.param("id"), agency, hours);

	if (!data) {
		return c.json(
			{
				error: {
					code: "STOP_NOT_FOUND",
					message: `No stop found with id '${c.req.param("id")}'`,
				},
			},
			404
		);
	}

	return c.json({ data });
});

/**
 * Service frequency for a date, from the timetable. A `route` narrows it to one
 * route's first departures; a `stop` counts every trip that calls there.
 *
 * `agency=bus` is the whole bus network: the six borough feeds merged, because
 * the bus tab covers every borough. A stop still needs one borough feed.
 */
analytics.get("/frequency", async (c) => {
	const agency = c.req.query("agency") ?? "";
	const isBus = agency === "bus";
	if (!isBus && !isAgencyId(agency)) return c.json(agencyNotFound(agency), 404);

	const date = c.req.query("date") ?? today();
	if (!isValidDate(date)) {
		return c.json(
			{
				error: {
					code: "INVALID_DATE",
					message: `'${date}' is not a YYYY-MM-DD date`,
				},
			},
			400
		);
	}

	const route = c.req.query("route") ?? undefined;
	const stopId = c.req.query("stop") ?? undefined;
	if (isBus) {
		if (stopId) {
			return c.json(
				{
					error: {
						code: "AGENCY_REQUIRED",
						message: "A stop needs the borough feed it belongs to",
					},
				},
				400
			);
		}

		return c.json({ data: await getBusFrequency(date, route) });
	}

	const data = await getFrequency({
		agency: isAgencyId(agency) ? agency : "subway",
		date,
		route,
		stopId,
	});

	if (!data) {
		return c.json(
			{
				error: {
					code: "STOP_NOT_FOUND",
					message: `No stop found with id '${c.req.query("stop") ?? ""}'`,
				},
			},
			404
		);
	}

	return c.json({ data });
});
