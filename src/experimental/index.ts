import { ExperimentalFeedError } from "@/experimental/services/production";
import { Hono } from "hono";
import { lirr } from "./routes/lirr";
import { nearby } from "./routes/nearby";
import { osm } from "./routes/osm";

export const experimental = new Hono();
experimental.route("/mta-info/nearby", nearby);
experimental.route("/mta-radar", lirr);
experimental.route("/osm", osm);

experimental.onError((error, c) => {
	if (error instanceof ExperimentalFeedError) {
		return c.json(
			{
				error: {
					code: "EXPERIMENTAL_FEED_UNAVAILABLE",
					message: error.message,
				},
				experimental: true,
			},
			502
		);
	}

	return c.json(
		{
			error: {
				code: "INTERNAL_ERROR",
				message: error instanceof Error ? error.message : String(error),
			},
			experimental: true,
		},
		500
	);
});
