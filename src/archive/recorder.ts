import type { ColumnSpec, Row } from "@/archive/parquet";
import type { ApiVehicle } from "@/services/vehicles";
import type { FeedEntity } from "@/types/realtime";

/**
 * What the archive keeps, and why only this.
 *
 * `lirr_fleet` is one row per live train per sample: the consist is what makes
 * a car's day traceable, and the branch plus section is what says where it
 * went. `arrivals` is one row per trip per stop per sample: the delay the feed
 * predicted for a stop. The last row a `(trip, stop)` pair gets is the delay it
 * actually arrived with, which is the only reliability signal a feed offers.
 *
 * Bus reliability is deliberately absent: the bus feed publishes arrival
 * predictions for stops a rider asks about, not a per-trip stop list, so there
 * is nothing stable to compare against. Bus and subway frequency comes from the
 * timetable instead (see `services/analytics.ts`).
 */
export const FLEET_COLUMNS: ColumnSpec[] = [
	{ name: "ts", type: "BIGINT" },
	{ name: "train", type: "VARCHAR" },
	{ name: "branch", type: "VARCHAR" },
	{ name: "fleet", type: "VARCHAR" },
	{ name: "cars", type: "VARCHAR" },
	{ name: "car_count", type: "INTEGER" },
	{ name: "lat", type: "DOUBLE" },
	{ name: "lon", type: "DOUBLE" },
	{ name: "next_stop", type: "VARCHAR" },
	{ name: "next_stop_id", type: "VARCHAR" },
	{ name: "section", type: "VARCHAR" },
];

export const ARRIVAL_COLUMNS: ColumnSpec[] = [
	{ name: "ts", type: "BIGINT" },
	{ name: "agency", type: "VARCHAR" },
	{ name: "route", type: "VARCHAR" },
	{ name: "trip", type: "VARCHAR" },
	{ name: "stop", type: "VARCHAR" },
	{ name: "scheduled", type: "BIGINT" },
	{ name: "predicted", type: "BIGINT" },
	{ name: "delay", type: "INTEGER" },
];

/** One row per live LIRR train: identity, consist, position, next stop. */
export function captureLirrFleet(
	vehicles: readonly ApiVehicle[],
	now: number
): Row[] {
	return vehicles.flatMap((vehicle): Row[] => {
		const { consist, label, location, section, train: reported } = vehicle;
		const numbers = (consist?.cars ?? []).flatMap((car) =>
			car.number === undefined ? [] : [String(car.number)]
		);
		const train = reported ?? label ?? vehicle.id;

		return [
			[
				now,
				train,
				vehicle.route,
				vehicle.fleet ?? consist?.fleet?.trim().toUpperCase() ?? "",
				numbers.join(" "),
				numbers.length > 0 ? numbers.length : (consist?.actualLength ?? 0),
				location?.lat,
				location?.lon,
				vehicle.nextStop,
				vehicle.nextStopId,
				section?.from && section.to
					? `${section.from.code}:${section.to.code}`
					: undefined,
			],
		];
	});
}

/** A delay the feed reported for one stop, as seconds from the timetable. */
function delayOf(
	arrival: { time?: string | number; delay?: string | number } | undefined
): number | undefined {
	if (arrival?.delay === undefined) return undefined;

	return Number(arrival.delay);
}

/** One row per trip and stop that the feed still predicts a time for. */
export function captureArrivals(
	agency: string,
	entities: readonly FeedEntity[],
	now: number
): Row[] {
	return entities.flatMap((entity): Row[] => {
		const update = entity.tripUpdate;
		const trip = update?.trip?.tripId;
		if (!update || !trip) return [];

		return (update.stopTimeUpdate ?? []).flatMap((stopTime): Row[] => {
			const { arrival, departure, stopId: stop } = stopTime;
			const predicted = Number(arrival?.time ?? departure?.time ?? Number.NaN);
			if (!stop || !Number.isFinite(predicted)) return [];

			const delay = delayOf(arrival) ?? delayOf(departure);

			return [
				[
					now,
					agency,
					update.trip?.routeId ?? "",
					trip,
					stop,
					delay === undefined ? undefined : predicted - delay,
					predicted,
					delay,
				],
			];
		});
	});
}

type SeenArrival = { delay: number | undefined; ts: number };

/** A repeat prediction this soon, this unchanged, adds nothing. */
const KEEPALIVE_SECONDS = 300;
/** A prediction that moved by this much is news even inside the keepalive. */
const MOVED_SECONDS = 60;
/**
 * A prediction not seen in four keepalive windows is finished, not deduplicated:
 * one extra row is cheaper than holding its key for the rest of the day.
 */
const SEEN_TTL_SECONDS = KEEPALIVE_SECONDS * 4;

