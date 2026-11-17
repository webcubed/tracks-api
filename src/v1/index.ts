import { FeedError } from "@/services/realtime";
import { Hono } from "hono";
import { agencies } from "./routes/agencies";
import { alerts } from "./routes/alerts";
import { arrivals } from "./routes/arrivals";
import { fares } from "./routes/fares";
import { journey } from "./routes/journey";
import { routes } from "./routes/routes";
import { stops } from "./routes/stops";
import { vehicles } from "./routes/vehicles";

export const v1 = new Hono();
v1.route("/agencies", agencies);
v1.route("/routes", routes);
v1.route("/stops", stops);
v1.route("/arrivals", arrivals);
v1.route("/vehicles", vehicles);
v1.route("/alerts", alerts);
v1.route("/fares", fares);
v1.route("/journey", journey);

/** A dead real-time upstream is 502; anything else is a bug. The envelope
 * stays intact either way. */
v1.onError((error, c) => {
	const feed = error instanceof FeedError;

	return c.json(
		{
			error: {
				code: feed ? "FEED_UNAVAILABLE" : "INTERNAL_ERROR",
				message: error instanceof Error ? error.message : String(error),
			},
		},
		feed ? 502 : 500
	);
});
