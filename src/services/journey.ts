import type { AgencyId } from "@/constants";
import type {
	ResolvedStopIds,
	Station,
	StopRef,
	TransferIndex,
} from "@/services/stops";
import { AGENCY_IDS, getStaticFeedUrl } from "@/constants";
import { distanceMeters } from "@/lib/geo";
import { runQuery } from "@/lib/parquet";
import { clockOf, clockSeconds } from "@/lib/time";
import {
	activeServices,
	directionIndex,
	getStations,
	getStopRef,
	stopIdsOf,
	transferIndex,
} from "@/services/stops";

export type JourneyLeg = {
	route: string;
	agency: string;
	headsign?: string;
	direction: string;
	tripId: string;
	from: { id: string; name: string; time: string };
	to: { id: string; name: string; time: string };
};

export type Journey = {
	departureTime: string;
	arrivalTime: string;
	durationMinutes: number;
	legs: JourneyLeg[];
};

export type ApiJourney = {
	from: { id: string; name: string };
	to: { id: string; name: string };
	date: string;
	time: string;
	itineraries: Journey[];
};

type TimelineRow = {
	trip_id: string;
	stop_id: string;
	arrival_time: string;
	departure_time: string;
	route_id: string;
	trip_headsign?: string;
	shape_id?: string;
};

type LegDesc = {
	agency: AgencyId;
	route: string;
	headsign?: string;
	tripId: string;
	shapeId?: string;
	boardStop: string;
	boardTime: string;
	alightStop: string;
	alightTime: string;
};

type Link =
	| { kind: "start" }
	| { kind: "walk"; from: Label }
	| { kind: "ride"; leg: LegDesc; from: Label };

/**
 * A way of standing at a station at a moment in time. `via.from` chains it up
 * to a complete itinerary.
 */
type Label = {
	feed: AgencyId;
	station: string;
	lat: number;
	lon: number;
	arrival: number;
	rides: number;
	round: number;
	via: Link;
};

type ItineraryDraft = {
	departure: number;
	arrival: number;
	legs: LegDesc[];
};

type Search = {
	labels: Map<string, Label[]>;
	walkQueue: Label[];
	grids: Map<AgencyId, Map<string, Station[]>>;
	stationsById: Map<AgencyId, Map<string, Station>>;
	transfers: Map<AgencyId, TransferIndex>;
	destKey: string;
};

const MAX_ITINERARIES = 5;
/** Most NYC trips take 2 or 3 rides; a 4th would double the per-round
 * stop_times scans for increasingly contrived chains. */
const MAX_RIDES = 3;
/** Interchange buffer when changing trips within one station. */
const TRANSFER_S = 60;
/** Cross-feed transfers are a walk. 500m covers the complexes GTFS pins
 * awkwardly (subway 34 St-Penn to LIRR Penn is 214m, GCT to Grand Central
 * Madison 418m, Atlantic Terminal/Barclays next to each other). */
const WALK_M = 500;
const WALK_S = 420;
/** How far past the frontier a round boards; overnight headways hit 20 min. */
const WINDOW_S = 7200;
/** Rides board on the rail feeds; every feed joins in through walk links. */
const RAIL_FEEDS: readonly AgencyId[] = ["subway", "lirr"];
/** ~330 m cells so a 500 m walk stays inside a 5x5 block of them. */
const CELL_DEGREES = 0.003;

/**
 * Earliest-arrival journeys on the static timetable: a round-based scan (one
 * round per ride, up to three rides), returning the best 5 by arrival.
 *
 * Transfers match at station level: the platforms of one station count as one
 * transfer point, and cross-feed transfers are stations within a short walk
 * (GTFS ships no cross-feed transfer table, and stop ids repeat across feeds,
 * so ids are never matched across feeds, only coordinates). honey: boarding
 * happens on subway and LIRR trips only. Bus stops join through the walk
 * links, so a bus stop can start or end a journey but a bus ride can't be a
 * leg; scan the bus feeds too if that request ever comes. A walk link is
 * never rendered as a leg; it shows as the station change between two legs.
 */
