import { getStaticFeedUrl } from "@/constants";
import { memoize } from "@/lib/memoize";
import { runQuery } from "@/lib/parquet";
import { today } from "@/lib/time";
import { activeServices } from "@/services/schedule";

export type ApiFleetTrain = {
	number: string;
	/** LIRR branch ids this train number runs on today. */
	routes: string[];
};

export type ApiLirrFleet = {
	date: string;
	trains: ApiFleetTrain[];
};

type FleetRow = {
	trip_short_name: string;
	route_id: string;
};

/**
 * Every distinct LIRR train number scheduled for `date`, including numbers
 * that have already finished their runs. The live feed only carries trains
 * currently moving, so the timetable is what makes an activity grid possible.
 */
export const getLirrFleet = memoize(
	async (date: string = today()): Promise<ApiLirrFleet> => {
		const service = activeServices("lirr", date);
		const rows = await runQuery<FleetRow>(
			`SELECT t.trip_short_name, t.route_id
		 FROM read_parquet('${getStaticFeedUrl("lirr", "trips")}') t
		 WHERE t.service_id IN (${service.sql})
		   AND t.trip_short_name IS NOT NULL
		   AND t.trip_short_name <> ''
		 GROUP BY t.trip_short_name, t.route_id
		 ORDER BY TRY_CAST(t.trip_short_name AS INTEGER), t.trip_short_name`,
			...service.parameters
		);
		const trains = new Map<string, Set<string>>();

		for (const row of rows) {
			const number = row.trip_short_name.trim();
			if (!number) continue;
			const routes = trains.get(number);
			if (routes) routes.add(row.route_id);
			else trains.set(number, new Set([row.route_id]));
		}

		return {
			date,
			trains: [...trains].map(([number, routes]) => ({
				number,
				routes: [...routes],
			})),
		};
	}
);
