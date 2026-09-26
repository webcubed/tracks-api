import type { AgencyId } from "@/constants";
import { CALENDAR_FREE_FEEDS, getStaticFeedUrl } from "@/constants";
import { runQuery } from "@/lib/parquet";
import { childIds, directionIndex, resolveStop } from "@/services/network";

export type Departure = {
	route: string;
	headsign: string;
	departureTime: string;
	tripId: string;
	/** Travel direction of the trip, derived from its shape's endpoints. */
	direction: string;
};

export type ApiSchedule = {
	stop: { id: string; name: string };
	departures: Departure[];
};

type DepartureRow = {
	route_id: string;
	trip_headsign?: string;
	trip_id: string;
	shape_id?: string;
	departure_time: string;
};

const WEEKDAYS = [
	"sunday",
	"monday",
	"tuesday",
	"wednesday",
	"thursday",
	"friday",
	"saturday",
];

/**
 * `service_id`s running on `date`: the calendar weekday row, plus
 * `calendar_dates` additions, minus its removals. LIRR ships no
 * `calendar.txt`; naming it would 404, so its weekday half is skipped.
 */
export function activeServices(
	agency: AgencyId,
	date: string
): { sql: string; parameters: string[] } {
	const gfsDate = date.replaceAll("-", "");
	const weekday = WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
	const hasCalendar = !Object.hasOwn(CALENDAR_FREE_FEEDS, agency);
	const datesUrl = getStaticFeedUrl(agency, "calendar_dates");
	const additions = `SELECT service_id FROM read_parquet('${datesUrl}')
		 WHERE ? = date AND exception_type = '1'`;
	const removals = `SELECT service_id FROM read_parquet('${datesUrl}')
		 WHERE ? = date AND exception_type = '2'`;
	const weekly = hasCalendar
		? `SELECT service_id FROM read_parquet('${getStaticFeedUrl(agency, "calendar")}')
		 WHERE ? BETWEEN start_date AND end_date AND ${weekday} = '1'`
		: undefined;
	const sql = weekly
		? `((${additions}) UNION (${weekly})) EXCEPT (${removals})`
		: `(${additions}) EXCEPT (${removals})`;
	const parameters = weekly ? [gfsDate, gfsDate, gfsDate] : [gfsDate, gfsDate];

	return { sql, parameters };
}

/** Departures from a stop on `date` (YYYY-MM-DD), ordered by departure time. */
export async function getSchedule(
	id: string,
	date: string,
	feed?: AgencyId
): Promise<ApiSchedule | undefined> {
	const resolved = await resolveStop(id, feed);
	if (!resolved) return undefined;

	const { agency, index, row } = resolved;
	const stopIds = [id, ...childIds(index, id)];
	const service = activeServices(agency, date);

	const [departures, directions] = await Promise.all([
		runQuery<DepartureRow>(
			`SELECT t.trip_id, t.route_id, t.trip_headsign, t.shape_id, st.departure_time
			 FROM read_parquet('${getStaticFeedUrl(agency, "stop_times")}') st
			 JOIN read_parquet('${getStaticFeedUrl(agency, "trips")}') t ON t.trip_id = st.trip_id
			 WHERE st.stop_id IN (${stopIds.map(() => "?").join(", ")})
			   AND st.departure_time <> ''
			   AND t.service_id IN (${service.sql})
			 ORDER BY st.departure_time`,
			...stopIds,
			...service.parameters
		),
		directionIndex(agency),
	]);

	return {
		stop: { id: row.stop_id, name: row.stop_name },
		departures: departures.map((departure) => ({
			route: departure.route_id,
			headsign: departure.trip_headsign ?? "",
			departureTime: departure.departure_time,
			tripId: departure.trip_id,
			direction: directions.get(departure.shape_id ?? "") ?? "",
		})),
	};
}