export async function planJourney(
	from: ResolvedStopIds,
	to: ResolvedStopIds,
	options: { date: string; time: string }
): Promise<ApiJourney> {
	const { date, time } = options;
	const base = {
		from: { id: from.stop.id, name: from.stop.name },
		to: { id: to.stop.id, name: to.stop.name },
		date,
		time,
	};

	// Already at the destination (or its platform across the same complex):
	// nothing sensible to plan, and the scan would happily ride one stop away
	// and come back for it.
	if (distanceMeters(from.stop.location, to.stop.location) < 100) {
		return { ...base, itineraries: [] };
	}

	const [network, transferIndexes] = await Promise.all([
		stationGrids(),
		Promise.all(AGENCY_IDS.map(async (feed) => transferIndex(feed))),
	]);
	const search: Search = {
		labels: new Map(),
		walkQueue: [],
		grids: network.grids,
		stationsById: network.byId,
		transfers: new Map(AGENCY_IDS.map((feed, i) => [feed, transferIndexes[i]])),
		destKey: `${to.agency}:${to.stop.id}`,
	};

	admit(search, {
		feed: from.agency,
		station: from.stop.id,
		lat: from.stop.location.lat,
		lon: from.stop.location.lon,
		arrival: clockSeconds(time),
		rides: 0,
		round: 0,
		via: { kind: "start" },
	});
	drainWalks(search);

	// Rounds must run in order: each one rides from the labels the previous
	// round produced, so the awaits are the algorithm.
	for (let round = 1; round <= MAX_RIDES; round++) {
		// eslint-disable-next-line no-await-in-loop
		const added = await boardRound(search, round, date);
		if (added === 0) break;
	}

	return {
		...base,
		itineraries: await renderItineraries(rankDestinations(search)),
	};
}

/**
 * Keep a label unless a station-mate dominates it: earlier arrival on no
 * more rides means being there earlier lets you board everything it can.
 * The destination is exempt: each arrival there is its own itinerary
 * (that's where "next 5 trains" come from).
 */
function admit(search: Search, label: Label): boolean {
	const key = `${label.feed}:${label.station}`;
	const existing = search.labels.get(key) ?? [];

	if (key !== search.destKey) {
		const dominated = existing.some(
			(other) => other.arrival <= label.arrival && other.rides <= label.rides
		);
		if (dominated) return false;
	}

	existing.push(label);
	search.labels.set(key, existing);
	search.walkQueue.push(label);

	return true;
}

function drainWalks(search: Search): void {
	let label = search.walkQueue.shift();
	while (label) {
		soakLabel(search, label);
		transferLabel(search, label);
		label = search.walkQueue.shift();
	}
}

/** Every cross-feed station within walking distance of `label` gains a label
 * for being reached on foot. Same-feed neighbours come from transfers.txt
 * instead: in-feed coordinates can't be trusted at station-complex level. */
function soakLabel(search: Search, label: Label): void {
	for (const [feed, grid] of search.grids) {
		if (feed === label.feed) continue;

		for (const station of near(grid, label)) {
			if (distanceMeters(label, station.location) > WALK_M) continue;

			admit(search, {
				feed,
				station: station.id,
				lat: station.location.lat,
				lon: station.location.lon,
				arrival: label.arrival + WALK_S,
				rides: label.rides,
				round: label.round,
				via: { kind: "walk", from: label },
			});
		}
	}
}

/** Same-feed in-complex transfers from transfers.txt (Times Sq's 127 to
 * R16/N/Q/R/W, Jamaica's coordinated LIRR interchanges). */
function transferLabel(search: Search, label: Label): void {
	const edges = search.transfers.get(label.feed)?.get(label.station);
	if (!edges) return;

	for (const [station, seconds] of edges) {
		const target = search.stationsById.get(label.feed)?.get(station);
		if (!target) continue;

		admit(search, {
			feed: label.feed,
			station: target.id,
			lat: target.location.lat,
			lon: target.location.lon,
			arrival: label.arrival + Math.max(seconds, TRANSFER_S),
			rides: label.rides,
			round: label.round,
			via: { kind: "walk", from: label },
		});
	}
}

