import type { AgencyId } from "@/constants";
import { isAgencyId } from "@/constants";
import { getStop, getStops } from "@/services/stops";
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
