import type { ApiAgency } from "@/services/agencies";
import { getAgencies, getAgency } from "@/services/agencies";
import { type ApiResponse } from "@/types/api";
import { Hono } from "hono";

export const agencies = new Hono();

agencies.get("/", async (c) => {
	const data = await getAgencies();
	return c.json({ data });
});

agencies.get("/:id", async (c) => {
	const id = c.req.param("id");
	const agency = await getAgency(id);

	if (!agency) {
		return c.json(
			{
				error: {
					code: "AGENCY_NOT_FOUND",
					message: `No agency found with id '${id}'`,
				},
			},
			404
		);
	}

	return c.json<ApiResponse<ApiAgency>>({ data: agency });
});
