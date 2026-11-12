import type { AgencyId } from "@/constants";
import type {
	ItineraryDraft,
	Journey,
	JourneyLeg,
	JourneyPreference,
	JourneyStep,
	Label,
	LegDesc,
	Search,
	StepDraft,
	WalkDesc,
} from "@/services/journey/types";
import type { StopRef } from "@/services/network";
import { clockOf, clockSeconds } from "@/lib/time";
import { MAX_ITINERARIES } from "@/services/journey/types";
import { directionIndexForShapes, getStopRefs } from "@/services/network";

function compareByPreference(
	a: { draft: ItineraryDraft; arrival: number },
	b: { draft: ItineraryDraft; arrival: number },
	preference: JourneyPreference
): number {
	if (preference === "fewerTransfers") {
		return (
			a.draft.legs.length - b.draft.legs.length ||
			a.arrival - b.arrival ||
			a.draft.walkSeconds - b.draft.walkSeconds
		);
	}

	if (preference === "lessWalking") {
		return (
			a.draft.walkSeconds - b.draft.walkSeconds ||
			a.arrival - b.arrival ||
			a.draft.legs.length - b.draft.legs.length
		);
	}

	return (
		a.arrival - b.arrival ||
		a.draft.legs.length - b.draft.legs.length ||
		a.draft.walkSeconds - b.draft.walkSeconds
	);
}

function hasSameRouteTransfer(legs: readonly LegDesc[]): boolean {
	for (let index = 1; index < legs.length; index++) {
		const previous = legs[index - 1];
		const current = legs[index];
		if (
			previous?.agency === current?.agency &&
			previous?.route === current?.route
		)
			return true;
	}

	return false;
}

/**
 * Destination labels become drafts, ranked by arrival or user preference
 * (`fastest`, `fewerTransfers`, `lessWalking` — inspired by Vela's
 * `TransitOrder.byPreference`). A label reached by walking only matters when
 * no ride reaches the destination or when the final walk is meaningfully
 * earlier than waiting for another train.
 */
export function rankDestinations(
	search: Search,
	preference: JourneyPreference = "fastest"
): ItineraryDraft[] {
	const dest = search.labels.get(search.destKey) ?? [];
	const byArrival = dest.toSorted((a, b) => a.arrival - b.arrival);
	const earliestRideArrival =
		byArrival.find((label) => label.via.kind === "ride")?.arrival ??
		Number.POSITIVE_INFINITY;
	// Keep ride arrivals plus any walk arrival that finishes before the earliest
	// direct ride arrival.
	const filtered = byArrival.filter(
		(label) => label.via.kind === "ride" || label.arrival < earliestRideArrival
	);
	const ranked = filtered.length > 0 ? filtered : byArrival;

	const candidates = ranked
		.flatMap((label) => {
			const draft = itineraryFrom(search, label);
			return draft && draft.legs.length > 0 && !hasSameRouteTransfer(draft.legs)
				? [{ draft, arrival: label.arrival }]
				: [];
		})
		.toSorted((a, b) => compareByPreference(a, b, preference));

	const drafts: ItineraryDraft[] = [];
	const seenTrips = new Set<string>();
	const seenPatterns = new Set<string>();

	// First take the best journey for each distinct route pattern so one popular
	// connection does not hide alternative corridors (e.g. LIRR vs subway or
	// bus + subway). Then fill remaining slots with subsequent departures.
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

	return drafts.toSorted((a, b) =>
		compareByPreference(
			{ draft: a, arrival: a.arrival },
			{ draft: b, arrival: b.arrival },
			preference
		)
	);
}

/**
 * Walk a destination label back to the start, collecting both the ride legs
 * and the explicit walk/transfer steps between them. When the chain leads with
 * a walk, time the initial walk immediately before the first ride's boarding
 * time so the itinerary never includes arbitrary pre-trip waiting time.
 */
function itineraryFrom(
	_search: Search,
	dest: Label
): ItineraryDraft | undefined {
	const chain: Label[] = [];
	let current: Label = dest;

	while (current.via.kind !== "start") {
		chain.push(current);
		current = current.via.from;
	}

	if (chain.length === 0) return undefined;

	const ordered = chain.toReversed();
	const legs: LegDesc[] = [];
	const steps: StepDraft[] = [];

	for (const step of ordered) {
		if (step.via.kind === "ride") {
			legs.push(step.via.leg);
			steps.push({ kind: "ride", leg: step.via.leg });
		} else if (step.via.kind === "walk") {
			steps.push({ kind: "walk", walk: { ...step.via.walk } });
		}
	}

	if (legs.length === 0) return undefined;

	const firstRideTime = clockSeconds(legs[0].boardTime);
	let leadingWalkSeconds = 0;
	for (const step of steps) {
		if (step.kind === "walk") leadingWalkSeconds += step.walk.durationSeconds;
		else break;
	}

	const departure =
		leadingWalkSeconds > 0
			? Math.max(current.arrival, firstRideTime - leadingWalkSeconds)
			: firstRideTime;

	// Align leading walk step timestamps with the actual departure time.
	let cursor = departure;
	for (const step of steps) {
		if (step.kind === "walk") {
			step.walk.fromTime = cursor;
			cursor += step.walk.durationSeconds;
			step.walk.toTime = cursor;
		} else {
			break;
		}
	}

	const walkSeconds = steps.reduce(
		(sum, step) => sum + (step.kind === "walk" ? step.walk.durationSeconds : 0),
		0
	);
	const walkMeters = steps.reduce(
		(sum, step) => sum + (step.kind === "walk" ? step.walk.distanceMeters : 0),
		0
	);

	return {
		departure,
		arrival: dest.arrival,
		walkSeconds,
		walkMeters,
		legs,
		steps,
	};
}

