/**
 * Decoded real-time payloads. Field names are camelCase because protobufjs
 * decodes with `keepCase: false`; everything is optional: feeds omit fields
 * freely (subway vehicles carry no coordinates, bus trip updates carry no
 * occupancy).
 */

export type FeedTrip = {
	tripId?: string;
	startDate?: string;
	routeId?: string;
	directionId?: number;
};

export type FeedTime = {
	/** Epoch seconds, as a string (GTFS-RT int64). */
	time?: string;
	/** Schedule deviation in seconds. */
	delay?: number;
};

export type FeedStopTimeUpdate = {
	stopId?: string;
	stopSequence?: number;
	/** `SCHEDULED`, `SKIPPED`, `NO_DATA` … absent is the same as scheduled. */
	scheduleRelationship?: string;
	arrival?: FeedTime;
	departure?: FeedTime;
	occupancyStatus?: string;
};

export type FeedTripUpdate = {
	trip?: FeedTrip;
	delay?: number;
	stopTimeUpdate?: FeedStopTimeUpdate[];
	vehicle?: { id?: string; label?: string };
	timestamp?: string;
};

export type FeedVehicle = {
	trip?: FeedTrip;
	position?: {
		latitude?: number;
		longitude?: number;
		bearing?: number;
		speed?: number;
	};
	/** Stop the vehicle is currently stationed at. */
	stopId?: string;
	currentStopSequence?: number;
	currentStatus?: string;
	occupancyStatus?: string;
	vehicle?: { id?: string; label?: string };
	timestamp?: string;
};

export type FeedEntity = {
	id?: string;
	tripUpdate?: FeedTripUpdate;
	vehicle?: FeedVehicle;
};

export type FeedMessage = {
	header?: { timestamp?: string };
	entity?: FeedEntity[];
};

/**
 * Mercury service alerts, read from the `.json` twin of the protobuf feed
 * (`camsys/*-alerts.json`): same payload, and it skips a second protobuf root
 * (the Mercury extension claims field 1001 on FeedHeader, which NYCT already
 * uses). Keys stay snake_case: the JSON endpoint only camelCases extensions.
 */
export type MercuryFeed = {
	entity?: MercuryEntity[];
};

export type MercuryEntity = {
	id?: string;
	alert?: MercuryAlert;
};

export type MercuryAlert = {
	active_period?: Array<{ start?: number; end?: number }>;
	informed_entity?: MercuryInformed[];
	header_text?: MercuryText;
	description_text?: MercuryText;
	"transit_realtime.mercury_alert"?: { alert_type?: string };
};

export type MercuryInformed = {
	agency_id?: string;
	route_id?: string;
	stop_id?: string;
};

export type MercuryText = {
	translation?: Array<{ text?: string; language?: string }>;
};
