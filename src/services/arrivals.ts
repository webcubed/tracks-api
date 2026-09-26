import type { AgencyId } from "@/constants";
import type { ApiSchedule, Departure } from "@/services/stops";
import type {
	FeedEntity,
	FeedStopTimeUpdate,
	FeedTripUpdate,
} from "@/types/realtime";
import { clockSeconds } from "@/lib/time";
import { fetchRealtime, isoNewYork, lookupTrips } from "@/services/realtime";
import {
	directionIndex,
	getSchedule,
	resolveStopIds,
	today,
} from "@/services/stops";

export type ApiArrival = {
	route: string;
	/** Subway reports `uptown`/`downtown`, everywhere else a cardinal point. */
	direction: string;
	headsign: string;
	/** `2026-08-17T14:32:00-04:00`. */
	arrivalTime: string;
	minutes: number;
	/** False only when the feed marks the stop as having no live data. */
	realtime: boolean;
	/** Schedule deviation in seconds. */
	delay: number;
	occupancy?: string;
	vehicleId?: string;
};

export type ApiArrivals = {
	stop: { id: string; name: string };
	arrivals: ApiArrival[];
};

type Candidate = {
	epoch: number;
	tripId: string;
	feedRouteId?: string;
	stu: FeedStopTimeUpdate;
	update: FeedTripUpdate;
};

/**
 * Live arrivals at a stop: GTFS-RT trip updates filtered to its ids
 * (platforms included), with headsign, route and direction filled in from
 * static GTFS, none of which the real-time feed carries. Real-time subway
 * trip ids aren't in static GTFS at all, so those candidates are matched
 * against today's schedule instead.
 */
export async function getArrivals(
	stopId: string,
	route?: string,
	feed?: AgencyId
): Promise<ApiArrivals | undefined> {
	const resolved = await resolveStopIds(stopId, feed);
	if (!resolved) return undefined;

	const { agency, stop, ids } = resolved;
	const entities = await fetchRealtime(agency, route ? [route] : stop.routes);
	const now = Date.now() / 1000;
	const { candidates, riders } = scan(entities, ids, now);

	if (candidates.length === 0) {
		return { stop: { id: stop.id, name: stop.name }, arrivals: [] };
	}

	const trips = await lookupTrips(agency, [
		...new Set(candidates.map((candidate) => candidate.tripId)),
	]);
	const [schedule, directions] = await Promise.all([
		candidates.some((candidate) => !trips.has(candidate.tripId))
			? getSchedule(stopId, today())
			: Promise.resolve(undefined),
		directionIndex(agency),
	]);

	const arrivals = candidates
		.filter(
			// LIRR trips carry no route id, so static trips settle the filter.
			(candidate) =>
				!route ||
				(trips.get(candidate.tripId)?.routeId ?? candidate.feedRouteId) ===
					route
		)
		.toSorted((a, b) => a.epoch - b.epoch)
		.map((candidate) => {
			const trip = trips.get(candidate.tripId);
			const rider = riders.get(candidate.tripId);
			const cardinal = cardinalOf(candidate, directions, trip?.shapeId);
			const scheduled = trip
				? undefined
				: matchDeparture(schedule, candidate, cardinal);

			return {
				route: trip?.routeId ?? candidate.feedRouteId ?? "",
				direction: arrivalDirection(agency, cardinal ?? scheduled?.direction),
				headsign: trip?.headsign ?? scheduled?.headsign ?? "",
				arrivalTime: isoNewYork(candidate.epoch),
				minutes: Math.max(0, Math.round((candidate.epoch - now) / 60)),
				realtime: candidate.stu.scheduleRelationship !== "NO_DATA",
				delay: delayOf(candidate),
				occupancy: rider?.occupancy,
				vehicleId: candidate.update.vehicle?.id ?? rider?.id,
			};
		});

	return { stop: { id: stop.id, name: stop.name }, arrivals };
}

/** Trip id → the vehicle running it, for occupancy and identity. */
type Rider = { id?: string; occupancy?: string };

/**
 * One entry per stop time ahead at this stop, plus the vehicle running each
 * trip: occupancy and identity live on the vehicle feed, not the trip update.
 */
