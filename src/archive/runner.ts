import type { Row } from "@/archive/parquet";
import {
	ArchiveBuffer,
	ARRIVAL_COLUMNS,
	captureArrivals,
	captureLirrFleet,
	FLEET_COLUMNS,
	MAX_ARRIVAL_ROWS,
	MAX_FLEET_ROWS,
	SPOOL_ROOT,
	spoolRows,
} from "@/archive/recorder";
import { uploadPart } from "@/archive/store";
import { fetchRealtime, lookupTrips } from "@/services/realtime";
import { getVehiclesForAgency } from "@/services/vehicles";

/**
 * The archive is filled by this loop and nothing else: sample the live feeds
 * into a spool, and write whatever is spooled as immutable parquet parts.
 * `scripts/record.ts` runs it as its own process; the server can run it in
 * process instead when a host keeps it awake (`ARCHIVE_RECORD=1`).
 */
export const SAMPLE_MS = Number(process.env.ARCHIVE_SAMPLE_MS ?? 60_000);
export const FLUSH_MS = Number(process.env.ARCHIVE_FLUSH_MS ?? 15 * 60_000);

/** The two datasets, each with the spool it drains. */
const FLEET_PART = {
	spool: "fleet",
	dataset: "lirr_fleet",
	columns: FLEET_COLUMNS,
} as const;
const ARRIVAL_PART = {
	spool: "arrivals",
	dataset: "arrivals",
	columns: ARRIVAL_COLUMNS,
} as const;

type DatasetWrite = typeof FLEET_PART | typeof ARRIVAL_PART;

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
	await buffer.addFleet(fleet, now);

	const [subwayEntities, lirrEntities] = await Promise.all([
		fetchRealtime("subway", ["*"]),
		fetchRealtime("lirr", ["*"]),
	]);
	const rows = [
		...captureArrivals("subway", subwayEntities, now),
		...captureArrivals("lirr", lirrEntities, now),
	];
	const arrivals = await withLirrRoutes(rows);
	const kept = await buffer.addArrivals(arrivals, now);

	console.info(
		`[record] ${stamp()} fleet +${fleet.length} · arrivals +${kept} of ${arrivals.length} (${buffer.size} spooled)`
	);
}

/**
 * Write one dataset's spool, streaming each sample file in turn. A failed
 * upload leaves its files in place, so a bucket outage delays the archive
 * instead of dropping it.
 */
async function writePart(
	buffer: ArchiveBuffer,
	{ spool, dataset, columns }: DatasetWrite
): Promise<void> {
	const chunks = buffer.pending(spool);
	const [first] = chunks;
	if (!first) return;

	const part = await uploadPart(dataset, columns, {
		chunks: spoolRows(chunks),
		epoch: first.epoch,
		rows: chunks.reduce((total, chunk) => total + chunk.rows, 0),
	});
	if (part)
		console.info(
			`[record] ${stamp()} wrote ${part.key} (${part.rows} rows, ${part.bytes} bytes)`
		);

	// Only now: a part that did not land keeps its spool for the next flush.
	await buffer.release(spool, chunks);
}

async function flush(buffer: ArchiveBuffer): Promise<void> {
	const dropped = buffer.takeDropped();
	if (dropped > 0)
		console.warn(
			`[record] ${stamp()} spool passed its cap; dropped the ${dropped} oldest rows`
		);

	// One dataset at a time, its files released before the next one is
	// serialized: a flush should never hold two spools at once.
	await writePart(buffer, FLEET_PART);
	await writePart(buffer, ARRIVAL_PART);
}

export type Recorder = {
	/** One sample and one flush, then return. A failed flush is thrown. */
	once: () => Promise<void>;
	/** Sample now and on a timer, flushing on its own timer, until `stop`. */
	start: () => void;
	/** Stop the timers and write what is spooled, including a sample already running. */
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
			await buffer.close();
		},
		start() {
			console.info(
				`[record] spooling to ${SPOOL_ROOT}, at most ${MAX_FLEET_ROWS} fleet and ${MAX_ARRIVAL_ROWS} arrival rows`
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
				// Nothing will retry once this process is gone, so the spool goes too.
				await buffer.close();
			})();

			await halted;
		},
	};
}
