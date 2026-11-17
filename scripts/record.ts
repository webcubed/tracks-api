import type { Row } from "@/archive/parquet";
import {
	ArchiveBuffer,
	ARRIVAL_COLUMNS,
	captureArrivals,
	captureLirrFleet,
	FLEET_COLUMNS,
} from "@/archive/recorder";
import { archiveSummary, uploadBatch } from "@/archive/store";
import { B2Error, missingB2Env } from "@/lib/b2";
import { fetchRealtime, lookupTrips } from "@/services/realtime";
import { getVehiclesForAgency } from "@/services/vehicles";

/**
 * The recorder is its own process on purpose: the API sleeps on free hosting,
 * and a recorder that only ran inside it would leave a hole in the archive
 * every night. It samples the live feeds, buffers rows, and writes immutable
 * parquet parts to the bucket.
 *
 *   pnpm record            # sample every ARCHIVE_SAMPLE_MS, flush every ARCHIVE_FLUSH_MS
 *   pnpm record --once     # one sample and one flush, then exit
 *   pnpm record --probe    # what the bucket holds, then exit
 */
const SAMPLE_MS = Number(process.env.ARCHIVE_SAMPLE_MS ?? 60_000);
const FLUSH_MS = Number(process.env.ARCHIVE_FLUSH_MS ?? 15 * 60_000);
const once = process.argv.includes("--once");
const probe = process.argv.includes("--probe");
const buffer = new ArchiveBuffer();
let stopping = false;

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

async function sample(): Promise<void> {
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
async function flush(): Promise<void> {
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

async function tick(): Promise<void> {
	try {
		await sample();
	} catch (error) {
		console.error(`[record] ${stamp()} sample failed:`, error);
	}

	if (once) {
		await flush();
		return;
	}

	setTimeout(() => {
		tick().catch((error: unknown) => {
			console.error("[record] sample loop failed:", error);
		});
	}, SAMPLE_MS);
}

async function main(): Promise<void> {
	if (probe) {
		const coverage = await archiveSummary();
		for (const dataset of coverage)
			console.info(
				`[record] ${dataset.dataset}: ${dataset.parts} parts, ${dataset.bytes} bytes, ${dataset.first ?? "none"} → ${dataset.last ?? "none"}`
			);
		return;
	}

	const missing = missingB2Env();
	if (missing.length > 0) {
		throw new B2Error(
			500,
			"ARCHIVE_NOT_CONFIGURED",
			`set ${missing.join(", ")} in .env`
		);
	}

	console.info(
		`[record] sampling every ${SAMPLE_MS / 1000}s, flushing every ${FLUSH_MS / 1000}s`
	);

	const interval = setInterval(() => {
		flush().catch((error: unknown) => {
			console.error(`[record] ${stamp()} flush failed:`, error);
		});
	}, FLUSH_MS);

	const stop = async (): Promise<void> => {
		if (stopping) return;
		stopping = true;
		clearInterval(interval);
		console.info("[record] stopping; flushing");
		try {
			await flush();
		} catch (error) {
			console.error("[record] final flush failed:", error);
		}

		// This is a CLI process, not a request handler: exit once the last flush
		// has landed rather than waiting for the feed clients to go quiet.
		// eslint-disable-next-line unicorn/no-process-exit
		process.exit(0);
	};

	const onSignal = (): void => {
		stop().catch((error: unknown) => {
			console.error("[record] shutdown failed:", error);
		});
	};

	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);

	await tick();

	if (once) {
		// `--once` is a CLI run: DuckDB's native handle keeps the loop alive.
		// eslint-disable-next-line unicorn/no-process-exit
		process.exit(0);
	}
}

await main();
