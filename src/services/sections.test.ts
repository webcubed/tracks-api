import type { Alignments } from "@/services/sections";
import assert from "node:assert/strict";
import { test } from "node:test";
import { getRailSections, sectionsFromElements } from "@/services/sections";

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
					geometry: [
						[-73.511, 40.6728],
						[-73.509, 40.6732],
					],
				},
				{
					name: "Wantagh Yard",
					kind: "track",
					location: { lat: 40.6729, lon: -73.51 },
					distance: 15,
					geometry: [
						[-73.5108, 40.6727],
						[-73.5088, 40.6731],
					],
				},
			],
			attribution: "© OpenStreetMap contributors",
			source: "openstreetmap-overpass",
		});
	};

	const sections = await getRailSections();
	assert.ok(requestedUrl.includes("latest-rail-sections/rail-sections.json"));
	// The full set, geometry included: the named label and the track rails
	// under it both survive the snapshot's validation.
	assert.deepEqual(sections, [
		{
			name: "Wantagh Yard",
			kind: "yard",
			location: { lat: 40.673, lon: -73.51 },
			distance: 15,
			geometry: [
				[-73.511, 40.6728],
				[-73.509, 40.6732],
			],
		},
		{
			name: "Wantagh Yard",
			kind: "track",
			location: { lat: 40.6729, lon: -73.51 },
			distance: 15,
			geometry: [
				[-73.5108, 40.6727],
				[-73.5088, 40.6731],
			],
		},
	]);
});

void test("overpass elements become labels and the rails under them", () => {
	// A slice of LIRR alignment through West Side Yard, as the shapes table
	// draws it: everything nearby belongs to the railroad.
	const lines: Alignments = {
		lirr: [
			[
				[-74.004, 40.754],
				[-74, 40.756],
			],
		],
		other: [],
	};
	const sections = sectionsFromElements(
		[
			// The named yard, mapped as a way. `out geom` sends no `center`, so
			// it stands at the middle of its own line.
			{
				type: "way",
				id: 1,
				tags: { railway: "yard", name: "West Side Yard" },
				geometry: [
					{ lat: 40.754, lon: -74.004 },
					{ lat: 40.756, lon: -74 },
				],
			},
			// An unnamed yard track under it: rails, not a label.
			{
				type: "way",
				id: 2,
				tags: { railway: "rail", service: "yard" },
				geometry: [
					{ lat: 40.7541, lon: -74.0039 },
					{ lat: 40.7559, lon: -73.9999 },
				],
			},
			// A signal box beside the yard's throat: a label without rails.
			{
				type: "node",
				id: 3,
				lat: 40.7551,
				lon: -74.0021,
				tags: { railway: "signal_box", name: "WSE" },
			},
			// A named siding far from any LIRR alignment: not ours.
			{
				type: "way",
				id: 4,
				tags: { railway: "siding", name: "Distant Siding" },
				geometry: [
					{ lat: 41.5, lon: -73 },
					{ lat: 41.501, lon: -72.999 },
				],
			},
		],
		lines
	);

	assert.equal(sections.length, 3);
	assert.ok(
		sections.every((section) => section.name !== "Distant Siding"),
		"features away from the railroad are dropped"
	);

	// Midpoints are averaged, so compare with float tolerance rather than
	// against a literal the arithmetic can only approach.
	const near = (actual: number | undefined, expected: number) => {
		assert.ok(
			actual !== undefined && Math.abs(actual - expected) < 1e-9,
			`${actual} is within 1e-9 of ${expected}`
		);
	};

	const yard = sections.find((section) => section.kind === "yard");
	near(yard?.location.lat, 40.755);
	near(yard?.location.lon, -74.002);
	assert.deepEqual(yard?.geometry, [
		[-74.004, 40.754],
		[-74, 40.756],
	]);

	const track = sections.find((section) => section.kind === "track");
	assert.equal(track?.name, "West Side Yard");
	assert.deepEqual(track?.geometry, [
		[-74.0039, 40.7541],
		[-73.9999, 40.7559],
	]);

	const box = sections.find((section) => section.kind === "signal_box");
	assert.equal(box?.name, "WSE");
	assert.equal(box?.geometry, undefined);
});
