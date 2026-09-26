import { isAgencyId } from "@/constants";
import { getFares } from "@/services/fares";
import { Hono } from "hono";

export const fares = new Hono();

fares.get("/", (c) => {
	const raw = c.req.query("agency");

	if (raw !== undefined && !isAgencyId(raw)) {
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

	return c.json({ data: getFares(raw) });
});
