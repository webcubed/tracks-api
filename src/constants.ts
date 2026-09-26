export const REALTIME_FEEDS = {
	SUBWAY: {
		IRT: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs", // 1,2,3,4,5,6,S
		ACE: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace",
		BDFM: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm",
		G: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g",
		JZ: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz",
		NQRW: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw",
		L: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l",
		SIR: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-si",
	},
	LIRR: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/lirr%2Fgtfs-lirr",
	MNR: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/mnr%2Fgtfs-mnr",
	ALERTS: {
		GTFS: {
			ALL: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fall-alerts",
			SUBWAY:
				"https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts",
			BUS: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fbus-alerts",
			LIRR: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Flirr-alerts",
			MNR: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fmnr-alerts",
		},
		JSON: {
			ALL: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fall-alerts.json",
			SUBWAY:
				"https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts.json",
			BUS: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fbus-alerts.json",
			LIRR: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Flirr-alerts.json",
			MNR: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fmnr-alerts.json",
		},
	},
	ENE: {
		XML: {
			CURRENT:
				"https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fnyct_ene.xml",
			UPCOMING:
				"https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fnyct_ene_upcoming.xml",
			EQUIPMENT:
				"https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fnyct_ene_equipments.xml",
		},
		JSON: {
			CURRENT:
				"https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fnyct_ene.json",
			UPCOMING:
				"https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fnyct_ene_upcoming.json",
			EQUIPMENT:
				"https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fnyct_ene_equipments.json",
		},
	},
} as const;

export const PROTOBUF_SCHEMAS = {
	GTFS_REALTIME:
		"https://raw.githubusercontent.com/OneBusAway/onebusaway-gtfs-realtime-api/master/src/main/proto/com/google/transit/realtime/gtfs-realtime-NYCT.proto",
	MTA_SUBWAY:
		"https://raw.githubusercontent.com/OneBusAway/onebusaway-gtfs-realtime-api/master/src/main/proto/com/google/transit/realtime/gtfs-realtime-MTARR.proto",
	SERVICE_ALERTS:
		"https://raw.githubusercontent.com/OneBusAway/onebusaway-gtfs-realtime-api/master/src/main/proto/com/google/transit/realtime/gtfs-realtime-service-status.proto",
} as const;

export const AGENCY_IDS = [
	"subway",
	"lirr",
	"bus_bx",
	"bus_b",
	"bus_busco",
	"bus_m",
	"bus_si",
	"bus_q",
] as const;

/** Feed ids are what `/v1` URLs use as `agency` — never the GTFS `agency_id`. */
export type AgencyId = (typeof AGENCY_IDS)[number];
export type AgencyMode = "subway" | "rail" | "bus";

export const AGENCIES: Record<AgencyId, { name: string; mode: AgencyMode }> = {
	subway: { name: "New York City Subway", mode: "subway" },
	lirr: { name: "Long Island Rail Road", mode: "rail" },
	bus_bx: { name: "MTA Bus - Bronx", mode: "bus" },
	bus_b: { name: "MTA Bus - Brooklyn", mode: "bus" },
	bus_busco: { name: "MTA Bus Company", mode: "bus" },
	bus_m: { name: "MTA Bus - Manhattan", mode: "bus" },
	bus_si: { name: "MTA Bus - Staten Island", mode: "bus" },
	bus_q: { name: "MTA Bus - Queens", mode: "bus" },
};

/** Narrow an untrusted string (query param, path segment) to a feed id. */
export function isAgencyId(value: string): value is AgencyId {
	return Object.hasOwn(AGENCIES, value);
}

type AllTables =
	| "agency"
	| "calendar_dates"
	| "calendar"
	| "feed_info"
	| "routes"
	| "shapes"
	| "stop_times"
	| "stops"
	| "transfers"
	| "trips";
type BusTables = Exclude<AllTables, "transfers">;
type LirrTables = Exclude<AllTables, "calendar">;

/** Which GTFS tables each feed ships — derived from `AgencyId` so the two can't drift. */
export type AgencyTableMap = {
	[K in AgencyId]: K extends "subway"
		? AllTables
		: K extends "lirr"
			? LirrTables
			: BusTables;
};

/**
 * Feeds with no `calendar.txt` — their service days come from `calendar_dates`
 * alone. Derived from `AgencyTableMap`, so querying a file the feed doesn't
 * ship can't creep in unnoticed.
 */
type CalendarFreeFeed = {
	[K in AgencyId]: "calendar" extends AgencyTableMap[K] ? never : K;
}[AgencyId];

export const CALENDAR_FREE_FEEDS = { lirr: true } as const satisfies Record<
	CalendarFreeFeed,
	true
>;

export function getStaticFeedUrl<T extends keyof AgencyTableMap>(
	agency: T,
	table: AgencyTableMap[T]
) {
	return `https://github.com/webcubed/tracks-api/releases/download/latest-gtfs/${agency}_${table}.parquet`;
}
