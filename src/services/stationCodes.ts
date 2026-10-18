import type { AgencyId } from "@/constants";
import { memoize } from "@/lib/memoize";
import { stopIndex } from "@/services/network";

/**
 * Station code → station name, taken from the feed's own stops. The LIRR is
 * the only feed that publishes codes, and they are how both the departure
 * boards and the tracking system address every location.
 */
export const stationNames = memoize(async (agency: AgencyId) => {
	const names = new Map<string, string>();
	const index = await stopIndex(agency);

	for (const row of index.topLevel) {
		const code = (row.stop_code ?? "").trim().toUpperCase();
		if (code) names.set(code, row.stop_name);
	}

	return names;
});

/**
 * The name a code refers to, or the code itself when the static feed does not
 * carry it. Interlockings, yards and junctions are named only inside the
 * tracking system's operational event lists, so a code is the best name
 * available for them.
 */
export function stationNameFor(
	names: Map<string, string>,
	code: string
): string {
	const normalised = code.trim().toUpperCase();
	return names.get(normalised) ?? normalised;
}
