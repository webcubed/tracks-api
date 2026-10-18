import type { AgencyId } from "@/constants";
import type { Stops } from "@/types/static";
import { resolveStop } from "@/services/network";
import { getSolari, isStationCode } from "@/services/radar";
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
	source?: "mta-radar-solari";
	departures: Departure[];
	/** Set when the tracking system could not be reached; the board is empty. */
	error?: string;
};

function codeOf(row: Stops): string {
	return (row.stop_code ?? "").trim().toUpperCase();
}

/**
 * The departure board for a stop, with track assignments from the MTA's LIRR
 * tracking system. Only the LIRR feed publishes station codes, which is what
 * the board is keyed by, so every other stop answers with an empty board rather
 * than an error.
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

	// The board speaks in station codes, so the calls are codes and the names
	// have to come from the feed's own stops.
	const names = await stationNames(agency);

	let raw: unknown;
	try {
		raw = await getSolari(code);
	} catch (error) {
		return {
			stop,
			code,
			departures: [],
			error:
				error instanceof Error ? error.message : "Departure board unavailable",
		};
	}

	const trains = (Array.isArray(raw) ? raw : []).filter(
		(train): train is SolariDeparture =>
			typeof train === "object" && train !== null
	);

	// `stop_type` describes the event at this station: passenger stops are the
	// only thing a departure board shows, so pass-throughs, employee stops and
	// equipment moves are dropped.
	const departures: Departure[] = trains
		.filter(
			(train) => train.stop_type === undefined || train.stop_type === "STOP"
		)
		.filter(
			(train): train is SolariDeparture & { train_num: string; time: number } =>
				typeof train.train_num === "string" && Number.isFinite(train.time)
		)
		.toSorted((a, b) => a.time - b.time)
		.map((train) => {
			const codes = (train.stops ?? []).filter(
				(value): value is string => typeof value === "string"
			);
			const name = (stationCode: string) => stationNameFor(names, stationCode);
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

	return { stop, code, source: "mta-radar-solari", departures };
}
