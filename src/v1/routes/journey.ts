import { isAgencyId } from "@/constants";
import { planJourney } from "@/services/journey";
import { isoNewYork } from "@/services/realtime";
import { isValidDate, resolveStopIds, today } from "@/services/stops";
import { Hono } from "hono";

export const journey = new Hono();

journey.get("/", async (c) => {
	const fromId = c.req.query("from");
	if (!fromId) {
		return c.json(
			{
				error: {
					code: "MISSING_FROM",
					message: "Missing required query parameter 'from'",
				},
			},
			400
		);
	}

	const toId = c.req.query("to");
	if (!toId) {
		return c.json(
			{
				error: {
					code: "MISSING_TO",
					message: "Missing required query parameter 'to'",
				},
			},
			400
		);
	}

	const rawDate = c.req.query("date");
	const date = rawDate ?? today();
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

	const rawTime = c.req.query("time");
	const time = rawTime ?? nowClock();
	if (!isValidTime(time)) {
		return c.json(
			{
				error: {
					code: "INVALID_TIME",
					message: `Invalid time '${time}', expected HH:MM:SS`,
				},
			},
			400
		);
	}

	const fromAgency = c.req.query("fromAgency");
	if (fromAgency !== undefined && !isAgencyId(fromAgency)) {
		return c.json(
			{
				error: {
					code: "AGENCY_NOT_FOUND",
					message: `No agency found with id '${fromAgency}'`,
				},
			},
			404
		);
	}

	const toAgency = c.req.query("toAgency");
	if (toAgency !== undefined && !isAgencyId(toAgency)) {
		return c.json(
			{
				error: {
					code: "AGENCY_NOT_FOUND",
					message: `No agency found with id '${toAgency}'`,
				},
			},
			404
		);
	}

	const from = await resolveStopIds(fromId, fromAgency);
	if (!from) {
		return c.json(
			{
				error: {
					code: "STOP_NOT_FOUND",
					message: `No stop found with id '${fromId}'`,
				},
			},
			404
		);
	}

	const to = await resolveStopIds(toId, toAgency);
	if (!to) {
		return c.json(
			{
				error: {
					code: "STOP_NOT_FOUND",
					message: `No stop found with id '${toId}'`,
				},
			},
			404
		);
	}

	return c.json({ data: await planJourney(from, to, { date, time }) });
});

/** New York clock time right now, the timetable's own timezone. */
function nowClock(): string {
	return isoNewYork(Math.floor(Date.now() / 1000)).slice(11, 19);
}

/**
 * `HH:MM:SS` on a 24-hour clock, parsed by hand like `isValidDate`: the regex
 * flags xo asks for can't compile under `tsconfig`'s ES2017 target.
 */
function isValidTime(value: string): boolean {
	const parts = value.split(":");
	if (parts.length !== 3) return false;

	const [hours, minutes, seconds] = parts.map(Number);

	return (
		parts.every((part) => part.length === 2) &&
		Number.isInteger(hours) &&
		hours >= 0 &&
		hours <= 23 &&
		Number.isInteger(minutes) &&
		minutes <= 59 &&
		Number.isInteger(seconds) &&
		seconds <= 59
	);
}
