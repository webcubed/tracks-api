import type { SectionEvent, SectionStop } from "@/services/trackSections";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	matchRadarTrain,
	sectionFromEvents,
	sectionFromStops,
	trainSegments,
} from "@/services/trackSections";

type Point = { track?: string; time?: number; departed?: boolean };

function event(code: string, passed: boolean, point: Point = {}): SectionEvent {
	return {
		code,
		name: code,
		passed,
		...(point.track ? { track: point.track } : {}),
		...(point.time === undefined ? {} : { time: point.time }),
		...(point.departed === undefined ? {} : { departed: point.departed }),
	};
}

void test("the section runs from the last passed point to the next ahead", () => {
	const section = sectionFromEvents([
		event("WSY", true, { track: "PS", time: 100, departed: true }),
		event("WSE", true, { track: "W2", time: 160 }),
		event("PSW", false, { track: "16", time: 220 }),
		event("NYK", false, { track: "16", time: 300 }),
	]);

	assert.deepEqual(section, {
		track: "W2",
		from: { code: "WSE", name: "WSE", time: 160 },
		to: { code: "PSW", name: "PSW", time: 220 },
	});
});

void test("an unrecorded point before the train is history noise, not the section ahead", () => {
	const section = sectionFromEvents([
		event("GCW", false, { track: "U3", time: 100 }),
		event("GCT", true, { track: "U3", time: 160, departed: true }),
		event("GCE", false, { track: "E4", time: 200 }),
	]);

	assert.deepEqual(section, {
		track: "E4",
		from: { code: "GCT", name: "GCT", time: 160 },
		to: { code: "GCE", name: "GCE", time: 200 },
	});
});

void test("a train sitting at a point is labelled with that point's own track", () => {
	const section = sectionFromEvents([
		event("WSY", true, { track: "W2", time: 100 }),
		event("WSE", false, { track: "16", time: 160 }),
	]);

	assert.deepEqual(section, {
		track: "W2",
		from: { code: "WSY", name: "WSY", time: 100 },
		to: { code: "WSE", name: "WSE", time: 160 },
	});
});

void test("a train that has not moved names its yard section from its first point", () => {
	const section = sectionFromEvents([
		event("WSY", false, { track: "PS", time: 100 }),
		event("WSE", false, { track: "W2", time: 160 }),
	]);

	assert.deepEqual(section, {
		track: "PS",
		to: { code: "WSY", name: "WSY", time: 100 },
	});
});

void test("the track of the point behind stands in when the one ahead has none", () => {
	const section = sectionFromEvents([
		event("WMR", true, { track: "F2", time: 100 }),
		event("CHT", false, { time: 300 }),
	]);

	assert.deepEqual(section, {
		track: "F2",
		from: { code: "WMR", name: "WMR", time: 100 },
		to: { code: "CHT", name: "CHT", time: 300 },
	});
});

function stop(
	code: string,
	passed: boolean,
	point: Point & { signTrack?: string } = {}
): SectionStop {
	return {
		code,
		passed,
		...(point.track ? { sectionTrack: point.track } : {}),
		...(point.signTrack ? { signTrack: point.signTrack } : {}),
		...(point.time === undefined ? {} : { time: point.time }),
		...(point.departed === undefined ? {} : { departed: point.departed }),
	};
}

void test("stop lists give the same section with the section's own track designations", () => {
	const standing = sectionFromStops(
		[
			stop("JAM", true, { track: "R8", signTrack: "4" }),
			stop("BTA", false, { track: "R2", signTrack: "2" }),
		],
		"JAM"
	);

	assert.deepEqual(standing, {
		track: "R8",
		from: { code: "JAM", name: "JAM" },
		to: { code: "BTA", name: "BTA" },
	});

	const moving = sectionFromStops(
		[
			stop("JAM", true, { track: "R8", signTrack: "4", departed: true }),
			stop("BTA", false, { track: "R2", signTrack: "2" }),
		],
		"JAM"
	);

	assert.deepEqual(moving, {
		track: "R2",
		from: { code: "JAM", name: "JAM" },
		to: { code: "BTA", name: "BTA" },
	});
});

void test("a train before any stop is placed by the tracking system's own location code", () => {
	const section = sectionFromStops(
		[stop("NYK", false, { track: "16", signTrack: "16" })],
		"WSE"
	);

	assert.deepEqual(section, {
		track: "16",
		from: { code: "WSE", name: "WSE" },
		to: { code: "NYK", name: "NYK" },
	});
});

void test("a posted platform track stands in when the stop lists no section track", () => {
	const section = sectionFromStops(
		[stop("NYK", false, { signTrack: "16" })],
		"PSW"
	);

	assert.deepEqual(section, {
		track: "16",
		from: { code: "PSW", name: "PSW" },
		to: { code: "NYK", name: "NYK" },
	});
});

void test("a vehicle id names its run as one of its segments", () => {
	const trains = new Map([
		["8758", { train: "8758" }],
		["2953", { train: "2953" }],
		["RA2KOX", { train: "RA2KOX" }],
	]);

	assert.equal(matchRadarTrain("GO202_26_8758_1_V", trains)?.train, "8758");
	assert.equal(matchRadarTrain("GO202_26_2953_METS_V", trains)?.train, "2953");
	assert.equal(matchRadarTrain("GO202_26_RA2KOX_V", trains)?.train, "RA2KOX");
	// `GO202` and `26` are the move's date fragments, never a run number.
	assert.equal(matchRadarTrain("GO202_26_6760_V", trains), undefined);
	assert.deepEqual(trainSegments("GO202_26_8758_1_V"), [
		"GO202",
		"26",
		"8758",
		"1",
		"V",
	]);
});
