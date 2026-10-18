import type { Label, Search } from "@/services/journey/types";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENCY_IDS } from "@/constants";
import { admit } from "@/services/journey/labels";

function searchAt(station: string): Search {
	return {
		labels: new Map(),
		walkQueue: [],
		grids: new Map(),
		stationsById: new Map(),
		transfers: new Map(),
		destKey: `subway:${station}-destination`,
		destLocation: { lat: 40.75, lon: -73.99 },
		allowedFeeds: new Set(AGENCY_IDS),
	};
}

function label(
	station: string,
	pattern: string,
	arrival: number,
	rides = 1
): Label {
	return {
		feed: "subway",
		station,
		lat: 40.75,
		lon: -73.99,
		arrival,
		rides,
		walkSeconds: 0,
		walkMeters: 0,
		pattern,
		round: rides,
		via: { kind: "start" },
	};
}

void test("an earlier LIRR approach does not erase the bus route pattern", () => {
	const search = searchAt("times-square");
	const lirr = label("times-square", "lirr:9|subway:GS", 1000, 2);
	const bus = label("times-square", "bus_busco:Q28|subway:7", 1100, 2);

	assert.equal(admit(search, lirr), true);
	assert.equal(admit(search, bus), true);
	assert.deepEqual(
		search.labels.get("subway:times-square")?.map((item) => item.pattern),
		["lirr:9|subway:GS", "bus_busco:Q28|subway:7"]
	);
});

void test("a later label on the same route pattern is dominated", () => {
	const search = searchAt("times-square");
	assert.equal(
		admit(search, label("times-square", "lirr:9|subway:1", 1000, 2)),
		true
	);
	assert.equal(
		admit(search, label("times-square", "lirr:9|subway:1", 1100, 2)),
		false
	);
});
