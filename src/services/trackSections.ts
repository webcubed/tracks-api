import { memoize } from "@/lib/memoize";
import { getCountdown, getLocations } from "@/services/radar";
import { stationNameFor, stationNames } from "@/services/stationCodes";

/**
 * Track sections: the pieces of track the LIRR's own tracking system runs
 * trains over, named with its designations — `W2` (West Side Yard, track 2),
 * `R8` (Main Line), `X1` (Penn Station east). The MTA's GTFS feeds never
 * mention them; only the Radar event and stop lists do, and they are how a
 * train's place on the railroad can be named before any position is reported.
 */

/** One end of a track section: a location on the railroad's own chart. */
export type TrackSectionPoint = {
	/** The network's abbreviation, e.g. `WSE`, `NYK`, `JAM`. */
	code: string;
	/** The feed's station name when the code is a station, else the code. */
	name: string;
	/** Unix seconds: recorded where the feed has one, scheduled otherwise. */
	time?: number;
};

/** The track section a train is on: where it is, where it runs next, and the track it is using. */
export type TrackSection = {
	/** The section's track designation, e.g. `W2`. */
	track?: string;
	/** The last location the train reached — where the section starts. */
	from?: TrackSectionPoint;
	/** The next location on its run — where the section ends. */
	to?: TrackSectionPoint;
};

/** One car in a train's consist, as the LIRR tracking system reports it. */
export type TrainCar = {
	/** The railroad's car number, e.g. `7488`. */
	number?: number;
	/** The car class, e.g. `M7`. */
	type?: string;
	/** Occupancy value such as `EMPTY`, `MANY_SEATS` or `FEW_SEATS`. */
	loading?: string;
	/** Riders counted aboard this car, when the railroad reports a count. */
	passengers?: number;
	restroom?: boolean;
	revenue?: boolean;
	bikes?: number;
	locomotive?: boolean;
};

/** The cars making up one train, in the order the tracking system lists them. */
export type TrainConsist = {
	fleet?: string;
	cars: TrainCar[];
	/** Car count the railroad reports, which can differ from `cars.length`. */
	actualLength?: number;
	scheduledLength?: number;
	/** Occupancy for the whole train, using the same values as a car. */
	occupancy?: string;
	updatedAt?: number;
};

/** The event shape both run lookups produce; kept structural to avoid a cycle. */
export type SectionEvent = {
	code: string;
	name: string;
	track?: string;
	time?: number;
	/** True once the train has actually been there. */
	passed: boolean;
	/** True once the train has left again. */
	departed?: boolean;
};

/**
 * The section from a run's last passed location to the next one ahead. The
 * entries run in travel order, so the split is the last passed one: a
 * scheduled-but-unrecorded point before it is history noise, not something
 * ahead of the train.
 *
 * The track is the one the train is on *now*: the label at the point it is
 * sitting at (`W2` in West Side Yard), or — once it has left again — the one
 * of the section it is running into.
 */
export function sectionFromEvents(
	events: SectionEvent[]
): TrackSection | undefined {
	let lastPassed = -1;
	for (let index = 0; index < events.length; index++)
		if (events[index].passed) lastPassed = index;

	const from = lastPassed >= 0 ? events[lastPassed] : undefined;
	const to = events.slice(lastPassed + 1).find((event) => !event.passed);
	if (!from && !to) return undefined;

	const track = currentTrack(from, to);
	return {
		...(track ? { track } : {}),
		...(from ? { from: pointOf(from) } : {}),
		...(to ? { to: pointOf(to) } : {}),
	};
}

function pointOf(event: SectionEvent): TrackSectionPoint {
	return {
		code: event.code,
		name: event.name,
		...(event.time === undefined ? {} : { time: event.time }),
	};
}

/**
 * The track the train is using, given where it is and where it is going: the
 * label at the point behind while the train sits at it, and the label of the
 * point ahead once the train has left.
 */
function currentTrack(
	from: { track?: string; departed?: boolean } | undefined,
	to: { track?: string } | undefined
): string | undefined {
	return from?.departed
		? (to?.track ?? from.track)
		: (from?.track ?? to?.track);
}

