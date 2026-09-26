import type { ApiAlert } from "@/services/alerts";
import { getAlerts } from "@/services/alerts";
import { type ApiResponse } from "@/types/api";
import { optionalAgency } from "@/v1/middleware";
import { Hono } from "hono";

export const alerts = new Hono();

alerts.get("/", optionalAgency, async (c) => {
	const data = await getAlerts(c.get("agency"), c.req.query("route"));
	return c.json<ApiResponse<ApiAlert[]>>({ data });
});
