import type { ApiJourney, Search } from "@/services/journey/types";
import type { ResolvedStopIds } from "@/services/stops";
import { distanceMeters } from "@/lib/geo";
import { clockSeconds } from "@/lib/time";
import { admit, drainWalks } from "@/services/journey/labels";
import { rankDestinations, renderItineraries } from "@/services/journey/render";
import { boardRound, stationGrids } from "@/services/journey/scan";
import { MAX_RIDES, RAIL_FEEDS, rideFeedsFor } from "@/services/journey/types";
import { transferIndex } from "@/services/network";

export type { ApiJourney, Journey, JourneyLeg } from "@/services/journey/types";

/**
 * Earliest-arrival journeys on the static timetable: a round-based scan (one
 * round per ride, up to four rides), returning the best 5 by arrival with
 * distinct route patterns preferred so one popular connection does not hide
 * every other way across the network.
 *
 * Transfers match at station level: the platforms of one station count as one
 * transfer point, and cross-feed transfers are stations within a short walk
 * (GTFS ships no cross-feed transfer table, and stop ids repeat across feeds,
 * so ids are never matched across feeds, only coordinates). Every reached feed
 * can board rides, buses included, so a bus can be part of a rail-to-subway
 * trip even when neither endpoint is a bus stop. A walk link is never rendered
 * as a leg; it shows as the station change between two rides.
 */
export async function planJourney(
	from: ResolvedStopIds,
	to: ResolvedStopIds,
	options: { date: string; time: string }
): Promise<ApiJourney> {
	const { date, time } = options;
	const base = {
		from: { id: from.stop.id, name: from.stop.name },
		to: { id: to.stop.id, name: to.stop.name },
		date,
		time,
	};

	// Already at the destination (or its platform across the same complex):
	// nothing sensible to plan, and the scan would happily ride one stop away
	// and come back for it.
	if (distanceMeters(from.stop.location, to.stop.location) < 100) {
		return { ...base, itineraries: [] };
	}

	const [network, transferIndexes] = await Promise.all([
		stationGrids(),
		Promise.all(
			RAIL_FEEDS.map(async (feed) => [feed, await transferIndex(feed)] as const)
		),
	]);
	const transfers = new Map(transferIndexes);
	const search: Search = {
		labels: new Map(),
		walkQueue: [],
		grids: network.grids,
		stationsById: network.byId,
		transfers,
		destKey: `${to.agency}:${to.stop.id}`,
	};

	admit(search, {
		feed: from.agency,
		station: from.stop.id,
		lat: from.stop.location.lat,
		lon: from.stop.location.lon,
		arrival: clockSeconds(time),
		rides: 0,
		pattern: "",
		round: 0,
		via: { kind: "start" },
	});
	drainWalks(search);

	const feeds = rideFeedsFor(from.agency, to.agency);

	// Rounds must run in order: each one rides from the labels the previous
	// round produced, so the awaits are the algorithm.
	for (let round = 1; round <= MAX_RIDES; round++) {
		// eslint-disable-next-line no-await-in-loop
		const added = await boardRound(search, round, feeds, date);
		if (added === 0) break;
	}

	return {
		...base,
		itineraries: await renderItineraries(rankDestinations(search)),
	};
}
