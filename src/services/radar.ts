import { memoize } from "@/lib/memoize";

/**
 * The MTA's LIRR "Radar" host: the tracking system behind the departure boards
 * in stations. It is a different system from the GTFS feeds this API is built
 * on — it is the only source of track assignments — so callers are expected to
 * treat its failures as "no board right now" rather than as a GTFS problem.
 */
const RADAR_BASE = "https://backend-unified.mylirr.org";

/** Station codes are three letters or digits, e.g. `NYK` or `BTA`. */
export function isStationCode(code: string): boolean {
	if (code.length !== 3) return false;

	for (const character of code)
		if (!isStationCodeCharacter(character)) return false;

	return true;
}

function isStationCodeCharacter(character: string): boolean {
	return (
		(character >= "A" && character <= "Z") ||
		(character >= "0" && character <= "9")
	);
}

export class RadarUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RadarUnavailableError";
	}
}

/**
 * Solari boards change with every track posting, so they are cached briefly and
 * shared between callers: the same station is often open in several tabs, and
 * the tracking host is a public endpoint that should not be hammered per poll.
 */
const fetchSolari = memoize(async (code: string): Promise<unknown> => {
	let response: Response;

	try {
		response = await fetch(`${RADAR_BASE}/solari/${encodeURIComponent(code)}`, {
			headers: { "Accept-Version": "3.0" },
			signal: AbortSignal.timeout(15_000),
		});
	} catch (error) {
		throw new RadarUnavailableError(
			`tracking system request failed: ${error instanceof Error ? error.message : String(error)}`
		);
	}

	if (response.status >= 300) {
		throw new RadarUnavailableError(
			`tracking system responded ${response.status}`
		);
	}

	try {
		return await response.json();
	} catch {
		throw new RadarUnavailableError("tracking system returned invalid JSON");
	}
}, 10_000);

/**
 * The countdown board for a station: the trains serving it in the requested
 * window, each carrying the operational events of its whole run. That event
 * list is the only place the network's non-passenger locations — yards,
 * interlockings, junctions — are named.
 */
const fetchCountdown = memoize(
	async (
		code: string,
		includePassed: boolean,
		hours: number
	): Promise<unknown> => {
		const url = new URL(`${RADAR_BASE}/countdown/${encodeURIComponent(code)}`);
		url.searchParams.set("include_passed", String(includePassed));
		url.searchParams.set("hours", String(hours));

		let response: Response;
		try {
			response = await fetch(url, {
				headers: { "Accept-Version": "3.0" },
				signal: AbortSignal.timeout(15_000),
			});
		} catch (error) {
			throw new RadarUnavailableError(
				`tracking system request failed: ${error instanceof Error ? error.message : String(error)}`
			);
		}

		if (response.status >= 300) {
			throw new RadarUnavailableError(
				`tracking system responded ${response.status}`
			);
		}

		try {
			return await response.json();
		} catch {
			throw new RadarUnavailableError("tracking system returned invalid JSON");
		}
	},
	10_000
);

/** The raw Solari departure list for a three-letter station code. */
export async function getSolari(code: string): Promise<unknown> {
	return fetchSolari(code);
}

/** The raw countdown list of trains at a three-letter station code. */
export async function getCountdown(
	code: string,
	options: { includePassed: boolean; hours: number }
): Promise<unknown> {
	return fetchCountdown(code, options.includePassed, options.hours);
}
