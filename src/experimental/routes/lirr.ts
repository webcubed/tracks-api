import { getRadarJson } from "@/experimental/services/production";
import { Hono } from "hono";

export const lirr = new Hono();

const RADAR_BASE = "https://backend-unified.mylirr.org";
function isStationCode(value: string): boolean {
	if (value.length !== 3) return false;

	for (const character of value) {
		if (!isStationCodeCharacter(character)) return false;
	}

	return true;
}

function isStationCodeCharacter(character: string): boolean {
	return (
		(character >= "A" && character <= "Z") ||
		(character >= "0" && character <= "9")
	);
}

lirr.get("/locations", async (c) => {
	const url = new URL(`${RADAR_BASE}/locations`);
	url.searchParams.set("railroad", c.req.query("railroad") ?? "LIRR");
	url.searchParams.set("geometry", c.req.query("geometry") ?? "TRACK_TURF");
	const data = await getRadarJson(url.toString());

	return c.json({ data, source: "mta-radar-locations", experimental: true });
});

lirr.get("/countdown/:station", async (c) => {
	const station = c.req.param("station").toUpperCase();
	if (!isStationCode(station)) {
		return c.json(
			{
				error: {
					code: "INVALID_STATION",
					message: "station must be a three-character station code",
				},
			},
			400
		);
	}

	const includePassed = c.req.query("include_passed");
	const hours = c.req.query("hours");
	if (
		includePassed === undefined ||
		!new Set(["true", "false"]).has(includePassed) ||
		!hours ||
		!Number.isFinite(Number(hours)) ||
		Number(hours) <= 0
	) {
		return c.json(
			{
				error: {
					code: "INVALID_COUNTDOWN_OPTIONS",
					message:
						"include_passed must be true or false and hours must be positive",
				},
			},
			400
		);
	}

	const url = new URL(`${RADAR_BASE}/countdown/${encodeURIComponent(station)}`);
	url.searchParams.set("include_passed", includePassed);
	url.searchParams.set("hours", hours);
	const data = await getRadarJson(url.toString());

	return c.json({ data, source: "mta-radar-countdown", experimental: true });
});

lirr.get("/solari/:station", async (c) => {
	const station = c.req.param("station").toUpperCase();
	if (!isStationCode(station)) {
		return c.json(
			{
				error: {
					code: "INVALID_STATION",
					message: "station must be a three-character station code",
				},
			},
			400
		);
	}

	const data = await getRadarJson(
		`${RADAR_BASE}/solari/${encodeURIComponent(station)}`
	);
	return c.json({ data, source: "mta-radar-solari", experimental: true });
});

lirr.get("/status", async (c) => {
	const data = await getRadarJson(`${RADAR_BASE}/status`);
	return c.json({ data, source: "mta-radar-status", experimental: true });
});

lirr.get("/health", async (c) => {
	const data = await getRadarJson(`${RADAR_BASE}/health`);
	return c.json({ data, source: "mta-radar-health", experimental: true });
});
