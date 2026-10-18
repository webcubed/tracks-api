import type { JourneyMode, JourneyPreference } from "@/services/journey";
import { isAgencyId } from "@/constants";
import { isValidDate, today } from "@/lib/time";
import { planJourney } from "@/services/journey";
import { isoNewYork } from "@/services/realtime";
import { resolveJourneyStopIds } from "@/services/stops";
import { Hono } from "hono";

export const journey = new Hono();

function isPreference(value: string): value is JourneyPreference {
	return (
		value === "fastest" || value === "fewerTransfers" || value === "lessWalking"
	);
}

function isJourneyMode(value: string): value is JourneyMode {
	return value === "subway" || value === "rail" || value === "bus";
}

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

	const rawPreference = c.req.query("preference");
	const preference: JourneyPreference =
		rawPreference === undefined
			? "fastest"
			: isPreference(rawPreference)
				? rawPreference
				: "fastest";
	if (rawPreference !== undefined && !isPreference(rawPreference)) {
		return c.json(
			{
				error: {
					code: "INVALID_PREFERENCE",
					message:
						"preference must be 'fastest', 'fewerTransfers', or 'lessWalking'",
				},
			},
			400
		);
	}

	const rawModes = c.req.query("modes");
	let modes: Set<JourneyMode> | undefined;
	if (rawModes !== undefined && rawModes.trim() !== "") {
		const parts = rawModes
			.split(",")
			.map((part) => part.trim().toLowerCase())
			.filter(Boolean);
		if (!parts.every((part) => isJourneyMode(part))) {
			return c.json(
				{
					error: {
						code: "INVALID_MODES",
						message:
							"modes must be a comma-separated list of subway, rail, bus",
					},
				},
				400
			);
		}

		modes = new Set(parts);
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

	const from = await resolveJourneyStopIds(fromId, fromAgency);
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

	const to = await resolveJourneyStopIds(toId, toAgency);
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

	return c.json({
		data: await planJourney(from, to, { date, time, preference, modes }),
	});
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
