import type { Row } from "@/archive/parquet";
import {
	ArchiveBuffer,
	ARRIVAL_COLUMNS,
	captureArrivals,
	captureLirrFleet,
	FLEET_COLUMNS,
	MAX_ARRIVAL_ROWS,
	MAX_FLEET_ROWS,
} from "@/archive/recorder";
import { uploadBatch } from "@/archive/store";
import { fetchRealtime, lookupTrips } from "@/services/realtime";
import { getVehiclesForAgency } from "@/services/vehicles";

/**
 * The archive is filled by this loop and nothing else: sample the live feeds
 * into a buffer, and write whatever is buffered as immutable parquet parts.
 * `scripts/record.ts` runs it as its own process; the server can run it in
 * process instead when a host keeps it awake (`ARCHIVE_RECORD=1`).
 */
export const SAMPLE_MS = Number(process.env.ARCHIVE_SAMPLE_MS ?? 60_000);
export const FLUSH_MS = Number(process.env.ARCHIVE_FLUSH_MS ?? 15 * 60_000);

function stamp(): string {
	return new Date().toISOString().slice(11, 19);
}

/** LIRR trip updates carry no route id; the static trips table does. */
async function withLirrRoutes(rows: Row[]): Promise<Row[]> {
	const missing = [
		...new Set(rows.filter((row) => !row[2]).map((row) => String(row[3]))),
	];
	if (missing.length === 0) return rows;

	const trips = await lookupTrips("lirr", missing.toSorted());

	// Filled in place: a second copy of every sampled row is another copy of the
	// buffer this process does not need.
	for (const row of rows) {
		const known = row[2];
		if (known) continue;
		row[2] = trips.get(String(row[3]))?.routeId ?? "";
	}

	return rows;
}

async function sample(buffer: ArchiveBuffer): Promise<void> {
	const now = Math.floor(Date.now() / 1000);
	const vehicles = await getVehiclesForAgency("lirr");
	const fleet = captureLirrFleet(vehicles, now);
	buffer.addFleet(fleet);

	const [subwayEntities, lirrEntities] = await Promise.all([
		fetchRealtime("subway", ["*"]),
		fetchRealtime("lirr", ["*"]),
	]);
	const rows = [
		...captureArrivals("subway", subwayEntities, now),
		...captureArrivals("lirr", lirrEntities, now),
	];
	const arrivals = await withLirrRoutes(rows);
	const kept = buffer.addArrivals(arrivals);

	console.info(
		`[record] ${stamp()} fleet +${fleet.length} · arrivals +${kept} of ${arrivals.length} (${buffer.size} buffered)`
	);
}

/**
 * Write whatever is buffered. A failed upload puts the rows back at the front of
 * the buffer, so a bucket outage delays the archive instead of dropping it.
 */
async function flush(buffer: ArchiveBuffer): Promise<void> {
	const drained = buffer.drain();
	const dropped = buffer.takeDropped();
	if (dropped > 0)
		console.warn(
			`[record] ${stamp()} buffer hit its cap; dropped the ${dropped} oldest rows`
		);
	if (drained.fleet.length === 0 && drained.arrivals.length === 0) return;

	try {
		// One dataset at a time, and its rows released as soon as its part is
		// written: both writes queue on the same DuckDB connection anyway, and a
		// flush holding a full arrival buffer should not also hold the fleet rows.
		const fleet = await uploadBatch("lirr_fleet", FLEET_COLUMNS, drained.fleet);
		drained.fleet = [];
		const arrivals = await uploadBatch(
			"arrivals",
			ARRIVAL_COLUMNS,
			drained.arrivals
		);
		drained.arrivals = [];

		for (const part of [fleet, arrivals])
			if (part)
				console.info(
					`[record] ${stamp()} wrote ${part.key} (${part.rows} rows, ${part.bytes} bytes)`
				);
	} catch (error) {
		buffer.restore(drained);
		throw error;
	}
}

export type Recorder = {
	/** One sample and one flush, then return. A failed flush is thrown. */
	once: () => Promise<void>;
	/** Sample now and on a timer, flushing on its own timer, until `stop`. */
	start: () => void;
	/** Stop the timers and write what is buffered, including a sample already running. */
	stop: () => Promise<void>;
};

export function createRecorder(
	options: { sampleMs?: number; flushMs?: number } = {}
): Recorder {
	const { sampleMs = SAMPLE_MS, flushMs = FLUSH_MS } = options;
	const buffer = new ArchiveBuffer();
	let sampleTimer: ReturnType<typeof setTimeout> | undefined;
	let flushTimer: ReturnType<typeof setInterval> | undefined;
	let stopping = false;
	/** The sample running now: its rows are archive rows too. */
	let sampling: Promise<void> | undefined;
	/** Flushes run one after another, so a timer's flush cannot interleave with the last one. */
	let flushing: Promise<void> = Promise.resolve();
	let halted: Promise<void> | undefined;

	/** A sample is worth one log line when it fails and none when it works. */
	const sampleSafely = async (): Promise<void> => {
		try {
			await sample(buffer);
		} catch (error) {
			console.error(`[record] ${stamp()} sample failed:`, error);
		}
	};

	const flushSafely = async (failure: string): Promise<void> => {
		flushing = flushing.then(async () => {
			try {
				await flush(buffer);
			} catch (error) {
				console.error(`[record] ${stamp()} ${failure}:`, error);
			}
		});

		await flushing;
	};

	const tick = async (): Promise<void> => {
		const current = sampleSafely();
		sampling = current;
		try {
			await current;
		} finally {
			if (sampling === current) sampling = undefined;
		}

		if (stopping) return;

		if (buffer.crowded) await flushSafely("early flush failed");
		if (stopping) return;

		sampleTimer = setTimeout(() => {
			tick().catch((error: unknown) => {
				console.error("[record] sample loop failed:", error);
			});
		}, sampleMs);
	};

	return {
		async once() {
			await sampleSafely();
			await flush(buffer);
		},
		start() {
			console.info(
				`[record] buffering at most ${MAX_FLEET_ROWS} fleet and ${MAX_ARRIVAL_ROWS} arrival rows`
			);
			flushTimer = setInterval(() => {
				void flushSafely("flush failed");
			}, flushMs);
			void tick();
		},
		async stop() {
			halted ??= (async () => {
				stopping = true;
				if (sampleTimer) clearTimeout(sampleTimer);
				if (flushTimer) clearInterval(flushTimer);
				// A sample that is already fetching the feeds is part of the archive;
				// the final flush is the last chance to write its rows.
				if (sampling) await sampling;
				await flushSafely("final flush failed");
			})();

			await halted;
		},
	};
}
