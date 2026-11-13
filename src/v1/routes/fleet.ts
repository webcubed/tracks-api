import { getLirrFleet } from "@/services/fleet";
import { type ApiResponse } from "@/types/api";
import { Hono } from "hono";

export const fleet = new Hono();

/** Today's LIRR train-number roster, used by the URL-only fleet view. */
fleet.get("/", async (c) => {
	const data = await getLirrFleet();
	return c.json<ApiResponse<typeof data>>({ data });
});
