import { getRoute, getRoutes } from "@/services/routes";
import { requireAgency } from "@/v1/middleware";
import { Hono } from "hono";

export const routes = new Hono();

routes.get("/", requireAgency, async (c) => {
	const data = await getRoutes(c.get("agency"));
	return c.json({ data });
});

routes.get("/:id", requireAgency, async (c) => {
	const id = c.req.param("id");
	const route = await getRoute(c.get("agency"), id);

	if (!route) {
		return c.json(
			{
				error: {
					code: "ROUTE_NOT_FOUND",
					message: `No route found with id '${id}'`,
				},
			},
			404
		);
	}

	return c.json({ data: route });
});
