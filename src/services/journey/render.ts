import type {
	ItineraryDraft,
	Journey,
	JourneyLeg,
	Label,
	LegDesc,
	Search,
} from "@/services/journey/types";
import { clockOf, clockSeconds } from "@/lib/time";
import { MAX_ITINERARIES, WALK_S } from "@/services/journey/types";
import { directionIndex, getStopRef } from "@/services/network";

/** Destination labels become drafts, ranked by arrival. A label reached by
 * walking only matters when no ride reaches the destination: a trailing
 * transfer hop after the train already arrived is noise. */
export function rankDestinations(search: Search): ItineraryDraft[] {
	const dest = search.labels.get(search.destKey) ?? [];
	const byArrival = dest.toSorted((a, b) => a.arrival - b.arrival);
	const rideArrivals = byArrival.filter((label) => label.via.kind === "ride");
	const ranked = rideArrivals.length > 0 ? rideArrivals : byArrival;
	const seen = new Set<string>();
	const drafts: ItineraryDraft[] = [];

	for (const label of ranked) {
		const draft = itineraryFrom(search, label);
		if (!draft || draft.legs.length === 0) continue;

		const fingerprint = `${label.arrival}|${draft.legs.at(-1)?.tripId ?? ""}`;
		if (seen.has(fingerprint)) continue;

		seen.add(fingerprint);
		drafts.push(draft);
		if (drafts.length === MAX_ITINERARIES) break;
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

	const departure =
		ordered[0]?.via.kind === "walk"
			? ordered[0].arrival - WALK_S
			: clockSeconds(legs[0].boardTime);

	return { departure, arrival: dest.arrival, legs };
}

export async function renderItineraries(
	drafts: ItineraryDraft[]
): Promise<Journey[]> {
	const rendered = await Promise.all(
		drafts.map(async (draft) => ({
			...draft,
			legs: await Promise.all(draft.legs.map(async (leg) => renderLeg(leg))),
		}))
	);

	return rendered.map((draft) => ({
		departureTime: clockOf(draft.departure),
		arrivalTime: clockOf(draft.arrival),
		durationMinutes: Math.round((draft.arrival - draft.departure) / 60),
		legs: draft.legs,
	}));
}

async function renderLeg(leg: LegDesc): Promise<JourneyLeg> {
	const [fromRef, toRef, directions] = await Promise.all([
		getStopRef(leg.agency, leg.boardStop),
		getStopRef(leg.agency, leg.alightStop),
		directionIndex(leg.agency),
	]);

	return {
		route: leg.route,
		agency: leg.agency,
		headsign: leg.headsign,
		direction: directions.get(leg.shapeId ?? "") ?? "",
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
