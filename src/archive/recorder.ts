import type { ColumnSpec, Row } from "@/archive/parquet";
import type { ApiVehicle } from "@/services/vehicles";
import type { FeedEntity } from "@/types/realtime";
import { appendFile, mkdir, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/** Where samples wait between flushes. A disk, not the heap. */
export const SPOOL_ROOT =
	process.env.ARCHIVE_SPOOL_DIR ?? join(tmpdir(), "tracks-archive-spool");

/**
 * Rows held between flushes, per dataset. A flush every fifteen minutes sees
 * roughly a thousand fleet rows and several thousand arrival rows; these caps
 * are the ceiling for a storage outage, not the working size. Buffered rows sit
 * in a spool file, so a cap now bounds disk instead of heap: the heap cost of a
 * flush is one spool file at a time, whatever is waiting behind it.
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

export type SpoolDataset = "fleet" | "arrivals";

/** One sample's rows on disk, waiting for the next flush. */
export type SpoolChunk = {
	path: string;
	/** The sample's epoch: the part is named after the oldest chunk's. */
	epoch: number;
	rows: number;
};

type SpooledRow = Row[];

/**
 * One file per sample, appended and never rewritten. A flush streams the files
 * in order, so the recorder's heap holds one sample at a time no matter how long
 * a storage outage makes the backlog.
 */
class Spool {
	readonly #dir: string;
	readonly #dataset: SpoolDataset;
	readonly #limit: number;
	readonly #chunks: SpoolChunk[] = [];
	#rows = 0;
	#dropped = 0;
	#seq = 0;

	constructor(directory: string, dataset: SpoolDataset, limit: number) {
		this.#dir = directory;
		this.#dataset = dataset;
		this.#limit = limit;
	}

	get rows(): number {
		return this.#rows;
	}

	/** Rows near the cap mean the flush timer is outrunning the spool. */
	get crowded(): boolean {
		return this.#rows >= this.#limit * 0.75;
	}

	async append(rows: readonly Row[], epoch: number): Promise<void> {
		if (rows.length === 0) return;

		this.#seq += 1;
		const path = join(this.#dir, `${this.#dataset}-${epoch}-${this.#seq}.json`);
		await appendFile(path, JSON.stringify(rows));
		this.#chunks.push({ path, epoch, rows: rows.length });
		this.#rows += rows.length;
		await this.trim();
	}

	/** The backlog as it stands now; samples appended after this wait for the next flush. */
	pending(): SpoolChunk[] {
		return [...this.#chunks];
	}

	/** Delete chunks whose part is in the bucket. */
	async release(chunks: readonly SpoolChunk[]): Promise<void> {
		const released = new Set(chunks.map((chunk) => chunk.path));
		for (const chunk of chunks) {
			this.#rows -= chunk.rows;
			// eslint-disable-next-line no-await-in-loop -- one file per sample
			await unlink(chunk.path).catch(() => undefined);
		}

		const kept = this.#chunks.filter((chunk) => !released.has(chunk.path));
		this.#chunks.length = 0;
		this.#chunks.push(...kept);
	}

	takeDropped(): number {
		const dropped = this.#dropped;
		this.#dropped = 0;

		return dropped;
	}

	/**
	 * Past the cap the oldest samples go. The archive is a record of what ran,
	 * but a process that dies has no archive at all: dropping the front of an
	 * outage is the only way a storage outage does not fill the disk.
	 */
	private async trim(): Promise<void> {
		while (this.#rows > this.#limit && this.#chunks.length > 1) {
			const oldest = this.#chunks.shift();
			if (!oldest) return;
			this.#rows -= oldest.rows;
			this.#dropped += oldest.rows;
			// eslint-disable-next-line no-await-in-loop -- one file per dropped sample
			await unlink(oldest.path).catch(() => undefined);
		}
	}
}

/** Spooled rows, oldest sample first, parsed one file at a time. */
export async function* spoolRows(
	chunks: readonly SpoolChunk[]
): AsyncGenerator<Row[]> {
	for (const chunk of chunks) {
		// eslint-disable-next-line no-await-in-loop -- the point is one file at a time
		const text = await readFile(chunk.path, "utf8");
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- our own spool file
		const spooled = JSON.parse(text) as SpooledRow;
		// JSON has no undefined: a null column value was missing, not null.
		yield spooled.map((row) => row.map((value) => value ?? undefined));
	}
}

/**
 * Samples between flushes. Each arrival row is only kept when the delay is new,
 * has moved by a minute, or the keepalive expires; a train holding at +2
 * minutes for half an hour is one row, not thirty. Fleet rows are never
 * collapsed: the car trace is the sequence of positions.
 */
export class ArchiveBuffer {
	readonly #fleet: Spool;
	readonly #arrivals: Spool;
	readonly #dir: string;
	readonly #seen = new Map<string, SeenArrival>();
	#ready: Promise<void> | undefined;

	constructor(
		limits: ArchiveLimits = DEFAULT_LIMITS,
		dir = join(SPOOL_ROOT, `${process.pid}-${Date.now()}`)
	) {
		this.#dir = dir;
		this.#fleet = new Spool(dir, "fleet", limits.fleet);
		this.#arrivals = new Spool(dir, "arrivals", limits.arrivals);
	}

	get size(): number {
		return this.#fleet.rows + this.#arrivals.rows;
	}

	get crowded(): boolean {
		return this.#fleet.crowded || this.#arrivals.crowded;
	}

	async addFleet(rows: readonly Row[], epoch: number): Promise<void> {
		if (rows.length === 0) return;
		await this.prepare();
		await this.#fleet.append(rows, epoch);
	}

	/** Returns how many of `rows` the dedup kept. */
	async addArrivals(rows: readonly Row[], epoch: number): Promise<number> {
		const kept: Row[] = [];

		for (const row of rows) {
			const [, agency, , trip, stop] = row;
			const delay = row[7] === undefined ? undefined : Number(row[7]);
			const ts = Number(row[0]);
			const key = `${String(agency)}|${String(trip)}|${String(stop)}`;
			const previous = this.#seen.get(key);
			const moved =
				previous?.delay === undefined ||
				delay === undefined ||
				Math.abs(delay - previous.delay) >= MOVED_SECONDS;
			const expired = !previous || ts - previous.ts >= KEEPALIVE_SECONDS;

			if (!previous || moved || expired) {
				kept.push(row);
				this.#seen.set(key, { delay, ts });
			}
		}

		this.pruneSeen(epoch);
		if (kept.length === 0) return 0;

		await this.prepare();
		await this.#arrivals.append(kept, epoch);

		return kept.length;
	}

	pending(dataset: SpoolDataset): SpoolChunk[] {
		return dataset === "fleet"
			? this.#fleet.pending()
			: this.#arrivals.pending();
	}

	/** After a part is in the bucket: its spool files are no longer needed. */
	async release(
		dataset: SpoolDataset,
		chunks: readonly SpoolChunk[]
	): Promise<void> {
		await (dataset === "fleet" ? this.#fleet : this.#arrivals).release(chunks);
	}

	/** Samples the cap discarded since this was last asked for. */
	takeDropped(): number {
		return this.#fleet.takeDropped() + this.#arrivals.takeDropped();
	}

	/** The process is going away: its spool goes with it. */
	async close(): Promise<void> {
		await rm(this.#dir, { force: true, recursive: true }).catch(
			() => undefined
		);
	}

	private async prepare(): Promise<void> {
		this.#ready ??= mkdir(this.#dir, { recursive: true }).then(() => undefined);
		await this.#ready;
	}

	private pruneSeen(now: number): void {
		for (const [key, seen] of this.#seen)
			if (now - seen.ts > SEEN_TTL_SECONDS) this.#seen.delete(key);
	}
}