/**
 * Board the rail feeds from every frontier label (those carrying exactly
 * `round - 1` rides): fetch the timelines of trips they can catch and ride
 * each one forward, admitting labels at every stop it makes.
 */
async function boardRound(
	search: Search,
	round: number,
	date: string
): Promise<number> {
	const hasFrontier = [...search.labels.values()]
		.flat()
		.some((label) => label.rides === round - 1);
	if (!hasFrontier) return 0;

	let added = 0;
	// Feeds run sequentially: both mutate the shared label set, and parallel
	// scans of the same frontier would race the walk queue.
	for (const feed of RAIL_FEEDS) {
		// eslint-disable-next-line no-await-in-loop
		added += await boardFeed(search, feed, round, date);
	}

	drainWalks(search);

	return added;
}

const frontierFor = (search: Search, feed: AgencyId, round: number): Label[] =>
	[...search.labels.values()]
		.flat()
		.filter((label) => label.feed === feed && label.rides === round - 1);

async function boardFeed(
	search: Search,
	feed: AgencyId,
	round: number,
	date: string
): Promise<number> {
	const frontierInFeed = frontierFor(search, feed, round);
	if (frontierInFeed.length === 0) return 0;

	const byStation = new Map<string, Label[]>();
	for (const label of frontierInFeed) {
		const existing = byStation.get(label.station);
		if (existing) existing.push(label);
		else byStation.set(label.station, [label]);
	}

	const earliest = Math.min(...frontierInFeed.map((label) => label.arrival));
	const stationLists = await Promise.all(
		[...byStation.keys()].map(async (id) => stopIdsOf(feed, id))
	);
	const ids = stationLists.flat();

	const trips = await timelines(feed, ids, activeServices(feed, date), {
		min: Math.max(0, earliest - TRANSFER_S),
		max: earliest + WINDOW_S,
	});
	const stationOf = await stationIndexByStop(feed, trips);

	let added = 0;
	for (const rows of trips.values()) {
		added += rideTrip(search, { feed, rows, byStation, stationOf, round });
	}

	return added;
}

type RideScan = {
	feed: AgencyId;
	rows: TimelineRow[];
	byStation: Map<string, Label[]>;
	stationOf: Map<string, StopRef | undefined>;
	round: number;
};

/**
 * One trip: board at the first stop a frontier label can catch, then drop a
 * label at every stop it makes after that. Boarding earlier always dominates
 * boarding later on the same trip.
 */
function rideTrip(search: Search, scan: RideScan): number {
	const { feed, rows, byStation, stationOf, round } = scan;
	let board = -1;
	let boardLabel: Label | undefined;

	for (const [i, row] of rows.entries()) {
		if (row.departure_time === "") continue;

		const ref = stationOf.get(row.stop_id);
		if (!ref) continue;

		const departure = clockSeconds(row.departure_time);
		boardLabel = byStation
			.get(ref.id)
			?.filter((label) => departure - transferBuffer(label) >= label.arrival)
			.toSorted((a, b) => a.arrival - b.arrival || a.rides - b.rides)[0];

		if (boardLabel) {
			board = i;
			break;
		}
	}

	if (boardLabel === undefined) return 0;

	const boardRow = rows[board];
	let added = 0;

	for (const row of rows.slice(board + 1)) {
		if (row.arrival_time === "") continue;

		const ref = stationOf.get(row.stop_id);
		if (!ref?.location) continue;

		const accepted = admit(search, {
			feed,
			station: ref.id,
			lat: ref.location.lat,
			lon: ref.location.lon,
			arrival: clockSeconds(row.arrival_time),
			rides: round,
			round,
			via: {
				kind: "ride",
				leg: {
					agency: feed,
					route: row.route_id,
					headsign: row.trip_headsign ?? undefined,
					tripId: row.trip_id,
					shapeId: row.shape_id,
					boardStop: boardRow.stop_id,
					boardTime: boardRow.departure_time,
					alightStop: row.stop_id,
					alightTime: row.arrival_time,
				},
				from: boardLabel,
			},
		});

		if (accepted) added++;
	}

	return added;
}

