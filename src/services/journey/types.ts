import type { AgencyId } from "@/constants";
import type { Station, TransferIndex } from "@/services/network";
import { AGENCY_IDS } from "@/constants";

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
};

export type Link =
	| { kind: "start" }
	| { kind: "walk"; from: Label }
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
	/** Feed/route sequence so a faster route does not erase every alternative. */
	pattern: string;
	round: number;
	via: Link;
};

export type ItineraryDraft = {
	departure: number;
	arrival: number;
	legs: LegDesc[];
};

export type Search = {
	labels: Map<string, Label[]>;
	walkQueue: Label[];
	grids: Map<AgencyId, Map<string, Station[]>>;
	stationsById: Map<AgencyId, Map<string, Station>>;
	transfers: Map<AgencyId, TransferIndex>;
	destKey: string;
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
/** Cross-feed transfers are a walk. 500m covers the complexes GTFS pins
 * awkwardly (subway 34 St-Penn to LIRR Penn is 214m, GCT to Grand Central
 * Madison 418m, Atlantic Terminal/Barclays next to each other). */
export const WALK_M = 500;
export const WALK_S = 420;
/** How far past the frontier a round boards; overnight headways hit 20 min. */
export const WINDOW_S = 7200;
/** Feeds a ride can board at all. */
export const RIDE_FEEDS: readonly AgencyId[] = AGENCY_IDS;

/** The rail feeds, which board on their own. */
export const RAIL_FEEDS: readonly AgencyId[] = ["subway", "lirr"];

/**
 * Every feed can be a useful leg, not only a bus endpoint. `boardRound` only
 * opens a feed's timetable when the current frontier has a reachable station
 * in that feed.
 */
export function rideFeedsFor(
	..._agencies: readonly AgencyId[]
): readonly AgencyId[] {
	return RIDE_FEEDS;
}

/** ~330 m cells so a 500 m walk stays inside a 5x5 block of them. */
export const CELL_DEGREES = 0.003;
