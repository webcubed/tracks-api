import type { AgencyId } from "@/constants";
import type { Station, TransferIndex } from "@/services/network";

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
/** Most NYC trips take 2 or 3 rides; a 4th would double the per-round
 * stop_times scans for increasingly contrived chains. */
export const MAX_RIDES = 3;
/** Interchange buffer when changing trips within one station. */
export const TRANSFER_S = 60;
/** Cross-feed transfers are a walk. 500m covers the complexes GTFS pins
 * awkwardly (subway 34 St-Penn to LIRR Penn is 214m, GCT to Grand Central
 * Madison 418m, Atlantic Terminal/Barclays next to each other). */
export const WALK_M = 500;
export const WALK_S = 420;
/** How far past the frontier a round boards; overnight headways hit 20 min. */
export const WINDOW_S = 7200;
/** Rides board on the rail feeds; every feed joins in through walk links. */
export const RAIL_FEEDS: readonly AgencyId[] = ["subway", "lirr"];
/** ~330 m cells so a 500 m walk stays inside a 5x5 block of them. */
export const CELL_DEGREES = 0.003;
