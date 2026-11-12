import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENCY_IDS } from "@/constants";
import { RIDE_FEEDS, rideFeedsFor } from "@/services/journey/types";

void test("deselected networks cannot board even at an endpoint", () => {
	const feeds = rideFeedsFor(new Set(["subway", "bus"]));

	assert.ok(feeds.includes("subway"));
	assert.ok(feeds.includes("bus_q"));
	assert.ok(!feeds.includes("lirr"));
});

void test("no mode filter allows every ride feed", () => {
	assert.deepEqual(rideFeedsFor(), RIDE_FEEDS);
	assert.deepEqual(rideFeedsFor(new Set()), AGENCY_IDS);
});

void test("a single mode keeps only its feeds", () => {
	assert.deepEqual(rideFeedsFor(new Set(["rail"])), ["lirr"]);
});
