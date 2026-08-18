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

export const AGENCIES = {
	SUBWAY: "subway",
	LIRR: "lirr",
	BRONX: "bus_bx",
	BROOKLYN: "bus_b",
	BUSCO: "bus_busco",
	MANHATTAN: "bus_m",
	SI: "bus_si",
	QUEENS: "bus_q",
};

type SubwayTables =
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
type BusTables = Exclude<SubwayTables, "transfers">;
type BusAgencies = Exclude<keyof typeof AGENCIES, "LIRR" | "SUBWAY">;
type LirrTables = Exclude<SubwayTables, "calendar">;

export type AgencyTableMap = {
	SUBWAY: SubwayTables;
	LIRR: LirrTables;
} & Record<BusAgencies, BusTables>;

export function getStaticFeedUrl<T extends keyof AgencyTableMap>(
	agency: T,
	table: AgencyTableMap[T]
) {
	return `https://github.com/webcubed/tracks-api/releases/download/latest-gtfs/${agency}_${table}.parquet`;
}
