import type { AgencyId } from "@/constants";
import type { StopRef } from "@/services/network";
import type { FeedEntity, FeedTripUpdate } from "@/types/realtime";
import { AGENCY_IDS } from "@/constants";
import { getStopRef } from "@/services/network";
import { fetchRealtime, lookupTrips } from "@/services/realtime";
import { getRoute } from "@/services/routes";

export type ApiVehicle = {
	id: string;
	route: string;
	/** Absent only if the feed gives no coordinates and no resolvable stop. */
	location?: { lat: number; lon: number };
	geometry?: { type: "Point"; coordinates: [number, number] };
	bearing?: number;
	speed?: number;
	nextStop?: string;
	nextStopId?: string;
	occupancy?: string;
};

/** Where a route lives: its feed, unless the caller pinned one. */
async function feedForRoute(
	route: string,
	agency?: AgencyId
): Promise<AgencyId | undefined> {
	if (agency) {
		return (await getRoute(agency, route)) ? agency : undefined;
	}

	// Route ids collide across feeds (subway "1" vs LIRR "1"), so the same
	// first-hit rule as stop ids applies: AGENCY_IDS order.
	const feeds = await Promise.all(
		AGENCY_IDS.map(async (id) => ((await getRoute(id, route)) ? id : undefined))
	);

	return feeds.find((feed) => feed !== undefined);
}

/** First stop ahead of `now`; trip updates list stops in travel order. */
function nextStopAhead(
	update: FeedTripUpdate | undefined,
	now: number
): string | undefined {
	for (const stopTime of update?.stopTimeUpdate ?? []) {
		const time = stopTime.arrival?.time ?? stopTime.departure?.time;
		if (stopTime.stopId && time && Number(time) >= now) return stopTime.stopId;
	}

	return undefined;
}

/**
 * Live vehicles on a route: positions from the vehicle feed, next stop from
 * the trip update of the same trip. Trip updates and positions are separate
 * endpoints only for the bus; subway and LIRR send both in one payload.
 */
export async function getVehicles(
	route: string,
	agency?: AgencyId
): Promise<ApiVehicle[] | undefined> {
	const feed = await feedForRoute(route, agency);
	if (!feed) return undefined;

	const entities = await fetchRealtime(feed, [route]);
	const now = Date.now() / 1000;

	// Next stop ahead for each trip.
	const ahead = new Map<string, string>();
	for (const entity of entities) {
		const update = entity.tripUpdate;
		const tripId = update?.trip?.tripId;
		const next = nextStopAhead(update, now);

		if (tripId && next && !ahead.has(tripId)) ahead.set(tripId, next);
	}

	const tracked: Array<{
		entity: FeedEntity;
		tripId: string;
		feedRouteId?: string;
	}> = [];

	for (const entity of entities) {
		const tripId = entity.vehicle?.trip?.tripId;
		if (!tripId) continue;

		tracked.push({
			entity,
			tripId,
			feedRouteId: entity.vehicle?.trip?.routeId,
		});
	}

	// LIRR trips carry no route id, so only those go to the static lookup.
	const trips = await lookupTrips(feed, [
		...new Set(tracked.filter((t) => !t.feedRouteId).map((t) => t.tripId)),
	]);
	const matched = tracked.filter(
		(t) => (t.feedRouteId ?? trips.get(t.tripId)?.routeId) === route
	);

	// Every stop the response may name: current (subway vehicles report no
	// coordinates; the platform they stand on is the closest real position)
	// and next.
	const stopIds = new Set<string>();
	for (const { entity, tripId } of matched) {
		const next = ahead.get(tripId);
		if (next) stopIds.add(next);
		if (entity.vehicle?.stopId) stopIds.add(entity.vehicle.stopId);
	}

	const refs = new Map<string, StopRef | undefined>();
	await Promise.all(
		[...stopIds].map(async (id) => {
			refs.set(id, await getStopRef(feed, id));
		})
	);

	return matched.map(({ entity, tripId }) => {
		const { vehicle } = entity;
		const current = vehicle?.stopId ? refs.get(vehicle.stopId) : undefined;
		const nextId = ahead.get(tripId);
		const next = nextId ? refs.get(nextId) : undefined;
		const position = vehicle?.position;
		const location =
			position?.latitude !== undefined && position.longitude !== undefined
				? { lat: position.latitude, lon: position.longitude }
				: current?.location;
		const coordinates: [number, number] | undefined = location
			? [location.lon, location.lat]
			: undefined;

		return {
			id: entity.id ?? vehicle?.vehicle?.id ?? "",
			route,
			location,
			geometry: coordinates
				? { type: "Point" as const, coordinates }
				: undefined,
			bearing: position?.bearing,
			speed: position?.speed,
			nextStop: next?.name,
			nextStopId: next?.id,
			occupancy: vehicle?.occupancyStatus,
		};
	});
}