/** A positive whole number from the environment, else the fallback. */
function positiveInteger(name: string, fallback: number): number {
	const configured = Number(process.env[name]);
	return Number.isInteger(configured) && configured > 0 ? configured : fallback;
}

/**
 * Rows held between flushes, per dataset. A flush every fifteen minutes keeps
 * roughly a thousand fleet rows and tens of thousands of arrival rows; these
 * caps are the ceiling for a storage outage, not the working size. Measured on
 * this shape, a buffered row costs about 400 bytes of heap, so the pair bounds
 * the buffer near 55 MB: the server's own `--max-old-space-size` is 256, and a
 * 512 MB host also carries two DuckDB instances and the live API.
 */
export const MAX_FLEET_ROWS = positiveInteger("ARCHIVE_BUFFER_FLEET", 20_000);
export const MAX_ARRIVAL_ROWS = positiveInteger(
	"ARCHIVE_BUFFER_ARRIVALS",
	120_000
);

export type ArchiveLimits = { fleet: number; arrivals: number };

const DEFAULT_LIMITS: ArchiveLimits = {
	fleet: MAX_FLEET_ROWS,
	arrivals: MAX_ARRIVAL_ROWS,
};

/**
 * Samples between flushes. Each arrival row is only kept when the delay is new,
 * has moved by a minute, or the keepalive expires; a train holding at +2
 * minutes for half an hour is one row, not thirty. Fleet rows are never
 * collapsed: the car trace is the sequence of positions.
 */
export class ArchiveBuffer {
	fleet: Row[] = [];
	arrivals: Row[] = [];
	private readonly seen = new Map<string, SeenArrival>();
	private readonly limits: ArchiveLimits;
	private droppedRows = 0;

	constructor(limits: ArchiveLimits = DEFAULT_LIMITS) {
		this.limits = limits;
	}

	addFleet(rows: Row[]): void {
		this.fleet.push(...rows);
		this.trim("fleet");
	}

	addArrivals(rows: Row[]): number {
		let kept = 0;

		for (const row of rows) {
			const [, agency, , trip, stop] = row;
			const delay = row[7] === undefined ? undefined : Number(row[7]);
			const ts = Number(row[0]);
			const key = `${String(agency)}|${String(trip)}|${String(stop)}`;
			const previous = this.seen.get(key);
			const moved =
				previous?.delay === undefined ||
				delay === undefined ||
				Math.abs(delay - previous.delay) >= MOVED_SECONDS;
			const expired = !previous || ts - previous.ts >= KEEPALIVE_SECONDS;

			if (!previous || moved || expired) {
				this.arrivals.push(row);
				this.seen.set(key, { delay, ts });
				kept += 1;
			}
		}

		this.trim("arrivals");

		return kept;
	}

	/**
	 * Rows near the cap mean the flush timer is outrunning the buffer: flush now
	 * rather than let the cap drop samples that were already recorded.
	 */
	get crowded(): boolean {
		return (
			this.fleet.length >= this.limits.fleet * 0.75 ||
			this.arrivals.length >= this.limits.arrivals * 0.75
		);
	}

	get size(): number {
		return this.fleet.length + this.arrivals.length;
	}

	/** Rows the cap discarded since this was last asked for. */
	takeDropped(): number {
		const dropped = this.droppedRows;
		this.droppedRows = 0;

		return dropped;
	}

	drain(): { fleet: Row[]; arrivals: Row[] } {
		const drained = { fleet: this.fleet, arrivals: this.arrivals };
		this.fleet = [];
		this.arrivals = [];
		this.pruneSeen(Math.floor(Date.now() / 1000));

		return drained;
	}

	/** A failed flush's rows go back in front, oldest first, still inside the cap. */
	restore(rows: { fleet: Row[]; arrivals: Row[] }): void {
		if (rows.fleet.length > 0) {
			this.fleet = [...rows.fleet, ...this.fleet];
			this.trim("fleet");
		}

		if (rows.arrivals.length > 0) {
			this.arrivals = [...rows.arrivals, ...this.arrivals];
			this.trim("arrivals");
		}
	}

	/**
	 * Past the cap the oldest rows go. The archive is a record of what ran, but a
	 * process that dies has no archive at all: dropping the tail of an outage is
	 * the only way a storage outage does not take the API down with it.
	 */
	private trim(dataset: "fleet" | "arrivals"): void {
		const rows = this[dataset];
		const limit = this.limits[dataset];
		if (rows.length <= limit) return;

		const excess = rows.length - limit;
		rows.splice(0, excess);
		this.droppedRows += excess;
	}

	private pruneSeen(now: number): void {
		for (const [key, seen] of this.seen)
			if (now - seen.ts > SEEN_TTL_SECONDS) this.seen.delete(key);
	}
}
