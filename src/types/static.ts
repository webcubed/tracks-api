/**
 * GTFS row shapes as `queryTable` / `loadTable` return them.
 *
 * Every parquet column is VARCHAR (`scripts/convert.ts` reads the CSVs with
 * `all_varchar=true`), so numeric GTFS fields (`stop_lat`, `route_type`,
 * `direction_id`, `exception_type`, `stop_sequence`) all arrive as strings.
 * Convert with `Number(...)` where the API wants a number.
 *
 * A NULL cell comes back as `null`, not `undefined`: test with `typeof`, never
 * `=== null` (xo also bans `null` as a type).
 *
 * Fields marked `?` are missing from some feeds' schemas altogether; run
 * `pnpm exec tsx scripts/schema.ts` for the full per-feed matrix.
 */

export type Agency = {
	agency_id: string;
	agency_name: string;
	agency_url: string;
	agency_timezone: string;
	agency_lang?: string;
	agency_phone?: string;
};

export type CalendarDates = {
	service_id: string;
	date: string; // YYYYMMDD, easier to parse as string
	exception_type: string; // "1" = added, "2" = removed
};

export type Calendar = {
	// Absent from LIRR and bus_busco; those feeds carry calendar_dates only.
	service_id: string;
	monday: string; // "0" | "1"
	tuesday: string;
	wednesday: string;
	thursday: string;
	friday: string;
	saturday: string;
	sunday: string;
	start_date: string; // YYYYMMDD
	end_date: string; // YYYYMMDD
};

export type FeedInfo = {
	feed_publisher_name: string;
	feed_publisher_url: string;
	feed_lang: string;
	feed_start_date?: string;
	feed_end_date?: string;
	feed_version?: string;
	feed_contact_url?: string;
	feed_timezone?: string;
};

export type Routes = {
	agency_id?: string; // absent from LIRR
	route_id: string;
	route_short_name?: string; // absent from LIRR
	route_long_name: string;
	route_desc?: string; // absent from LIRR
	route_type: string; // "0"…"12", "702" … see GTFS route_type
	route_url?: string;
	route_color: string; // hex without "#"
	route_text_color: string; // hex without "#"
	route_sort_order?: string; // subway only
};

export type Shapes = {
	shape_id: string;
	shape_pt_sequence: string; // "0", "1", ...; cast before sorting
	shape_pt_lat: string; // decimal degrees
	shape_pt_lon: string;
};

export type StopTimes = {
	trip_id: string;
	stop_id: string;
	arrival_time: string; // HH:MM:SS, may pass 24:00:00
	departure_time: string;
	stop_sequence: string; // cast before ordering
	pickup_type?: string; // absent from subway
	drop_off_type?: string;
	timepoint?: string; // bus only
};

export type Stops = {
	stop_id: string;
	stop_code?: string; // LIRR only
	stop_name: string;
	stop_desc?: string; // absent from subway and LIRR
	stop_lat: string; // decimal degrees
	stop_lon: string;
	zone_id?: string;
	stop_url?: string;
	wheelchair_boarding?: string; // LIRR only: "0" | "1" | "2"
	location_type?: string; // "0" stop, "1" station; absent from LIRR and bus_busco
	parent_station?: string; // set on platforms; absent from LIRR and bus_busco
};

export type Transfers = {
	from_stop_id: string;
	to_stop_id: string;
	from_trip_id?: string; // LIRR only
	to_trip_id?: string;
	transfer_type: string;
	min_transfer_time: string; // seconds
};

export type Trips = {
	route_id: string;
	trip_id: string;
	service_id: string;
	trip_headsign: string;
	direction_id: string; // "0" | "1"
	block_id?: string; // bus only
	shape_id: string;
	trip_short_name?: string; // LIRR only
	peak_offpeak?: string; // LIRR only
};

export type TableMap = {
	agency: Agency;
	routes: Routes;
	stops: Stops;
	stop_times: StopTimes;
	trips: Trips;
	shapes: Shapes;
	calendar: Calendar;
	calendar_dates: CalendarDates;
	transfers: Transfers;
	feed_info: FeedInfo;
};
