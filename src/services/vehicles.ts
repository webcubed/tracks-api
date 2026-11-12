import type { AgencyId } from "@/constants";
import type { StopRef } from "@/services/network";
import type { RadarTrainInfo, TrackSection } from "@/services/trackSections";
import type { FeedEntity, FeedTripUpdate } from "@/types/realtime";
import { AGENCY_IDS, REALTIME_FEEDS } from "@/constants";
import { memoize } from "@/lib/memoize";
import { getStopRefs } from "@/services/network";
import { FEED_TTL_MS, fetchRealtime, lookupTrips } from "@/services/realtime";
import { getRoute, getRoutes } from "@/services/routes";
import { matchRadarTrain, radarTrains } from "@/services/trackSections";

export type ApiVehicle = {
	id: string;
	/** Rider-facing vehicle label: an LIRR train number, when the feed posts one. */
	label?: string;
	route: string;
	/** Absent only if the feed gives no coordinates and no resolvable stop. */
	location?: { lat: number; lon: number };
	geometry?: { type: "Point"; coordinates: [number, number] };
	bearing?: number;
	speed?: number;
	nextStop?: string;
	nextStopId?: string;
	occupancy?: string;
	/**
	 * The track section the train is on, from the LIRR tracking system: the
	 * last location it reached, the next ahead, and the track it uses (e.g.
	 * `W2` in West Side Yard). Known before a position is out.
	 */
	section?: TrackSection;
	/** Where `location` came from, when it did not come from the feed itself. */
	positionSource?: "gtfs-realtime" | "tracking-system" | "stop";
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

type PreparedVehicle = {
	entity: FeedEntity;
	tripId: string;
	feedRouteId?: string;
	nextStop?: string;
};

type MatchedVehicle = PreparedVehicle & { route: string };
type TrackedVehicle = MatchedVehicle & { radar?: RadarTrainInfo };

const cachedTripLookup = memoize(
	async (feed: AgencyId, tripIds: readonly string[]) =>
		lookupTrips(feed, tripIds),
	FEED_TTL_MS
);

/**
 * Bus feeds are one citywide realtime payload, and each subway cluster is
 * shared by all routes it contains. Prepare their vehicle/update association
 * once per 15-second realtime cache window, independent of map viewport.
 */
const prepareRealtimeVehicles = memoize(
	async (
		feed: AgencyId,
		routes: readonly string[]
	): Promise<PreparedVehicle[]> => {
		const entities = await fetchRealtime(feed, routes);
		const now = Date.now() / 1000;
		const ahead = new Map<string, string>();
		for (const entity of entities) {
			const tripId = entity.tripUpdate?.trip?.tripId;
			const next = nextStopAhead(entity.tripUpdate, now);
			if (tripId && next && !ahead.has(tripId)) ahead.set(tripId, next);
		}

		return entities.flatMap((entity) => {
			const tripId = entity.vehicle?.trip?.tripId;
			return tripId
				? [
						{
							entity,
							tripId,
							feedRouteId: entity.vehicle?.trip?.routeId,
							nextStop: ahead.get(tripId),
						},
					]
				: [];
		});
	},
	FEED_TTL_MS
);

export type VehicleBounds = {
	west: number;
	south: number;
	east: number;
	north: number;
};

/**
 * Vehicles for multiple routes in one feed. Bounds are applied to GPS positions
 * before any stop metadata is resolved; only positionless trains need a
 * current-stop lookup to decide whether they belong in the viewport.
 */
export async function getVehiclesForAgency(
	feed: AgencyId,
	routes?: readonly string[],
	bounds?: VehicleBounds
): Promise<ApiVehicle[]> {
	const knownRoutes = await getRoutes(feed);
	const knownRouteIds = new Set(knownRoutes.map((route) => route.id));
	const requested = routes?.length
		? new Set(routes.filter((id) => knownRouteIds.has(id)))
		: knownRouteIds;
	if (requested.size === 0) return [];

	const isBus = feed.startsWith("bus_");
	const realtimeFeed = isBus ? "bus_bx" : feed;
	const realtimeRoutes = isBus
		? ["*"]
		: feed === "subway"
			? REALTIME_FEEDS.SUBWAY.filter((cluster) =>
					cluster.routes.some((route) => requested.has(route))
				)
					.flatMap((cluster) => cluster.routes)
					.toSorted()
			: [...requested].toSorted();
	const prepared = await prepareRealtimeVehicles(realtimeFeed, realtimeRoutes);
	const candidates = prepared.filter(({ entity }) => {
		const position = entity.vehicle?.position;
		if (
			!bounds ||
			position?.latitude === undefined ||
			position.longitude === undefined
		)
			return true;
		return inBounds(position.latitude, position.longitude, bounds);
	});
	const missingRouteTrips =
		feed === "lirr"
			? [
					...new Set(
						candidates
							.filter((item) => !item.feedRouteId)
							.map((item) => item.tripId)
					),
				]
			: [];
	// LIRR trip ids omit their route. Bus/subway include it, so avoid a DuckDB
	// trip-table query entirely for those feeds.
	const trips = await cachedTripLookup(feed, missingRouteTrips.toSorted());
	const matched: MatchedVehicle[] = candidates.flatMap(
		(item): MatchedVehicle[] => {
			const route = item.feedRouteId ?? trips.get(item.tripId)?.routeId;
			return route && requested.has(route) ? [{ ...item, route }] : [];
		}
	);

	// Railroad trains carry a second opinion on where they are: the tracking
	// system's own telemetry names their position and track section before the
	// realtime feed reports either.
	const radarIndex = feed === "lirr" ? await radarTrains() : undefined;
	const tracked: TrackedVehicle[] = matched.map((item) => ({
		...item,
		radar: radarIndex
			? matchRadarTrain(
					item.entity.id ?? item.entity.vehicle?.vehicle?.id ?? "",
					radarIndex
				)
			: undefined,
	}));
	const currentStopIds = [
		...new Set(
			tracked.flatMap(({ entity }) => {
				const { vehicle } = entity;
				const position = vehicle?.position;
				return vehicle?.stopId &&
					(position?.latitude === undefined || position.longitude === undefined)
					? [vehicle.stopId]
					: [];
			})
		),
	];
	const currentRefs = await stopRefs(feed, currentStopIds);
	const visible = tracked.filter(({ entity, radar }) => {
		if (!bounds) return true;
		const position = entity.vehicle?.position;
		if (position?.latitude !== undefined && position.longitude !== undefined)
			return inBounds(position.latitude, position.longitude, bounds);
		if (radar?.location)
			return inBounds(radar.location.lat, radar.location.lon, bounds);
		const current = entity.vehicle?.stopId
			? currentRefs.get(entity.vehicle.stopId)
			: undefined;
		return Boolean(
			current?.location &&
			inBounds(current.location.lat, current.location.lon, bounds)
		);
	});
	const stopIds = [
		...new Set(
			visible.flatMap(({ entity, nextStop }) => [
				...(entity.vehicle?.stopId ? [entity.vehicle.stopId] : []),
				...(nextStop ? [nextStop] : []),
			])
		),
	];
	const refs = await stopRefs(feed, stopIds);

	return visible.map(({ entity, nextStop, route, radar }) => {
		const { vehicle } = entity;
		const position = vehicle?.position;
		const { location, positionSource } = locateVehicle(
			radar,
			vehicle?.stopId ? refs.get(vehicle.stopId) : undefined,
			position
		);
		const coordinates: [number, number] | undefined = location
			? [location.lon, location.lat]
			: undefined;
		const next = nextStop ? refs.get(nextStop) : undefined;

		return {
			id: entity.id ?? vehicle?.vehicle?.id ?? "",
			...(vehicle?.vehicle?.label ? { label: vehicle.vehicle.label } : {}),
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
			...(radar?.section ? { section: radar.section } : {}),
			...(positionSource ? { positionSource } : {}),
		};
	});
}

/** A vehicle search hit carries the feed it came from, which `route` alone cannot. */
export type ApiVehicleSearchResult = ApiVehicle & { agency: AgencyId };

type VehicleSearchHit = {
	entity: FeedEntity;
	feed: AgencyId;
	routeId?: string;
	tripId: string;
	label?: string;
	score: number;
};

/** Bus routes share one citywide vehicle feed; this maps a route back to its feed. */
const busRouteFeeds = memoize(async () => {
	const entries = await Promise.all(
		AGENCY_IDS.filter((id) => id.startsWith("bus_")).map(
			async (id) => [id, await getRoutes(id)] as const
		)
	);
	const index = new Map<string, AgencyId>();
	for (const [feed, routes] of entries) {
		for (const route of routes) {
			if (!index.has(route.id)) index.set(route.id, feed);
		}
	}

	return index;
});

/**
 * Search tokens a rider may type for one vehicle: the feed id, the vehicle id,
 * its label, and the useful pieces of an LIRR or subway trip id. Subway vehicles
 * have no `vehicle.id` in the MTA feed, so their six-digit entity id and the run
 * token in `trip_id` (`N15R` in `129750_1..N15R`) are the searchable identities.
 */
function vehicleSearchTokens(entity: FeedEntity): Set<string> {
	const { vehicle } = entity;
	const tokens = new Set<string>();
	const add = (value: string | undefined) => {
		const normalized = value?.trim().toUpperCase().split(" ").join("");
		if (!normalized) return;

		tokens.add(normalized);
		if (Number.isInteger(Number(normalized)))
			tokens.add(String(Number(normalized)));
	};

	add(entity.id);
	add(vehicle?.vehicle?.id);
	add(vehicle?.vehicle?.label);
	add(vehicle?.trip?.tripId);

	for (const id of [entity.id, vehicle?.vehicle?.id]) {
		for (const part of id?.split("_") ?? []) add(part);
	}

	const tripId = vehicle?.trip?.tripId ?? "";
	const afterUnderscore = tripId.slice(tripId.indexOf("_") + 1);
	add(afterUnderscore);
	for (const part of afterUnderscore.split("..")) add(part);

	return tokens;
}

function vehicleSearchScore(
	entity: FeedEntity,
	needle: string
): number | undefined {
	let best: number | undefined;
	for (const token of vehicleSearchTokens(entity)) {
		const score =
			token === needle
				? 100
				: token.startsWith(needle)
					? 70
					: token.includes(needle)
						? 40
						: 0;
		if (score > 0 && (best === undefined || score > best)) best = score;
	}

	return best;
}

/**
 * Resolve a rider-typed vehicle id across subway, bus and LIRR. The raw feeds are
 * searched first so a vehicle outside the map viewport is still found; only the
 * routes that actually matched are then expanded into full map vehicles.
 */
async function findVehicles(
	query: string,
	agency?: AgencyId
): Promise<ApiVehicleSearchResult[]> {
	const needle = query.trim().toUpperCase().split(" ").join("");
	if (needle.length < 2) return [];

	const feeds: AgencyId[] = agency
		? [agency.startsWith("bus_") ? "bus_bx" : agency]
		: ["subway", "bus_bx", "lirr"];
	const raw = await Promise.all(
		feeds.map(async (feed) => {
			const entities = await fetchRealtime(feed, ["*"]);
			return entities.flatMap((entity): VehicleSearchHit[] => {
				if (!entity.vehicle) return [];
				const score = vehicleSearchScore(entity, needle);
				if (score === undefined) return [];
				const tripId = entity.vehicle.trip?.tripId;
				if (!tripId) return [];

				return [
					{
						entity,
						feed,
						routeId: entity.vehicle.trip?.routeId,
						tripId,
						label: entity.vehicle.vehicle?.label,
						score,
					},
				];
			});
		})
	);
	const hits = raw.flat().toSorted((a, b) => b.score - a.score);
	if (hits.length === 0) return [];

	const lirrTripIds = [
		...new Set(
			hits
				.filter((hit) => hit.feed === "lirr" && !hit.routeId)
				.map((hit) => hit.tripId)
		),
	];
	const [lirrTrips, busFeeds] = await Promise.all([
		cachedTripLookup("lirr", lirrTripIds.toSorted()),
		busRouteFeeds(),
	]);

	const resolved = hits.flatMap((hit) => {
		const route = hit.routeId ?? lirrTrips.get(hit.tripId)?.routeId;
		if (!route) return [];
		const hitAgency = hit.feed.startsWith("bus_")
			? busFeeds.get(route)
			: hit.feed;
		if (!hitAgency || (agency && hitAgency !== agency)) return [];
		return [{ ...hit, agency: hitAgency, route }];
	});
	if (resolved.length === 0) return [];

	const groups = new Map<
		string,
		{ agency: AgencyId; route: string; ids: Set<string> }
	>();

	for (const hit of resolved.slice(0, 40)) {
		const key = `${hit.agency}:${hit.route}`;
		let group = groups.get(key);
		if (!group) {
			group = { agency: hit.agency, route: hit.route, ids: new Set() };
			groups.set(key, group);
		}

		const id = hit.entity.id ?? hit.entity.vehicle?.vehicle?.id;
		if (id) group.ids.add(id);
	}

	const vehicles = await Promise.all(
		[...groups.values()].map(async (group) => {
			const found = await getVehiclesForAgency(group.agency, [group.route]);
			return found
				.filter((vehicle) => group.ids.has(vehicle.id))
				.map((vehicle) => ({
					...vehicle,
					agency: group.agency,
				}));
		})
	);
	const byKey = new Map(
		vehicles
			.flat()
			.map((vehicle) => [`${vehicle.agency}:${vehicle.id}`, vehicle])
	);
	const seen = new Set<string>();
	const results: ApiVehicleSearchResult[] = [];

	for (const hit of resolved) {
		const id = hit.entity.id ?? hit.entity.vehicle?.vehicle?.id;
		if (!id) continue;
		const key = `${hit.agency}:${id}`;
		if (seen.has(key)) continue;
		const vehicle = byKey.get(key);
		if (!vehicle) continue;
		seen.add(key);
		results.push({
			...vehicle,
			...(vehicle.label
				? {}
				: hit.label
					? { label: hit.label }
					: resolveLabel(vehicle.id, hit.agency)),
		});
		if (results.length === 20) break;
	}

	return results;
}

/** A readable fallback where the feed has no label: the bus fleet number. */
function resolveLabel(id: string, agency: AgencyId): { label?: string } {
	if (agency.startsWith("bus_")) {
		const fleet = id.split("_").at(-1);

		return fleet ? { label: fleet } : {};
	}

	return {};
}

export const searchVehicles = memoize(findVehicles, FEED_TTL_MS, 50);

/**
 * Where the train is: the feed's own coordinates where it has them, else the
 * tracking system's telemetry, else the coordinates of the stop it is at. A
 * train is visible before its position is out.
 */
function locateVehicle(
	radar: RadarTrainInfo | undefined,
	current: StopRef | undefined,
	position?: { latitude?: number; longitude?: number }
): {
	location?: { lat: number; lon: number };
	positionSource?: ApiVehicle["positionSource"];
} {
	if (position?.latitude !== undefined && position.longitude !== undefined)
		return {
			location: { lat: position.latitude, lon: position.longitude },
			positionSource: "gtfs-realtime",
		};
	if (radar?.location)
		return { location: radar.location, positionSource: "tracking-system" };
	if (current?.location)
		return { location: current.location, positionSource: "stop" };
	return {};
}

function inBounds(lat: number, lon: number, bounds: VehicleBounds): boolean {
	return (
		lon >= bounds.west &&
		lon <= bounds.east &&
		lat >= bounds.south &&
		lat <= bounds.north
	);
}

async function stopRefs(
	feed: AgencyId,
	ids: string[]
): Promise<Map<string, StopRef | undefined>> {
	return getStopRefs(feed, ids);
}

export async function getVehicles(
	route: string,
	agency?: AgencyId
): Promise<ApiVehicle[] | undefined> {
	const feed = await feedForRoute(route, agency);
	if (!feed) return undefined;
	return getVehiclesForAgency(feed, [route]);
}