/** The stop shape of the locations feed, narrowed to what a section needs. */
export type SectionStop = {
	code: string;
	/** Posted track at the stop. */
	signTrack?: string;
	/** The track designation of the section into the stop, e.g. `R8`. */
	sectionTrack?: string;
	time?: number;
	/** True once the train has actually been there. */
	passed: boolean;
	/** True once the train has left again. */
	departed?: boolean;
};

/**
 * The same section, derived from a locations stop list when no event list is
 * available. `currentCode` — the tracking system's `otp_location` or `nearby`
 * tag — stands in as the section's start before the train has reached a stop,
 * so a train still in the yard names its section before its position is out.
 */
export function sectionFromStops(
	stops: SectionStop[],
	currentCode?: string,
	names?: Map<string, string>
): TrackSection | undefined {
	let lastPassed = -1;
	for (let index = 0; index < stops.length; index++)
		if (stops[index].passed) lastPassed = index;

	const fromStop = lastPassed >= 0 ? stops[lastPassed] : undefined;
	const to = stops.slice(lastPassed + 1).find((stop) => !stop.passed);
	if (!fromStop && !to && !currentCode) return undefined;

	const name = (code: string) => (names ? stationNameFor(names, code) : code);
	const from: TrackSectionPoint | undefined = fromStop
		? {
				code: fromStop.code,
				name: name(fromStop.code),
				...(fromStop.time === undefined ? {} : { time: fromStop.time }),
			}
		: currentCode
			? { code: currentCode, name: name(currentCode) }
			: undefined;
	const track = currentTrack(
		fromStop
			? {
					track: fromStop.sectionTrack ?? fromStop.signTrack,
					departed: fromStop.departed,
				}
			: undefined,
		to ? { track: to.sectionTrack ?? to.signTrack } : undefined
	);

	return {
		...(track ? { track } : {}),
		...(from ? { from } : {}),
		...(to
			? {
					to: {
						code: to.code,
						name: name(to.code),
						...(to.time === undefined ? {} : { time: to.time }),
					},
				}
			: {}),
	};
}

/**
 * The run as its own segment: an LIRR vehicle id names the run it is making
 * among its segments (`GO202_26_8758_1_V` runs as `8758`, an equipment move
 * like `RA2KOX` as itself), so a segment match ties the two together.
 */
export function trainSegments(id: string): string[] {
	return id
		.split("_")
		.map((segment) => segment.trim())
		.filter(Boolean);
}

/**
 * The run a vehicle id names. A GO id is `<day>_<date>_<run>_<direction>_V`,
 * and only its run segment is a train number: including the date once matched
 * train `26` for every train on the 26th. Equipment moves use their id.
 */
export function trainRun(vehicleId: string): string | undefined {
	const segments = trainSegments(vehicleId.trim());
	if (segments.length === 0) return undefined;
	return segments[0]?.startsWith("GO") ? segments[2] : segments[0];
}

