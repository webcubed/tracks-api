import type { AgencyId } from "@/constants";
import type { Station, TransferIndex } from "@/services/network";
import { AGENCIES, AGENCY_IDS } from "@/constants";

export type JourneyPreference = "fastest" | "fewerTransfers" | "lessWalking";
export type JourneyMode = "subway" | "rail" | "bus";

export type JourneyLeg = {
	route: string;
	agency: string;
	headsign?: string;
	direction: string;
	tripId: string;
	from: { id: string; name: string; time: string };
	to: { id: string; name: string; time: string };
	stops?: number;
	/** The stops passed through between boarding and alighting, in travel order. */
	intermediateStops?: JourneyIntermediateStop[];
};

export type JourneyIntermediateStop = {
	id: string;
	name: string;
	time: string;
};

export type JourneyStep =
	| ({
			kind: "ride";
			durationSeconds: number;
	  } & JourneyLeg)
	| {
			kind: "walk";
			distanceMeters: number;
			durationSeconds: number;
			transferType: "in-complex" | "street";
			from: {
				id: string;
				name: string;
				agency: string;
				time: string;
				location: { lat: number; lon: number };
			};
			to: {
				id: string;
				name: string;
				agency: string;
				time: string;
				location: { lat: number; lon: number };
			};
	  };

export type Journey = {
	departureTime: string;
	arrivalTime: string;
	durationMinutes: number;
	walkingDurationSeconds: number;
	walkingDistanceMeters: number;
	transfers: number;
	legs: JourneyLeg[];
	steps: JourneyStep[];
};

export type ApiJourney = {
	from: { id: string; name: string };
	to: { id: string; name: string };
	date: string;
	time: string;
	itineraries: Journey[];
};

export type TimelineRow = {
	trip_id: string;
	stop_id: string;
	arrival_time: string;
	departure_time: string;
	route_id: string;
	trip_headsign?: string;
	shape_id?: string;
};

export type LegDesc = {
	agency: AgencyId;
	route: string;
	headsign?: string;
	tripId: string;
	shapeId?: string;
	boardStop: string;
	boardTime: string;
	alightStop: string;
	alightTime: string;
	stops: number;
	intermediateStops: Array<{ id: string; time: string }>;
};

export type WalkDesc = {
	distanceMeters: number;
	durationSeconds: number;
	transferType: "in-complex" | "street";
	fromFeed: AgencyId;
	fromStation: string;
	fromLat: number;
	fromLon: number;
	fromTime: number;
	toFeed: AgencyId;
	toStation: string;
	toLat: number;
	toLon: number;
	toTime: number;
};

export type Link =
	| { kind: "start" }
	| { kind: "walk"; walk: WalkDesc; from: Label }
	| { kind: "ride"; leg: LegDesc; from: Label };

/**
 * A way of standing at a station at a moment in time. `via.from` chains it up
 * to a complete itinerary.
 */
export type Label = {
	feed: AgencyId;
	station: string;
	lat: number;
	lon: number;
	arrival: number;
	rides: number;
	walkSeconds: number;
	walkMeters: number;
	/** Feed/route sequence so a faster route does not erase every alternative. */
	pattern: string;
	round: number;
	via: Link;
};

export type StepDraft =
	{ kind: "ride"; leg: LegDesc } | { kind: "walk"; walk: WalkDesc };

export type ItineraryDraft = {
	departure: number;
	arrival: number;
	walkSeconds: number;
	walkMeters: number;
	legs: LegDesc[];
	steps: StepDraft[];
};

export type Search = {
	labels: Map<string, Label[]>;
	walkQueue: Label[];
	grids: Map<AgencyId, Map<string, Station[]>>;
	stationsById: Map<AgencyId, Map<string, Station>>;
	transfers: Map<AgencyId, TransferIndex>;
	destKey: string;
	destLocation: { lat: number; lon: number };
	allowedFeeds: ReadonlySet<AgencyId>;
};

export type Network = {
	grids: Map<AgencyId, Map<string, Station[]>>;
	byId: Map<AgencyId, Map<string, Station>>;
};

export const MAX_ITINERARIES = 5;
/**
 * Four rides allows realistic mixed-mode paths such as LIRR → subway
 * shuttle → subway trunk, or bus → subway transfer → subway trunk, without
 * opening the scan to long chains of opportunistic bus hops.
 */
export const MAX_RIDES = 4;
/** Interchange buffer when changing trips within one station. */
export const TRANSFER_S = 60;
/**
 * Street walking transfers up to 600 m (~7-8 minutes on foot). Covers
 * Penn Station ↔ Herald Sq (380 m), Grand Central ↔ Grand Central Madison
 * (418 m), and nearby bus-to-subway / bus-to-LIRR stops.
 */
export const WALK_M = 600;
/** Realistic urban pedestrian speed (m/s) with a 1.25x Manhattan grid detour factor. */
export const WALK_SPEED_MPS = 1.25;
export const WALK_DETOUR_FACTOR = 1.25;
/** Street crossing / station entrance overhead in seconds. */
export const WALK_OVERHEAD_S = 45;

/**
 * Compute realistic street walking distance and duration from straight-line
 * haversine distance in metres.
 */
export function walkMetrics(straightMeters: number): {
	distanceMeters: number;
	durationSeconds: number;
} {
	const distanceMeters = Math.max(
		10,
		Math.round(straightMeters * WALK_DETOUR_FACTOR)
	);
	const durationSeconds = Math.max(
		TRANSFER_S,
		Math.round(distanceMeters / WALK_SPEED_MPS + WALK_OVERHEAD_S)
	);
	return { distanceMeters, durationSeconds };
}

/** How far past the frontier a round boards; overnight headways hit 20 min. */
export const WINDOW_S = 7200;
/** Feeds a ride can board at all. */
export const RIDE_FEEDS: readonly AgencyId[] = AGENCY_IDS;

/** The rail feeds, which ship `transfers.txt`. */
export const RAIL_FEEDS: readonly AgencyId[] = ["subway", "lirr"];

/**
 * Feeds eligible for boarding, filtered to the user's mode selection. A
 * deselected network stays out even when it serves an endpoint, so an origin
 * there can still walk to an allowed one without riding it.
 */
export function rideFeedsFor(
	modes?: ReadonlySet<JourneyMode>
): readonly AgencyId[] {
	if (!modes || modes.size === 0) return RIDE_FEEDS;

	return AGENCY_IDS.filter((id) => modes.has(AGENCIES[id].mode));
}

/** ~330 m cells so a 600 m walk stays inside a 5x5 block of them. */
export const CELL_DEGREES = 0.003;
