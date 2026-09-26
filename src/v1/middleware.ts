import type { AgencyId } from "@/constants";
import { isAgencyId } from "@/constants";
import { createMiddleware } from "hono/factory";

/**
 * Requires `?agency=<feed id>` and exposes it as `c.get("agency")`.
 *
 * Feed ids are the keys of `AGENCIES` (`subway`, `lirr`, `bus_bx`, …), never
 * the GTFS `agency_id` values that live in the parquet `agency` table.
 */
export const requireAgency = createMiddleware<{
	Variables: { agency: AgencyId };
}>(async (c, next) => {
	const agency = c.req.query("agency");

	if (!agency) {
		return c.json(
			{
				error: {
					code: "MISSING_AGENCY",
					message: "Missing required query parameter 'agency'",
				},
			},
			400
		);
	}

	if (!isAgencyId(agency)) {
		return c.json(
			{
				error: {
					code: "AGENCY_NOT_FOUND",
					message: `No agency found with id '${agency}'`,
				},
			},
			404
		);
	}

	c.set("agency", agency);
	return next();
});