/** What the tracking system knows about one live train. */
export type RadarTrainInfo = {
	train?: string;
	section?: TrackSection;
	location?: { lat: number; lon: number };
	/** Closest infrastructure tag, e.g. `JAM-W`, `WSY`. */
	nearby?: string;
	/** The operational sector the train is on. */
	turf?: { length: number; locationMp: number };
	/** Cars and their occupancy, when the train is reporting a consist. */
	consist?: TrainConsist;
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

type RadarStop = {
	code?: string;
	stop_type?: string;
	stop_status?: string;
	sign_track?: string;
	t2s_track?: string;
	sched_time?: number;
	act_arrive_time?: number;
	act_depart_time?: number;
	act_time?: number;
};

type RadarCar = {
	type?: string;
	number?: number;
	loading?: string;
	passengers?: number;
	restroom?: boolean;
	revenue?: boolean;
	bikes?: number;
	locomotive?: boolean;
};

type RadarConsist = {
	fleet?: string;
	cars?: RadarCar[];
	actual_len?: number;
	sched_len?: number;
	occupancy?: string;
	occupancy_timestamp?: number;
};

type RadarTrain = {
	train_num?: string;
	details?: {
		events?: RadarEvent[];
		stops?: RadarStop[];
		turf?: { length?: number; location_mp?: number };
	};
	consist?: RadarConsist;
	location?: {
		latitude?: number;
		longitude?: number;
		nearby?: string;
	};
	status?: { otp_location?: string };
};

function isRadarTrain(value: unknown): value is RadarTrain {
	return typeof value === "object" && value !== null;
}

/** Keep only the fields the API publishes, with camelCase names. */
export function consistOf(train: RadarTrain): TrainConsist | undefined {
	const raw = train.consist;
	if (!raw) return undefined;

	const cars = (raw.cars ?? []).flatMap((car) => {
		if (car.number === undefined && !car.type) return [];
		return [
			{
				...(car.number === undefined ? {} : { number: car.number }),
				...(car.type ? { type: car.type } : {}),
				...(car.loading ? { loading: car.loading } : {}),
				...(car.passengers === undefined ? {} : { passengers: car.passengers }),
				...(car.restroom === undefined ? {} : { restroom: car.restroom }),
				...(car.revenue === undefined ? {} : { revenue: car.revenue }),
				...(car.bikes === undefined ? {} : { bikes: car.bikes }),
				...(car.locomotive === undefined ? {} : { locomotive: car.locomotive }),
			},
		];
	});
	if (cars.length === 0) return undefined;

	return {
		cars,
		...(raw.fleet ? { fleet: raw.fleet } : {}),
		...(raw.actual_len === undefined ? {} : { actualLength: raw.actual_len }),
		...(raw.sched_len === undefined ? {} : { scheduledLength: raw.sched_len }),
		...(raw.occupancy ? { occupancy: raw.occupancy } : {}),
		...(raw.occupancy_timestamp === undefined
			? {}
			: { updatedAt: raw.occupancy_timestamp }),
	};
}

function eventTime(event: RadarEvent): number | undefined {
	return (
		event.act_arrive ??
		event.act_depart ??
		event.act_time ??
		event.oper_time ??
		event.sched_time
	);
}

function stopTime(stop: RadarStop): number | undefined {
	return (
		stop.act_arrive_time ??
		stop.act_depart_time ??
		stop.act_time ??
		stop.sched_time
	);
}

function eventsOf(
	train: RadarTrain,
	names: Map<string, string>
): SectionEvent[] {
	return (train.details?.events ?? []).flatMap((event) => {
		const code = (event.code ?? "").trim().toUpperCase();
		if (!code) return [];
		const track = (event.act_track ?? event.sched_track)?.trim();
		const time = eventTime(event);

		return [
			{
				code,
				name: stationNameFor(names, code),
				...(track ? { track } : {}),
				...(time === undefined ? {} : { time }),
				passed:
					event.act_arrive !== undefined ||
					event.act_depart !== undefined ||
					event.act_time !== undefined,
				departed: event.act_depart !== undefined,
			},
		];
	});
}

function stopsOf(train: RadarTrain, names: Map<string, string>): SectionStop[] {
	return (train.details?.stops ?? []).flatMap((stop) => {
		const code = (stop.code ?? "").trim().toUpperCase();
		if (!code) return [];
		const sectionTrack = (stop.t2s_track ?? "").trim();
		const signTrack = (stop.sign_track ?? "").trim();
		const time = stopTime(stop);

		return [
			{
				code,
				...(signTrack ? { signTrack } : {}),
				...(sectionTrack ? { sectionTrack } : {}),
				...(time === undefined ? {} : { time }),
				passed:
					stop.stop_status === "DEPARTED" ||
					stop.act_arrive_time !== undefined ||
					stop.act_depart_time !== undefined ||
					stop.act_time !== undefined,
				departed:
					stop.stop_status === "DEPARTED" || stop.act_depart_time !== undefined,
			},
		];
	});
}

function sectionOf(
	train: RadarTrain,
	names: Map<string, string>
): TrackSection | undefined {
	const fromEvents = sectionFromEvents(eventsOf(train, names));
	if (fromEvents) return fromEvents;

	const currentCode = (
		train.status?.otp_location ??
		train.location?.nearby ??
		""
	)
		.trim()
		.toUpperCase();
	return sectionFromStops(
		stopsOf(train, names),
		currentCode || undefined,
		names
	);
}

/**
 * Hubs whose countdown boards name the yards and interlockings — the only
 * place designations like `W2` appear. Penn serves West Side Yard and the
 * East River tunnels; Grand Central Madison covers its own interlockings.
 */
const SECTION_HUBS = ["NYK", "GCT"];

/**
 * Every live train the tracking system reports, keyed by advertised train
 * number, with its current track section. Refreshed on the tracking host's own
 * ten-second cadence and shared by every vehicle and run lookup.
 */
export const radarTrains = memoize(
	async (): Promise<Map<string, RadarTrainInfo>> => {
		const names = await stationNames("lirr");
		const [locations, ...boards] = await Promise.all([
			getLocations("LIRR", "TRACK_TURF").catch(() => undefined),
			...SECTION_HUBS.map(async (code) =>
				getCountdown(code, { includePassed: true, hours: 3 }).catch(
					() => undefined
				)
			),
		]);

		const trains = new Map<string, RadarTrainInfo>();
		for (const raw of asTrains(locations)) addTrain(trains, raw, false, names);
		// Board events carry the yard and interlocking designations the
		// locations stop lists omit, so they win where the two disagree.
		for (const board of boards)
			for (const raw of asTrains(board)) addTrain(trains, raw, true, names);

		return trains;
	},
	10_000
);

function asTrains(payload: unknown): RadarTrain[] {
	return (Array.isArray(payload) ? payload : []).filter((train) =>
		isRadarTrain(train)
	);
}

function addTrain(
	trains: Map<string, RadarTrainInfo>,
	raw: RadarTrain,
	fromBoard: boolean,
	names: Map<string, string>
): void {
	const train = (raw.train_num ?? "").trim();
	if (!train) return;

	const incoming = infoOf(raw, fromBoard, names);
	const existing = trains.get(train);
	if (!existing) {
		trains.set(train, incoming);
		return;
	}

	trains.set(train, {
		train: incoming.train ?? existing.train,
		// A board-derived section knows the yard designations; keep it over a
		// later stop-list one, and never let a stop list displace it.
		section:
			fromBoard && incoming.section
				? incoming.section
				: (existing.section ?? incoming.section),
		location: existing.location ?? incoming.location,
		nearby: existing.nearby ?? incoming.nearby,
		turf: existing.turf ?? incoming.turf,
		consist: existing.consist ?? incoming.consist,
	});
}

function infoOf(
	train: RadarTrain,
	fromBoard: boolean,
	names: Map<string, string>
): RadarTrainInfo {
	const location =
		train.location?.latitude !== undefined &&
		train.location.longitude !== undefined
			? { lat: train.location.latitude, lon: train.location.longitude }
			: undefined;
	const nearby =
		(train.location?.nearby ?? "").trim().toUpperCase() || undefined;
	const turf =
		train.details?.turf?.length !== undefined &&
		train.details.turf.location_mp !== undefined
			? {
					length: train.details.turf.length,
					locationMp: train.details.turf.location_mp,
				}
			: undefined;
	const section = fromBoard
		? (sectionFromEvents(eventsOf(train, names)) ?? sectionOf(train, names))
		: sectionOf(train, names);
	const consist = consistOf(train);

	return {
		train: (train.train_num ?? "").trim() || undefined,
		...(section ? { section } : {}),
		...(location ? { location } : {}),
		...(nearby ? { nearby } : {}),
		...(turf ? { turf } : {}),
		...(consist ? { consist } : {}),
	};
}

/** Tie a realtime vehicle id to the tracking system's train. */
export function matchRadarTrain(
	vehicleId: string,
	trains: Map<string, RadarTrainInfo>
): RadarTrainInfo | undefined {
	const id = vehicleId.trim();
	const direct = trains.get(id);
	if (direct) return direct;

	const run = trainRun(id);
	return run ? trains.get(run) : undefined;
}