/** Boarding requires a minute when the label came from another ride. */
function transferBuffer(label: Label): number {
	return label.via.kind === "ride" ? TRANSFER_S : 0;
}

/** Destination labels become drafts, ranked by arrival. A label reached by
 * walking only matters when no ride reaches the destination: a trailing
 * transfer hop after the train already arrived is noise. */
function rankDestinations(search: Search): ItineraryDraft[] {
	const dest = search.labels.get(search.destKey) ?? [];
	const byArrival = dest.toSorted((a, b) => a.arrival - b.arrival);
	const rideArrivals = byArrival.filter((label) => label.via.kind === "ride");
	const ranked = rideArrivals.length > 0 ? rideArrivals : byArrival;
	const seen = new Set<string>();
	const drafts: ItineraryDraft[] = [];

	for (const label of ranked) {
		const draft = itineraryFrom(search, label);
		if (!draft || draft.legs.length === 0) continue;

		const fingerprint = `${label.arrival}|${draft.legs.at(-1)?.tripId ?? ""}`;
		if (seen.has(fingerprint)) continue;

		seen.add(fingerprint);
		drafts.push(draft);
		if (drafts.length === MAX_ITINERARIES) break;
	}

	return drafts;
}

/**
 * Walk a destination label back to the start. Walking stays implicit: when
 * the chain leads with a walk, the journey departs at the query time (you can
 * leave now); from a direct ride it departs at the boarding time.
 */
function itineraryFrom(
	search: Search,
	dest: Label
): ItineraryDraft | undefined {
	const steps: Label[] = [];
	let current: Label = dest;

	while (current.via.kind !== "start") {
		steps.push(current);
		current = current.via.from;
	}

	if (steps.length === 0) return undefined;

	const ordered = steps.toReversed();
	const legs: LegDesc[] = [];

	for (const step of ordered) {
		if (step.via.kind === "ride") legs.push(step.via.leg);
	}

	if (legs.length === 0) return undefined;

	const departure =
		ordered[0]?.via.kind === "walk"
			? ordered[0].arrival - WALK_S
			: clockSeconds(legs[0].boardTime);

	return { departure, arrival: dest.arrival, legs };
}

async function renderItineraries(drafts: ItineraryDraft[]): Promise<Journey[]> {
	const rendered = await Promise.all(
		drafts.map(async (draft) => ({
			...draft,
			legs: await Promise.all(draft.legs.map(async (leg) => renderLeg(leg))),
		}))
	);

	return rendered.map((draft) => ({
		departureTime: clockOf(draft.departure),
		arrivalTime: clockOf(draft.arrival),
		durationMinutes: Math.round((draft.arrival - draft.departure) / 60),
		legs: draft.legs,
	}));
}

/**
 * Full stop-by-stop timelines of every active trip boardable from `stopIds`
 * inside the departure window; rows come back grouped by trip, in stop order.
 */
async function timelines(
	agency: AgencyId,
	stopIds: readonly string[],
	service: { sql: string; parameters: string[] },
	window: { min: number; max: number }
): Promise<Map<string, TimelineRow[]>> {
	const stopTimesUrl = getStaticFeedUrl(agency, "stop_times");
	const tripsUrl = getStaticFeedUrl(agency, "trips");

	const rows = await runQuery<TimelineRow>(
		`SELECT st.trip_id, st.stop_id, st.arrival_time, st.departure_time,
			t.route_id, t.trip_headsign, t.shape_id
		 FROM read_parquet('${stopTimesUrl}') st
		 JOIN read_parquet('${tripsUrl}') t ON t.trip_id = st.trip_id
		 WHERE st.trip_id IN (
			 SELECT s.trip_id FROM read_parquet('${stopTimesUrl}') s
			 JOIN read_parquet('${tripsUrl}') t2 ON t2.trip_id = s.trip_id
			 WHERE s.stop_id IN (${stopIds.map(() => "?").join(", ")})
			   AND s.departure_time >= ? AND s.departure_time <= ?
			   AND t2.service_id IN (${service.sql})
		 )
		 ORDER BY st.trip_id, CAST(st.stop_sequence AS INTEGER)`,
		...stopIds,
		clockOf(window.min),
		clockOf(window.max),
		...service.parameters
	);

	const trips = new Map<string, TimelineRow[]>();
	for (const row of rows) {
		let timeline = trips.get(row.trip_id);
		if (!timeline) {
			timeline = [];
			trips.set(row.trip_id, timeline);
		}

		timeline.push(row);
	}

	return trips;
}

