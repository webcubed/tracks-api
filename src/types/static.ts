export type Agency = {
	agency_id: string;
	agency_name: string;
	agency_url: string;
	agency_timezone: string;
	agency_lang: string;
	agency_phone: string;
};

export type CalendarDates = {
	service_id: string;
	date: string; // YYYYMMDD, easier to parse as string
	exception_type: 1 | 2; // 1 = added, 2 = removed
};

export type Calendar = {
	// Not included in LIRR
	service_id: string;
	monday: 0 | 1;
	tuesday: 0 | 1;
	wednesday: 0 | 1;
	thursday: 0 | 1;
	friday: 0 | 1;
	saturday: 0 | 1;
	sunday: 0 | 1;
	start_date: string;
	end_date: string;
};

export type FeedInfo = {
	feed_publisher_name: string;
	feed_publisher_url: string;
	feed_lang: string;
	feed_start_date: string;
	feed_end_date: string;
	feed_version: string;
	feed_contact_url?: string; // LIRR, Bus
};

export type Routes = {
	agency_id: string;
	route_id: string;
	route_short_name?: string; // Subway, Bus
	route_long_name: string;
	route_desc?: string; // Subway, Bus
	route_type: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 11 | 12;
	route_url?: string; // Subway
	route_color: string;
	route_text_color: string;
	route_sort_order?: string; // Subway
};

export type Shapes = {
	shape_id: string;
	shape_pt_sequence: number; // 10001, 10002, etc
	shape_pt_lat: number;
	shape_pt_lon: number;
};

export type StopTimes = {
	trip_id: string;
	stop_id: string;
	arrival_time: string; // 00:00:00
	departure_time: string;
	stop_sequence: number; // Non zero Non negative
	pickup_type?: 0 | undefined | 1 | 2 | 3; // LIRR, Bus
	drop_off_type?: 0 | undefined | 1 | 2 | 3; // LIRR, Bus
	timepoint?: 0 | 1; // Bus
};

export type Stops = {
	stop_id: string;
	stop_code?: string; // LIRR
	stop_name: string;
	stop_desc?: string; // Bus
	stop_lat: number;
	stop_lon: number;
	zone_id?: undefined | string; // Bus
	stop_url?: undefined | string; // LIRR, Bus
	wheelchair_boarding?: 0 | undefined | 1 | 2; // LIRR
	location_type?: 0 | undefined | 1 | 2 | 3 | 4; // Subway
	parent_station: string | undefined;
};

export type Transfers = {
	// Not included in busses
	from_stop_id: string;
	to_stop_id: string;
	from_trip_id?: undefined | string; // LIRR
	to_trip_id?: undefined | string; // LIRR
	transfer_type: 0 | undefined | 1 | 2 | 3 | 4 | 5;
	min_transfer_time: number; // Seconds
};

export type Trips = {
	route_id: string;
	trip_id: string;
	service_id: string;
	trip_headsign: string;
	direction_id: 0 | 1;
	block_id?: string; // Bus
	shape_id: string;
};
