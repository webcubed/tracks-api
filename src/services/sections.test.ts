import assert from "node:assert/strict";
import { test } from "node:test";
import { getRailSections } from "@/services/sections";

void test("track sections load the published static snapshot", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});

	let requestedUrl = "";
	globalThis.fetch = async (input) => {
		requestedUrl =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		return Response.json({
			data: [
				{
					name: "Wantagh Yard",
					kind: "yard",
					location: { lat: 40.673, lon: -73.51 },
					distance: 15,
				},
			],
			attribution: "© OpenStreetMap contributors",
			source: "openstreetmap-overpass",
		});
	};

	const sections = await getRailSections();
	assert.ok(requestedUrl.includes("latest-rail-sections/rail-sections.json"));
	assert.deepEqual(sections, [
		{
			name: "Wantagh Yard",
			kind: "yard",
			location: { lat: 40.673, lon: -73.51 },
			distance: 15,
		},
	]);
});
