import type { AgencyId } from "@/constants";
import type {
	ItineraryDraft,
	Journey,
	JourneyLeg,
	Label,
	LegDesc,
	Search,
} from "@/services/journey/types";
import type { StopRef } from "@/services/network";
import { clockOf, clockSeconds } from "@/lib/time";
import { MAX_ITINERARIES } from "@/services/journey/types";
import { directionIndexForShapes, getStopRefs } from "@/services/network";

/** Destination labels become drafts, ranked by arrival. A label reached by
 * walking only matters when no ride reaches the destination: a trailing
 * transfer hop after the train already arrived is noise. */
export function rankDestinations(search: Search): ItineraryDraft[] {
	const dest = search.labels.get(search.destKey) ?? [];
	const byArrival = dest.toSorted((a, b) => a.arrival - b.arrival);
	const rideArrivals = byArrival.filter((label) => label.via.kind === "ride");
	const ranked = rideArrivals.length > 0 ? rideArrivals : byArrival;
	const candidates = ranked.flatMap((label) => {
		const draft = itineraryFrom(search, label);
		return draft && draft.legs.length > 0
			? [{ draft, arrival: label.arrival }]
			: [];
	});
	const drafts: ItineraryDraft[] = [];
	const seenTrips = new Set<string>();
	const seenPatterns = new Set<string>();

	// First take the fastest journey for each distinct route pattern. Otherwise
	// the first five may all be the same LIRR train to Penn, followed by the
	// 1/2/3 from the same transfer, hiding a faster Q28→7 or Grand Central→S
	// option just below them. Then fill remaining slots with the next scheduled
	// departures, preserving the useful "next train" behaviour.
	for (const { draft, arrival } of candidates) {
		const pattern = draft.legs
			.map((leg) => `${leg.agency}:${leg.route}`)
			.join("|");
		const tripKey = `${arrival}|${draft.legs.at(-1)?.tripId ?? ""}`;
		if (seenPatterns.has(pattern) || seenTrips.has(tripKey)) continue;

		seenPatterns.add(pattern);
		seenTrips.add(tripKey);
		drafts.push(draft);
		if (drafts.length === MAX_ITINERARIES) return drafts;
	}

	for (const { draft, arrival } of candidates) {
		if (drafts.length === MAX_ITINERARIES) break;
		const tripKey = `${arrival}|${draft.legs.at(-1)?.tripId ?? ""}`;
		if (seenTrips.has(tripKey)) continue;

		seenTrips.add(tripKey);
		drafts.push(draft);
	}

	return drafts;
}

/**
 * Walk a destination label back to the start. Walking stays implicit: when
 * the chain leads with a walk, the journey departs at the query time (you can
 * leave now); from a direct ride it departs at the boarding time.
 */
function itineraryFrom(
	search: Search,
	dest: Label
): ItineraryDraft | undefined {
	const steps: Label[] = [];
	let current: Label = dest;

	while (current.via.kind !== "start") {
		steps.push(current);
		current = current.via.from;
	}

	if (steps.length === 0) return undefined;

	const ordered = steps.toReversed();
	const legs: LegDesc[] = [];

	for (const step of ordered) {
		if (step.via.kind === "ride") legs.push(step.via.leg);
	}

	if (legs.length === 0) return undefined;

	// The origin label is still `current`: when the chain begins with one or
	// more implicit walks, count those minutes from the requested departure,
	// instead of backing out just the first walk and under-reporting a transfer
	// path such as origin → bus stop → subway.
	const departure =
		ordered[0]?.via.kind === "walk"
			? current.arrival
			: clockSeconds(legs[0].boardTime);

	return { departure, arrival: dest.arrival, legs };
}

export async function renderItineraries(
	drafts: ItineraryDraft[]
): Promise<Journey[]> {
	const legs = drafts.flatMap((draft) => draft.legs);
	const stopsByAgency = new Map<AgencyId, Set<string>>();
	const shapesByAgency = new Map<AgencyId, Set<string>>();
	for (const leg of legs) {
		let stops = stopsByAgency.get(leg.agency);
		if (!stops) {
			stops = new Set();
			stopsByAgency.set(leg.agency, stops);
		}
		stops.add(leg.boardStop);
		stops.add(leg.alightStop);

		if (leg.shapeId) {
			let shapes = shapesByAgency.get(leg.agency);
			if (!shapes) {
				shapes = new Set();
				shapesByAgency.set(leg.agency, shapes);
			}
			shapes.add(leg.shapeId);
		}
	}

	const [refsEntries, directionEntries] = await Promise.all([
		Promise.all(
			[...stopsByAgency].map(
				async ([agency, stopIds]) =>
					[agency, await getStopRefs(agency, [...stopIds])] as const
			)
		),
		Promise.all(
			[...shapesByAgency].map(
				async ([agency, shapeIds]) =>
					[agency, await directionIndexForShapes(agency, [...shapeIds])] as const
			)
		),
	]);

	const refsByAgency = new Map(refsEntries);
	const directionsByAgency = new Map(directionEntries);

	return drafts.map((draft) => ({
		departureTime: clockOf(draft.departure),
		arrivalTime: clockOf(draft.arrival),
		durationMinutes: Math.round((draft.arrival - draft.departure) / 60),
		legs: draft.legs.map((leg) =>
			renderLeg(leg, refsByAgency, directionsByAgency)
		),
	}));
}

function renderLeg(
	leg: LegDesc,
	refsByAgency: Map<AgencyId, Map<string, StopRef | undefined>>,
	directionsByAgency: Map<AgencyId, Map<string, string>>
): JourneyLeg {
	const refs = refsByAgency.get(leg.agency);
	const fromRef = refs?.get(leg.boardStop);
	const toRef = refs?.get(leg.alightStop);

	return {
		route: leg.route,
		agency: leg.agency,
		headsign: leg.headsign,
		direction: directionsByAgency.get(leg.agency)?.get(leg.shapeId ?? "") ?? "",
		tripId: leg.tripId,
		from: {
			id: fromRef?.id ?? leg.boardStop,
			name: fromRef?.name ?? "",
			time: leg.boardTime,
		},
		to: {
			id: toRef?.id ?? leg.alightStop,
			name: toRef?.name ?? "",
			time: leg.alightTime,
		},
	};
}
