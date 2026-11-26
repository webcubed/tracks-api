import type { Row } from "@/archive/parquet";
import {
	ArchiveBuffer,
	ARRIVAL_COLUMNS,
	captureArrivals,
	captureLirrFleet,
	FLEET_COLUMNS,
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

	return rows.map((row): Row =>
		row[2]
			? row
			: [
					row[0],
					row[1],
					trips.get(String(row[3]))?.routeId ?? "",
					...row.slice(3),
				]
	);
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
	if (drained.fleet.length === 0 && drained.arrivals.length === 0) return;

	try {
		const parts = await Promise.all([
			uploadBatch("lirr_fleet", FLEET_COLUMNS, drained.fleet),
			uploadBatch("arrivals", ARRIVAL_COLUMNS, drained.arrivals),
		]);
		for (const part of parts)
			if (part)
				console.info(
					`[record] ${stamp()} wrote ${part.key} (${part.rows} rows, ${part.bytes} bytes)`
				);
	} catch (error) {
		buffer.fleet = [...drained.fleet, ...buffer.fleet];
		buffer.arrivals = [...drained.arrivals, ...buffer.arrivals];
		throw error;
	}
}

export type Recorder = {
	/** One sample and one flush, then return. A failed flush is thrown. */
	once: () => Promise<void>;
	/** Sample now and on a timer, flushing on its own timer, until `stop`. */
	start: () => void;
	/** Stop the timers and write what is buffered. Failures are logged. */
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

	/** A sample is worth one log line when it fails and none when it works. */
	const sampleSafely = async (): Promise<void> => {
		try {
			await sample(buffer);
		} catch (error) {
			console.error(`[record] ${stamp()} sample failed:`, error);
		}
	};

	const flushSafely = async (failure: string): Promise<void> => {
		try {
			await flush(buffer);
		} catch (error) {
			console.error(`[record] ${stamp()} ${failure}:`, error);
		}
	};

	const tick = async (): Promise<void> => {
		await sampleSafely();
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
			flushTimer = setInterval(() => {
				flushSafely("flush failed").catch(() => undefined);
			}, flushMs);
			void tick();
		},
		async stop() {
			if (stopping) return;
			stopping = true;
			if (sampleTimer) clearTimeout(sampleTimer);
			if (flushTimer) clearInterval(flushTimer);
			await flushSafely("final flush failed");
		},
	};
}