/** Platform rows to the station they belong to, resolved in one batch. */
async function stationIndexByStop(
	agency: AgencyId,
	legs: Map<string, TimelineRow[]>
): Promise<Map<string, StopRef | undefined>> {
	const stopIds = [
		...new Set([...legs.values()].flat().map((row) => row.stop_id)),
	];
	const refs = await Promise.all(
		stopIds.map(async (stopId) => getStopRef(agency, stopId))
	);

	const stations = new Map<string, StopRef | undefined>();
	for (const [i, stopId] of stopIds.entries()) stations.set(stopId, refs[i]);

	return stations;
}

type Network = {
	grids: Map<AgencyId, Map<string, Station[]>>;
	byId: Map<AgencyId, Map<string, Station>>;
};

/**
 * All feeds' stations in coarse spatial grids plus an id index, so walking
 * transfers are local lookups instead of all-pairs scans.
 */
async function stationGrids(): Promise<Network> {
	const stationsPerFeed = await Promise.all(
		AGENCY_IDS.map(async (feed) => getStations(feed))
	);
	const grids = new Map<AgencyId, Map<string, Station[]>>();
	const byId = new Map<AgencyId, Map<string, Station>>();

	for (const [i, feed] of AGENCY_IDS.entries()) {
		const grid = new Map<string, Station[]>();
		const idIndex = new Map<string, Station>();

		for (const station of stationsPerFeed[i]) {
			const key = cellKey(station.location);
			const cell = grid.get(key);
			if (cell) cell.push(station);
			else grid.set(key, [station]);
			idIndex.set(station.id, station);
		}

		grids.set(feed, grid);
		byId.set(feed, idIndex);
	}

	return { grids, byId };
}

function cellKey(point: { lat: number; lon: number }): string {
	return `${Math.floor(point.lat / CELL_DEGREES)}:${Math.floor(point.lon / CELL_DEGREES)}`;
}

/** Candidates from the 5x5 cells around a point, filtered by real distance. */
function near(grid: Map<string, Station[]>, label: Label): Station[] {
	const row = Math.floor(label.lat / CELL_DEGREES);
	const column = Math.floor(label.lon / CELL_DEGREES);
	const found: Station[] = [];

	for (let r = row - 2; r <= row + 2; r++) {
		for (let c = column - 2; c <= column + 2; c++) {
			found.push(...(grid.get(`${r}:${c}`) ?? []));
		}
	}

	return found;
}

async function renderLeg(leg: LegDesc): Promise<JourneyLeg> {
	const [fromRef, toRef, directions] = await Promise.all([
		getStopRef(leg.agency, leg.boardStop),
		getStopRef(leg.agency, leg.alightStop),
		directionIndex(leg.agency),
	]);

	return {
		route: leg.route,
		agency: leg.agency,
		headsign: leg.headsign,
		direction: directions.get(leg.shapeId ?? "") ?? "",
		tripId: leg.tripId,
		from: {
			id: fromRef?.id ?? leg.boardStop,
			name: fromRef?.name ?? "",
			time: leg.boardTime,
		},
		to: {
			id: toRef?.id ?? leg.alightStop,
			name: toRef?.name ?? "",
			time: leg.alightTime,
		},
	};
}