function collectDraftEntities(drafts: readonly ItineraryDraft[]): {
	stopsByAgency: Map<AgencyId, Set<string>>;
	shapesByAgency: Map<AgencyId, Set<string>>;
} {
	const stopsByAgency = new Map<AgencyId, Set<string>>();
	const shapesByAgency = new Map<AgencyId, Set<string>>();

	const addStop = (agency: AgencyId, stopId: string) => {
		let stops = stopsByAgency.get(agency);
		if (!stops) {
			stops = new Set();
			stopsByAgency.set(agency, stops);
		}

		stops.add(stopId);
	};

	const addShape = (agency: AgencyId, shapeId: string | undefined) => {
		if (!shapeId) return;
		let shapes = shapesByAgency.get(agency);
		if (!shapes) {
			shapes = new Set();
			shapesByAgency.set(agency, shapes);
		}

		shapes.add(shapeId);
	};

	for (const draft of drafts) {
		for (const step of draft.steps) {
			if (step.kind === "ride") {
				addStop(step.leg.agency, step.leg.boardStop);
				addStop(step.leg.agency, step.leg.alightStop);
				for (const stop of step.leg.intermediateStops)
					addStop(step.leg.agency, stop.id);
				addShape(step.leg.agency, step.leg.shapeId);
			} else {
				addStop(step.walk.fromFeed, step.walk.fromStation);
				addStop(step.walk.toFeed, step.walk.toStation);
			}
		}
	}

	return { stopsByAgency, shapesByAgency };
}

export async function renderItineraries(
	drafts: ItineraryDraft[]
): Promise<Journey[]> {
	const { stopsByAgency, shapesByAgency } = collectDraftEntities(drafts);

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
					[
						agency,
						await directionIndexForShapes(agency, [...shapeIds]),
					] as const
			)
		),
	]);

	const refsByAgency = new Map(refsEntries);
	const directionsByAgency = new Map(directionEntries);

	return drafts.map((draft) => {
		const legs = draft.legs.map((leg) =>
			renderLeg(leg, refsByAgency, directionsByAgency)
		);
		const steps: JourneyStep[] = draft.steps.map((step) => {
			if (step.kind === "ride") {
				const rendered = renderLeg(step.leg, refsByAgency, directionsByAgency);
				const durationSeconds = Math.max(
					0,
					clockSeconds(step.leg.alightTime) - clockSeconds(step.leg.boardTime)
				);
				return {
					kind: "ride",
					durationSeconds,
					...rendered,
				};
			}

			return renderWalkStep(step.walk, refsByAgency);
		});

		return {
			departureTime: clockOf(draft.departure),
			arrivalTime: clockOf(draft.arrival),
			durationMinutes: Math.max(
				1,
				Math.round((draft.arrival - draft.departure) / 60)
			),
			walkingDurationSeconds: draft.walkSeconds,
			walkingDistanceMeters: draft.walkMeters,
			transfers: Math.max(0, legs.length - 1),
			legs,
			steps,
		};
	});
}

function renderWalkStep(
	walk: WalkDesc,
	refsByAgency: Map<AgencyId, Map<string, StopRef | undefined>>
): JourneyStep {
	const fromRef = refsByAgency.get(walk.fromFeed)?.get(walk.fromStation);
	const toRef = refsByAgency.get(walk.toFeed)?.get(walk.toStation);

	return {
		kind: "walk",
		distanceMeters: walk.distanceMeters,
		durationSeconds: walk.durationSeconds,
		transferType: walk.transferType,
		from: {
			id: fromRef?.id ?? walk.fromStation,
			name: fromRef?.name ?? walk.fromStation,
			agency: walk.fromFeed,
			time: clockOf(walk.fromTime),
			location: fromRef?.location ?? { lat: walk.fromLat, lon: walk.fromLon },
		},
		to: {
			id: toRef?.id ?? walk.toStation,
			name: toRef?.name ?? walk.toStation,
			agency: walk.toFeed,
			time: clockOf(walk.toTime),
			location: toRef?.location ?? { lat: walk.toLat, lon: walk.toLon },
		},
	};
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
		stops: leg.stops,
		intermediateStops: leg.intermediateStops.map((stop) => {
			const ref = refs?.get(stop.id);
			return {
				id: ref?.id ?? stop.id,
				name: ref?.name ?? "",
				time: stop.time,
			};
		}),
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
