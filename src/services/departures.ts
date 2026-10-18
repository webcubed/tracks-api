import type { AgencyId } from "@/constants";
import type { Stops } from "@/types/static";
import { resolveStop } from "@/services/network";
import { getCountdown, getSolari, isStationCode } from "@/services/radar";
import { stationNameFor, stationNames } from "@/services/stationCodes";

/** One train as the Solari board reports it. */
type SolariDeparture = {
	time?: number;
	stops?: string[];
	direction?: string;
	track?: string;
	train_num?: string;
	stop_type?: string;
	status?: { otp?: number; held?: boolean; canceled?: boolean };
};

type CountdownStop = {
	code?: string;
	sched_time?: number;
	act_arrive_time?: number;
	act_depart_time?: number;
	act_time?: number;
	stop_status?: string;
	stop_type?: string;
	sign_track?: string;
	posted?: boolean;
	local_cancel?: boolean;
};

type CountdownTrain = {
	train_num?: string;
	status?: { otp?: number; held?: boolean; canceled?: boolean };
	details?: {
		headsign?: string;
		direction?: string;
		stops?: CountdownStop[];
	};
};

export type Departure = {
	/** The publicly advertised train number, e.g. `7755`. */
	train: string;
	/** Unix seconds at the queried station. */
	time: number;
	/** Posted track; absent until the tracking system assigns one. */
	track?: string;
	/** `E` eastbound or `W` westbound. */
	direction: string;
	/** Name of the last station the train serves. */
	destination?: string;
	/** Station names still to come, in order. */
	stops: string[];
	status: { otp: number; held: boolean; canceled: boolean };
};

export type DepartureBoard = {
	stop: { id: string; name: string };
	/** The three-letter code the board is keyed by; absent when the stop has
	 * none, which is every feed but the LIRR. */
	code?: string;
	source?: "mta-radar-solari" | "mta-radar-countdown";
	departures: Departure[];
	/** Set when the tracking system could not be reached; the board is empty. */
	error?: string;
};

function codeOf(row: Stops): string {
	return (row.stop_code ?? "").trim().toUpperCase();
}

function isPassengerStop(stopType: string | undefined): boolean {
	return (
		stopType === undefined ||
		stopType === "STOP" ||
		stopType.startsWith("EARLY_DEPARTURE")
	);
}

function parseSolariDepartures(
	raw: unknown,
	names: Map<string, string>
): Departure[] {
	const trains = (Array.isArray(raw) ? raw : []).filter(
		(train): train is SolariDeparture =>
			typeof train === "object" && train !== null
	);
	const name = (stationCode: string) => stationNameFor(names, stationCode);

	return trains
		.filter((train) => isPassengerStop(train.stop_type))
		.filter(
			(train): train is SolariDeparture & { train_num: string; time: number } =>
				typeof train.train_num === "string" && Number.isFinite(train.time)
		)
		.toSorted((a, b) => a.time - b.time)
		.map((train) => {
			const codes = (train.stops ?? []).filter(
				(value): value is string => typeof value === "string"
			);
			const track = train.track?.trim();
			const last = codes.at(-1);

			return {
				train: train.train_num,
				time: train.time,
				...(track ? { track } : {}),
				direction: train.direction ?? "",
				...(last ? { destination: name(last) } : {}),
				stops: codes.map((stationCode) => name(stationCode)),
				status: {
					otp: train.status?.otp ?? 0,
					held: train.status?.held === true,
					canceled: train.status?.canceled === true,
				},
			};
		});
}

function countdownStopTime(
	stop: CountdownStop | undefined
): number | undefined {
	const time =
		stop?.act_depart_time ??
		stop?.act_arrive_time ??
		stop?.act_time ??
		stop?.sched_time;
	return time !== undefined && Number.isFinite(time) ? time : undefined;
}

function isUpcomingPassengerStop(stop: CountdownStop | undefined): boolean {
	return Boolean(
		stop &&
		isPassengerStop(stop.stop_type) &&
		stop.stop_status !== "DEPARTED" &&
		!stop.local_cancel
	);
}

function toCountdownDeparture(
	train: CountdownTrain,
	code: string,
	names: Map<string, string>
): Departure | undefined {
	if (typeof train.train_num !== "string") return undefined;

	const stops = train.details?.stops ?? [];
	const stopIndex = stops.findIndex(
		(item) => (item.code ?? "").trim().toUpperCase() === code
	);
	const current = stopIndex === -1 ? undefined : stops[stopIndex];
	const time = isUpcomingPassengerStop(current)
		? countdownStopTime(current)
		: undefined;
	if (!current || time === undefined) return undefined;

	const name = (stationCode: string) => stationNameFor(names, stationCode);
	const remainingCodes = stops
		.slice(stopIndex + 1)
		.map((item) => (item.code ?? "").trim().toUpperCase())
		.filter(Boolean);
	const track = current.sign_track?.trim();
	const lastCode = remainingCodes.at(-1);
	const destination =
		train.details?.headsign ?? (lastCode ? name(lastCode) : undefined);

	return {
		train: train.train_num,
		time,
		...(track ? { track } : {}),
		direction: train.details?.direction ?? "",
		...(destination ? { destination } : {}),
		stops: remainingCodes.map((stationCode) => name(stationCode)),
		status: {
			otp: train.status?.otp ?? 0,
			held: train.status?.held === true,
			canceled: train.status?.canceled === true,
		},
	};
}

function parseCountdownDepartures(
	raw: unknown,
	code: string,
	names: Map<string, string>
): Departure[] {
	const trains = (Array.isArray(raw) ? raw : []).filter(
		(train): train is CountdownTrain =>
			typeof train === "object" && train !== null
	);

	return trains
		.flatMap((train) => {
			const departure = toCountdownDeparture(train, code, names);
			return departure ? [departure] : [];
		})
		.toSorted((a, b) => a.time - b.time);
}

/**
 * The departure board for a stop, with track assignments from the MTA's LIRR
 * tracking system. Terminal hubs publish a dedicated Solari board; branch
 * stations without a physical Solari board fall back to the station countdown
 * feed so track assignments and status still appear across the LIRR network.
 */
export async function getDepartures(
	id: string,
	feed?: AgencyId
): Promise<DepartureBoard | undefined> {
	const resolved = await resolveStop(id, feed);
	if (!resolved) return undefined;

	const { agency, row } = resolved;
	const stop = { id: row.stop_id, name: row.stop_name };
	const code = codeOf(row);
	if (agency !== "lirr" || !isStationCode(code))
		return { stop, departures: [] };

	const names = await stationNames(agency);

	try {
		const raw = await getSolari(code);
		return {
			stop,
			code,
			source: "mta-radar-solari",
			departures: parseSolariDepartures(raw, names),
		};
	} catch {
		// Solari only covers major terminal boards (NYK, GCT, JAM, ATL); try
		// the station countdown endpoint before reporting an error.
	}

	try {
		const raw = await getCountdown(code, { includePassed: false, hours: 3 });
		return {
			stop,
			code,
			source: "mta-radar-countdown",
			departures: parseCountdownDepartures(raw, code, names),
		};
	} catch (error) {
		return {
			stop,
			code,
			departures: [],
			error:
				error instanceof Error ? error.message : "Departure board unavailable",
		};
	}
}
