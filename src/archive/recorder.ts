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
 * Samples between flushes. Each arrival row is only kept when the delay is new,
 * has moved by a minute, or the keepalive expires; a train holding at +2
 * minutes for half an hour is one row, not thirty. Fleet rows are never
 * collapsed: the car trace is the sequence of positions.
 */
export class ArchiveBuffer {
	fleet: Row[] = [];
	arrivals: Row[] = [];
	private readonly seen = new Map<string, SeenArrival>();

	addFleet(rows: Row[]): void {
		this.fleet.push(...rows);
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

		return kept;
	}

	get size(): number {
		return this.fleet.length + this.arrivals.length;
	}

	drain(): { fleet: Row[]; arrivals: Row[] } {
		const drained = { fleet: this.fleet, arrivals: this.arrivals };
		this.fleet = [];
		this.arrivals = [];

		return drained;
	}
}
