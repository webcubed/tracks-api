import { getRailSections } from "@/services/sections";
import { Hono } from "hono";

export const osm = new Hono();

/**
 * Named LIRR track sections — yards, junctions, crossovers and signal boxes —
 * read from OpenStreetMap. The MTA's own feeds do not carry them with
 * coordinates, so this is the only way to put them on a map.
 */
osm.get("/sections", async (c) => {
	try {
		const data = await getRailSections();

		return c.json({
			data,
			attribution: "© OpenStreetMap contributors",
			source: "openstreetmap-overpass",
			experimental: true,
		});
	} catch (error) {
		// A mirror being rate-limited or down is expected rather than
		// exceptional: answer with an empty set and the reason, so a map can draw
		// no labels instead of surfacing a failure to a reader who did not ask
		// for labels in the first place.
		return c.json(
			{
				data: [],
				error: error instanceof Error ? error.message : String(error),
				attribution: "© OpenStreetMap contributors",
				source: "openstreetmap-overpass",
				experimental: true,
			},
			503
		);
	}
});
