import type { AgencyId } from "@/constants";
import type { ResolvedStopIds, StopRef } from "@/services/stops";
import { getStaticFeedUrl } from "@/constants";
import { distanceMeters } from "@/lib/geo";
import { runQuery } from "@/lib/parquet";
import { clockOf, clockSeconds } from "@/lib/time";
import {
	activeServices,
	directionIndex,
	getStations,
	getStopRef,
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

type Ride = {
	agency: AgencyId;
	rows: TimelineRow[];
	from: number;
	to: number;
};

type Candidate = {
	departure: number;
	arrival: number;
	first: Ride;
	second?: Ride;
};

const MAX_ITINERARIES = 5;
const SAME_STATION_TRANSFER_S = 60;
const WALK_TRANSFER_S = 420;
/**
 * Cross-feed transfers are a walk. 500m covers the complexes GTFS pins
 * awkwardly (subway 34 St-Penn to LIRR Penn is 214m, GCT to Grand Central
 * Madison 418m, Atlantic Terminal/Barclays next to each other), and is still
 * a sane bus-stop walk.
 */
const WALK_MAX_M = 500;

/**
 * Earliest-arrival journeys on the static timetable: direct rides plus
 * one-transfer combinations, ranked by arrival, best 5 kept.
 *
 * Transfers match at station level: the platforms of one station count as
 * one transfer point, and cross-feed transfers are stations within a short
 * walk (GTFS has no cross-feed transfer table, and that walk is what makes a
 * journey multi-modal). honey: two legs max; a round-based scan (RAPTOR)
 * is the revisit point if 3-leg trips become a real request.
 */
export async function planJourney(
	from: ResolvedStopIds,
	to: ResolvedStopIds,
	options: { date: string; time: string }
): Promise<ApiJourney> {
	const { date, time } = options;
	const fromIds = new Set(from.ids);
	const toIds = new Set(to.ids);
	const sameFeed = from.agency === to.agency;

	// Already at the destination (or its platform across the same complex):
	// nothing sensible to plan, and the pairing below would happily ride one
	// stop away and come back for it.
	if (sameFeed && distanceMeters(from.stop.location, to.stop.location) < 100) {
		return {
			from: { id: from.stop.id, name: from.stop.name },
			to: { id: to.stop.id, name: to.stop.name },
			date,
			time,
			itineraries: [],
		};
	}

	const [leg1, leg2, stationsB] = await Promise.all([
		timelines(from.agency, from.ids, activeServices(from.agency, date), time),
		timelines(to.agency, to.ids, activeServices(to.agency, date)),
		getStations(to.agency),
	]);

	const stationOf1 = await stationIndexByStop(from.agency, leg1);
	const stationOf2 = await stationIndexByStop(to.agency, leg2);
	const originsByStation = collectOrigins(leg2, toIds, stationOf2);
	const transferTargets = memoizedTargets(stationsB, sameFeed);
	const candidates = new Map<string, Candidate>();

	const addDirect = (rows1: TimelineRow[], boardIdx: number): void => {
		const exitIdx = rows1.findIndex(
			(row, i) => i > boardIdx && toIds.has(row.stop_id)
		);
		if (exitIdx === -1 || rows1[exitIdx].arrival_time === "") return;

		keepBest(candidates, `d:${rows1[0].trip_id}`, {
			departure: clockSeconds(rows1[boardIdx].departure_time),
			arrival: clockSeconds(rows1[exitIdx].arrival_time),
			first: { agency: from.agency, rows: rows1, from: boardIdx, to: exitIdx },
		});
	};

	const addTransfers = (rows1: TimelineRow[], boardIdx: number): void => {
		const departure = clockSeconds(rows1[boardIdx].departure_time);

		for (let i = boardIdx + 1; i < rows1.length; i++) {
			if (rows1[i].arrival_time === "") continue;

			const station = stationOf1.get(rows1[i].stop_id);
			const arriveBy = clockSeconds(rows1[i].arrival_time);

			for (const target of transferTargets(station)) {
				for (const origin of originsByStation.get(target.id) ?? []) {
					if (origin.departure < arriveBy + target.buffer) continue;

					keepBest(candidates, `t:${rows1[0].trip_id}|${origin.tripId}`, {
						departure,
						arrival: origin.arrival,
						first: { agency: from.agency, rows: rows1, from: boardIdx, to: i },
						second: {
							agency: to.agency,
							rows: origin.rows,
							from: origin.joinIdx,
							to: origin.exitIdx,
						},
					});
				}
			}
		}
	};

	// Already standing at a transfer point (subway 34 St-Penn to the LIRR
	// terminal above it): the journey is the second leg alone, boarded once
	// the walk is covered. Departure is the query time, so the duration
	// includes the walk even though the leg shows the boarding time.
	const fromStation = await getStopRef(from.agency, from.stop.id);
	const startNow = clockSeconds(time);

	for (const target of transferTargets(fromStation)) {
		for (const origin of originsByStation.get(target.id) ?? []) {
			if (origin.departure < startNow + target.buffer) continue;

			keepBest(candidates, `w:${origin.tripId}`, {
				departure: startNow,
				arrival: origin.arrival,
				first: {
					agency: to.agency,
					rows: origin.rows,
					from: origin.joinIdx,
					to: origin.exitIdx,
				},
			});
		}
	}

	for (const rows1 of leg1.values()) {
		const boardIdx = rows1.findIndex(
			(row) => fromIds.has(row.stop_id) && row.departure_time >= time
		);
		if (boardIdx === -1) continue;

		if (sameFeed) addDirect(rows1, boardIdx);
		addTransfers(rows1, boardIdx);
	}

	// Rank by arrival; ties go to fewer legs (a walk to the terminal beats
	// riding one stop away and walking back for the same train), then to the
	// later departure. Same arrival on the same final trip is one itinerary.
	const legCount = (candidate: Candidate): number => (candidate.second ? 2 : 1);
	const sorted = [...candidates.values()].toSorted(
		(a, b) =>
			a.arrival - b.arrival ||
			legCount(a) - legCount(b) ||
			b.departure - a.departure
	);

	const seen = new Set<string>();
	const ranked: Candidate[] = [];
	for (const candidate of sorted) {
		const key = `${candidate.arrival}|${
			candidate.second?.rows[0].trip_id ?? candidate.first.rows[0].trip_id
		}`;
		if (seen.has(key)) continue;

		seen.add(key);
		ranked.push(candidate);
		if (ranked.length === MAX_ITINERARIES) break;
	}

	const itineraries = await Promise.all(
		ranked.map(async (candidate) => {
			const legs = [await rideLeg(candidate.first)];
			if (candidate.second) {
				legs.push(await rideLeg(candidate.second));
			}

			return {
				legs,
				departure: candidate.departure,
				arrival: candidate.arrival,
			};
		})
	);

	return {
		from: { id: from.stop.id, name: from.stop.name },
		to: { id: to.stop.id, name: to.stop.name },
		date,
		time,
		itineraries: itineraries.map((itinerary) => ({
			// The itinerary's departure, not the first leg's: a walk-only
			// journey leaves at the query time, earlier than its one boarding.
			departureTime: clockOf(itinerary.departure),
			arrivalTime: itinerary.legs.at(-1)?.to.time ?? "",
			durationMinutes: Math.round(
				(itinerary.arrival - itinerary.departure) / 60
			),
			legs: itinerary.legs,
		})),
	};
}

/**
 * Full stop-by-stop timelines of every active trip that can be boarded at
 * `stopIds`; `minDeparture` (a clock string) drops trips that already left.
 */
async function timelines(
	agency: AgencyId,
	stopIds: readonly string[],
	service: { sql: string; parameters: string[] },
	minDeparture?: string
): Promise<Map<string, TimelineRow[]>> {
	const stopTimesUrl = getStaticFeedUrl(agency, "stop_times");
	const tripsUrl = getStaticFeedUrl(agency, "trips");
	const boarding = minDeparture ? "AND s.departure_time >= ?" : "";

	const rows = await runQuery<TimelineRow>(
		`SELECT st.trip_id, st.stop_id, st.arrival_time, st.departure_time,
			t.route_id, t.trip_headsign, t.shape_id
		 FROM read_parquet('${stopTimesUrl}') st
		 JOIN read_parquet('${tripsUrl}') t ON t.trip_id = st.trip_id
		 WHERE st.trip_id IN (
			 SELECT s.trip_id FROM read_parquet('${stopTimesUrl}') s
			 JOIN read_parquet('${tripsUrl}') t2 ON t2.trip_id = s.trip_id
			 WHERE s.stop_id IN (${stopIds.map(() => "?").join(", ")})
			   ${boarding}
			   AND t2.service_id IN (${service.sql})
		 )
		 ORDER BY st.trip_id, CAST(st.stop_sequence AS INTEGER)`,
		...stopIds,
		...(minDeparture ? [minDeparture] : []),
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

type Origin = {
	tripId: string;
	rows: TimelineRow[];
	joinIdx: number;
	exitIdx: number;
	departure: number;
	arrival: number;
};

/**
 * For the second leg: every place a trip can be boarded before it reaches
 * `toIds`, bucketed by the station, with the times that matter for pairing.
 */
function collectOrigins(
	legs: Map<string, TimelineRow[]>,
	toIds: Set<string>,
	stationOf: Map<string, StopRef | undefined>
): Map<string, Origin[]> {
	const origins = new Map<string, Origin[]>();

	for (const rows of legs.values()) {
		const exitIdx = rows.findIndex((row) => toIds.has(row.stop_id));
		if (exitIdx <= 0 || rows[exitIdx].arrival_time === "") continue;

		const arrival = clockSeconds(rows[exitIdx].arrival_time);

		for (let i = 0; i < exitIdx; i++) {
			if (rows[i].departure_time === "") continue;

			const station = stationOf.get(rows[i].stop_id)?.id;
			if (!station) continue;

			let bucket = origins.get(station);
			if (!bucket) {
				bucket = [];
				origins.set(station, bucket);
			}

			bucket.push({
				tripId: rows[0].trip_id,
				rows,
				joinIdx: i,
				exitIdx,
				departure: clockSeconds(rows[i].departure_time),
				arrival,
			});
		}
	}

	return origins;
}

/**
 * Where a rider arriving at `station` can transfer to: the same station in
 * the other feed's terms, or any of its stations within walking distance.
 * Ids are never matched across feeds (977 of them repeat), so a cross-feed
 * transfer always has to be an actual walk.
 */
function memoizedTargets(
	stations: Array<{ id: string; location: { lat: number; lon: number } }>,
	sameFeed: boolean
): (station: StopRef | undefined) => Array<{ id: string; buffer: number }> {
	const cache = new Map<string, Array<{ id: string; buffer: number }>>();

	return (station) => {
		if (!station) return [];

		let targets = cache.get(station.id);
		if (targets) return targets;

		targets = [];
		if (sameFeed)
			targets.push({ id: station.id, buffer: SAME_STATION_TRANSFER_S });

		if (station.location) {
			for (const candidate of stations) {
				if (sameFeed && candidate.id === station.id) continue;
				if (
					distanceMeters(station.location, candidate.location) <= WALK_MAX_M
				) {
					targets.push({ id: candidate.id, buffer: WALK_TRANSFER_S });
				}
			}
		}

		cache.set(station.id, targets);
		return targets;
	};
}

/**
 * Same trip pair, different transfer point: the arrival is identical (it's
 * the second trip's), so the later first-leg departure wins.
 */
function keepBest(
	candidates: Map<string, Candidate>,
	key: string,
	candidate: Candidate
): void {
	const existing = candidates.get(key);
	if (!existing || existing.departure < candidate.departure) {
		candidates.set(key, candidate);
	}
}

async function rideLeg(ride: Ride): Promise<JourneyLeg> {
	const { agency, rows, from, to } = ride;
	const [fromRef, toRef, directions] = await Promise.all([
		getStopRef(agency, rows[from].stop_id),
		getStopRef(agency, rows[to].stop_id),
		directionIndex(agency),
	]);
	const headsign = rows[from].trip_headsign;

	return {
		route: rows[from].route_id,
		agency,
		headsign: headsign === "" ? undefined : headsign,
		direction: directions.get(rows[from].shape_id ?? "") ?? "",
		tripId: rows[from].trip_id,
		from: {
			id: fromRef?.id ?? rows[from].stop_id,
			name: fromRef?.name ?? "",
			time: rows[from].departure_time,
		},
		to: {
			id: toRef?.id ?? rows[to].stop_id,
			name: toRef?.name ?? "",
			time: rows[to].arrival_time,
		},
	};
}