function scan(
	entities: readonly FeedEntity[],
	ids: readonly string[],
	now: number
): { candidates: Candidate[]; riders: Map<string, Rider> } {
	const candidates: Candidate[] = [];
	const riders = new Map<string, Rider>();

	for (const entity of entities) {
		const { vehicle } = entity;
		const vehicleTripId = vehicle?.trip?.tripId;

		if (vehicleTripId) {
			riders.set(vehicleTripId, {
				id: entity.id ?? vehicle.vehicle?.id,
				occupancy: vehicle.occupancyStatus,
			});
		}

		const update = entity.tripUpdate;
		const tripId = update?.trip?.tripId;
		if (!update?.stopTimeUpdate || !tripId) continue;

		for (const stu of update.stopTimeUpdate) {
			const found = candidate(update, stu, tripId, { ids, now });
			if (found) candidates.push(found);
		}
	}

	return { candidates, riders };
}

/** One stop time ahead at this stop, or nothing. */
function candidate(
	update: FeedTripUpdate,
	stu: FeedStopTimeUpdate,
	tripId: string,
	scope: { ids: readonly string[]; now: number }
): Candidate | undefined {
	if (!stu.stopId || !scope.ids.includes(stu.stopId)) return undefined;

	// Feeds omit a time only when there's nothing to say about it.
	const time = stu.arrival?.time ?? stu.departure?.time;
	const epoch = time ? Number(time) : Number.NaN;
	if (!Number.isFinite(epoch) || epoch < scope.now) return undefined;

	return { epoch, tripId, feedRouteId: update.trip?.routeId, stu, update };
}

/** Schedule deviation in seconds; feeds carry it in three places. */
function delayOf(candidate: Candidate): number {
	return (
		candidate.stu.arrival?.delay ??
		candidate.stu.departure?.delay ??
		candidate.update.delay ??
		0
	);
}

/** Subway platforms end N/S/E/W: the direction of travel, no static join. */
const PLATFORM_CARDINAL: Record<string, string | undefined> = {
	N: "northbound",
	S: "southbound",
	E: "eastbound",
	W: "westbound",
};

function cardinalOf(
	candidate: Candidate,
	directions: Map<string, string>,
	shapeId: string | undefined
): string | undefined {
	const platform = PLATFORM_CARDINAL[candidate.stu.stopId?.at(-1) ?? ""];

	return platform ?? (shapeId ? directions.get(shapeId) : undefined);
}

/**
 * The scheduled departure running as this realtime arrival: same route and
 * direction, nearest within four minutes once its delay is subtracted (the
 * gap absorbs platform dwell and feeds reporting delay 0 while late). This is
 * how subway trips get a headsign: their real-time ids aren't in static GTFS.
 */
function matchDeparture(
	schedule: ApiSchedule | undefined,
	candidate: Candidate,
	cardinal: string | undefined
): Departure | undefined {
	const route = candidate.feedRouteId;
	if (!schedule || !route) return undefined;

	const seconds = clockSeconds(
		isoNewYork(candidate.epoch - delayOf(candidate)).slice(11, 19)
	);
	let best: Departure | undefined;
	let bestDiff = Number.POSITIVE_INFINITY;

	for (const departure of schedule.departures) {
		if (departure.route !== route) continue;
		if (cardinal && departure.direction !== cardinal) continue;

		const diff = timeDiff(clockSeconds(departure.departureTime), seconds);
		if (diff < bestDiff) {
			best = departure;
			bestDiff = diff;
		}
	}

	return bestDiff <= 240 ? best : undefined;
}

/** Distance between two clock readings, wrapping at midnight. */
function timeDiff(a: number, b: number): number {
	return Math.abs(((((a - b + 43_200) % 86_400) + 86_400) % 86_400) - 43_200);
}

/**
 * The trip's shape says which way it runs; the spec's enum wants subway in
 * MTA words (`1` train northbound is *uptown*) and points elsewhere.
 */
function arrivalDirection(
	agency: AgencyId,
	cardinal: string | undefined
): string {
	if (!cardinal) return "";

	if (agency === "subway") {
		if (cardinal === "northbound") return "uptown";
		if (cardinal === "southbound") return "downtown";
	}

	return cardinal.replace("bound", "");
}
