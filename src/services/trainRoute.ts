import type { AgencyId } from "@/constants";
import { resolveStop } from "@/services/network";
import { getCountdown, isStationCode } from "@/services/radar";
import { stationNameFor, stationNames } from "@/services/stationCodes";
import { getVehicles } from "@/services/vehicles";

/** One location a train's run touches: a station, a yard, an interlocking. */
export type TrainRouteEvent = {
	/** The network's own abbreviation, e.g. `NYK`, `WSY`, `JAM`. */
	code: string;
	/** The feed's station name when the code is a station, otherwise the code:
	 * yards and interlockings exist only inside the tracking system. */
	name: string;
	/** `STOP` for a passenger stop, `NONE` for a point passed in motion,
	 * `EQUIPMENT` for a yard move. */
	stopType: string;
	/** Posted or actual track, when the tracking system has one. */
	track?: string;
	/** Unix seconds: actual where recorded, operating estimate otherwise. */
	time?: number;
	/** True once the event has recorded times, i.e. the train was there. */
	passed: boolean;
};

export type TrainRoute = {
	vehicle: { id: string; route: string };
	/** The advertised train number, when the live feed could be tied to a run. */
	train?: string;
	branch?: string;
	headsign?: string;
	direction?: string;
	/** The station the tracking system was asked about — the train's next stop. */
	station?: { code: string; name: string };
	source?: "mta-radar-countdown";
	events: TrainRouteEvent[];
	/** Set when a route could not be resolved; `events` is empty. */
	error?: string;
};

type RadarEvent = {
	code?: string;
	stop_type?: string;
	sched_track?: string;
	act_track?: string;
	sched_time?: number;
	act_arrive?: number;
	act_depart?: number;
	act_time?: number;
	oper_time?: number;
};

type RadarTrain = {
	train_num?: string;
	details?: {
		branch?: string;
		headsign?: string;
		direction?: string;
		events?: RadarEvent[];
	};
};

function isDigits(value: string): boolean {
	for (const character of value)
		if (character < "0" || character > "9") return false;

	return true;
}

/**
 * Numbers long enough to be a train number rather than a year or a fleet id.
 * An LIRR vehicle id names the run as its own segment (`GO202_26_2953_METS_V`).
 */
function idTokens(id: string): string[] {
	return id.split("_").filter((token) => token.length >= 3 && isDigits(token));
}

function timeOf(event: RadarEvent): number | undefined {
	return (
		event.act_arrive ??
		event.act_depart ??
		event.act_time ??
		event.oper_time ??
		event.sched_time
	);
}

/**
 * The operational route of a live train, from the tracking system's own event
 * list: every station it calls at plus the interlockings and yards it runs
 * through, each with the track it uses. The list is keyed by the train's next
 * stop, which is the station the tracking system can be asked about.
 */
export async function getTrainRoute(
	id: string,
	route: string,
	agency?: AgencyId
): Promise<TrainRoute | undefined> {
	if (agency !== undefined && agency !== "lirr") return undefined;

	const vehicles = await getVehicles(route, "lirr");
	const vehicle = vehicles?.find((item) => item.id === id);
	if (!vehicle) return undefined;

	const trainRoute: TrainRoute = {
		vehicle: { id: vehicle.id, route: vehicle.route },
		events: [],
	};

	// Only the LIRR feed publishes station codes, which is what the tracking
	// system is addressed by.
	const nextStop = vehicle.nextStopId
		? await resolveStop(vehicle.nextStopId, "lirr")
		: undefined;
	const code = (nextStop?.row.stop_code ?? "").trim().toUpperCase();
	if (!isStationCode(code)) {
		return {
			...trainRoute,
			error:
				"The feed has not reported this train's next stop yet, so its run cannot be looked up.",
		};
	}

	const names = await stationNames("lirr");
	const station = { code, name: stationNameFor(names, code) };

	// A four-hour window covers the longest run; `include_passed` keeps a train
	// that has just left the station from dropping out of its own route.
	let raw: unknown;
	try {
		raw = await getCountdown(code, { includePassed: true, hours: 4 });
	} catch (error) {
		return {
			...trainRoute,
			station,
			error:
				error instanceof Error ? error.message : "Tracking system unavailable",
		};
	}

	const trains = (Array.isArray(raw) ? raw : []).filter(
		(train): train is RadarTrain => typeof train === "object" && train !== null
	);
	// The live feed's vehicle id carries the run number as one of its own
	// tokens (`GO202_26_2953_METS_V`), which is what ties a position to a run.
	const tokens = new Set(idTokens(vehicle.id));
	const match = trains.find(
		(train) => train.train_num && tokens.has(train.train_num)
	);
	const events = match?.details?.events ?? [];
	if (!match || events.length === 0) {
		return {
			...trainRoute,
			station,
			error: `No run for this train is posted at ${station.name} yet.`,
		};
	}

	return {
		...trainRoute,
		train: match.train_num,
		branch: match.details?.branch,
		headsign: match.details?.headsign,
		direction: match.details?.direction,
		station,
		source: "mta-radar-countdown",
		events: events.flatMap((event) => {
			const eventCode = (event.code ?? "").trim().toUpperCase();
			if (!eventCode) return [];
			const track = (event.act_track ?? event.sched_track)?.trim();
			const time = timeOf(event);

			return [
				{
					code: eventCode,
					name: stationNameFor(names, eventCode),
					stopType: event.stop_type ?? "",
					...(track ? { track } : {}),
					...(time === undefined ? {} : { time }),
					passed:
						event.act_arrive !== undefined ||
						event.act_depart !== undefined ||
						event.act_time !== undefined,
				},
			];
		}),
	};
}
