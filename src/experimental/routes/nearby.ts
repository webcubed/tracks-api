import { getProductionJson } from "@/experimental/services/production";
import { Hono } from "hono";

export const nearby = new Hono();

const NEARBY_URL =
	"https://otp-mta-prod.camsys-apps.com/otp/routers/default/nearby";
const VALID_MODES = new Set(["", "SUBWAY", "RAIL", "BUS"]);

nearby.get("/", async (c) => {
	const lat = c.req.query("lat");
	const lon = c.req.query("lon");
	const radius = c.req.query("radius");
	const stops = c.req.query("stops");
	const mode = c.req.query("mode") ?? "";
	const timeRange = c.req.query("timeRange");
	const apikey = process.env.MTA_NEARBY_API_KEY;

	if (!VALID_MODES.has(mode)) {
		return c.json(
			{
				error: {
					code: "INVALID_MODE",
					message: "mode must be SUBWAY, RAIL, or BUS",
				},
			},
			400
		);
	}

	const parameters = new URLSearchParams({ mode });
	if (apikey) parameters.set("apikey", apikey);
	if (timeRange !== undefined) parameters.set("timeRange", timeRange);

	if (stops === undefined) {
		if (lat === undefined || lon === undefined || radius === undefined) {
			return c.json(
				{
					error: {
						code: "INVALID_LOCATION",
						message:
							"lat, lon, and radius are required when stops is not provided",
					},
				},
				400
			);
		}

		const latitude = Number(lat);
		const longitude = Number(lon);
		const searchRadius = Number(radius);
		if (
			!Number.isFinite(latitude) ||
			Math.abs(latitude) > 90 ||
			!Number.isFinite(longitude) ||
			Math.abs(longitude) > 180 ||
			!Number.isFinite(searchRadius) ||
			searchRadius <= 0
		) {
			return c.json(
				{
					error: {
						code: "INVALID_LOCATION",
						message:
							"lat and lon must be valid coordinates and radius must be positive",
					},
				},
				400
			);
		}

		parameters.set("lat", lat);
		parameters.set("lon", lon);
		parameters.set("radius", radius);
	} else {
		if (stops.trim() === "") {
			return c.json(
				{
					error: {
						code: "INVALID_STOPS",
						message: "stops must contain one or more MODE:StopID values",
					},
				},
				400
			);
		}

		parameters.set("stops", stops);
	}

	const url = `${NEARBY_URL}?${parameters.toString()}`;
	const data = await getProductionJson(url);
	return c.json({ data, source: "mta-otp-nearby", experimental: true });
});
