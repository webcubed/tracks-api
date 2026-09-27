import assert from "node:assert/strict";
import { test } from "node:test";
import { lirr } from "./lirr";

void test("Radar countdown requests API version 3.0 and returns the train events", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});

	const upstreamTrain = {
		train_id: "LIRR_2026-09-26_7990",
		train_num: "7990",
		details: {
			headsign: "Ronkonkoma",
			stops: [{ code: "NYK", sign_track: "13", posted: true }],
			events: [
				{
					code: "NYK",
					stop_type: "STOP",
					sched_time: 1_790_474_100,
					sched_track: "19",
					act_track: "13",
				},
			],
		},
	};
	let requestedUrl = "";
	let requestedVersion: string | undefined;
	globalThis.fetch = async (input, init) => {
		requestedUrl =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		requestedVersion =
			new Headers(init?.headers).get("Accept-Version") ?? undefined;
		return Response.json([upstreamTrain]);
	};

	const response = await lirr.request(
		"/countdown/NYK?include_passed=false&hours=1.0"
	);
	assert.equal(response.status, 200);
	assert.equal(
		requestedUrl,
		"https://backend-unified.mylirr.org/countdown/NYK?include_passed=false&hours=1.0"
	);
	assert.equal(requestedVersion, "3.0");
	assert.deepEqual(await response.json(), {
		data: [upstreamTrain],
		source: "mta-radar-countdown",
		experimental: true,
	});
});
