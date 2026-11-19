import type { ColumnSpec, Row } from "@/archive/parquet";
/* eslint-disable require-unicode-regexp -- tsconfig targets ES2017, which cannot compile the v flag */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rowsToParquet } from "@/archive/parquet";
import { getObject, listObjects, putObject } from "@/lib/b2";

/**
 * History lives in the bucket, not in the process. The layout is one directory
 * per UTC day and one immutable file per flush:
 *
 *   v1/<dataset>/dt=YYYY-MM-DD/part-<epoch>-<id>.parquet
 *
 * Parts are named by their first row's epoch, so a listing sorts in time order
 * and a part never needs rewriting. A query prunes by day prefix and by the
 * epoch in the name, then reads only the parts inside its window.
 */
export const ARCHIVE_PREFIX = (process.env.ARCHIVE_PREFIX ?? "v1").replace(
	/\/+$/,
	""
);

export const DATASETS = ["lirr_fleet", "arrivals"] as const;
export type Dataset = (typeof DATASETS)[number];

export type ArchivePart = {
	key: string;
	size: number;
	epoch: number;
	day: string;
};

const CACHE_DIR = join(tmpdir(), "tracks-archive-cache");
/** Flushes download in parallel; the API is also reading these files. */
const DOWNLOAD_CONCURRENCY = 6;

function dayOf(epochSeconds: number): string {
	return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

function partEpoch(key: string): number {
	return Number(/\/part-(\d+)-/.exec(key)?.[1] ?? Number.NaN);
}

/** Parts of `dataset` whose first row falls inside the window. */
export async function archiveParts(
	dataset: Dataset,
	fromSeconds: number,
	toSeconds: number
): Promise<ArchivePart[]> {
	const days = new Set<string>();
	for (
		let cursor = Math.floor(fromSeconds / 86_400) * 86_400;
		cursor <= toSeconds;
		cursor += 86_400
	)
		days.add(dayOf(cursor));

	const listings = await Promise.all(
		[...days].map(async (day) =>
			listObjects(`${ARCHIVE_PREFIX}/${dataset}/dt=${day}/`)
		)
	);

	return listings
		.flat()
		.map((object) => ({
			key: object.key,
			size: object.size,
			epoch: partEpoch(object.key),
			day: dayOf(partEpoch(object.key)),
		}))
		.filter(
			(part) =>
				part.key.endsWith(".parquet") &&
				Number.isFinite(part.epoch) &&
				part.epoch >= fromSeconds &&
				part.epoch <= toSeconds
		)
		.toSorted((a, b) => a.epoch - b.epoch);
}

/** Objects are immutable, so a cached copy is valid until its size changes. */
async function cached(key: string, size: number): Promise<string> {
	const name = `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.parquet`;
	const target = join(CACHE_DIR, name);

	try {
		const info = await stat(target);
		if (info.size === size) return target;
	} catch {
		// Not cached yet.
	}

	await mkdir(CACHE_DIR, { recursive: true });
	const body = await getObject(key);
	if (
		body.byteLength < 8 ||
		Buffer.from(body.subarray(0, 4)).toString() !== "PAR1" ||
		Buffer.from(body.subarray(-4)).toString() !== "PAR1"
	) {
		throw new Error(`archive object is not parquet: ${key}`);
	}

	const temporary = `${target}.${process.pid}.tmp`;
	await writeFile(temporary, body);
	await rename(temporary, target);

	return target;
}

/**
 * Local paths for every part in the window, in time order. DuckDB reads the
 * cache directory; the bucket is only visited for parts that changed.
 */
export async function archiveFiles(
	dataset: Dataset,
	fromSeconds: number,
	toSeconds: number
): Promise<string[]> {
	const parts = await archiveParts(dataset, fromSeconds, toSeconds);
	const files = Array.from({ length: parts.length }, () => "");

	let cursor = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const index = cursor;
			cursor += 1;
			const part = parts[index];
			if (!part) return;
			// eslint-disable-next-line no-await-in-loop -- bounded worker pool
			files[index] = await cached(part.key, part.size);
		}
	};

	await Promise.all(
		Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, parts.length) }, worker)
	);

	return files;
}

export type UploadedPart = { key: string; rows: number; bytes: number };

/** Serialize a buffer and upload it as one immutable part. */
export async function uploadBatch(
	dataset: Dataset,
	columns: readonly ColumnSpec[],
	rows: readonly Row[]
): Promise<UploadedPart | undefined> {
	if (rows.length === 0) return undefined;

	const [firstRow] = rows;
	const epoch = Number(firstRow?.[0] ?? Math.floor(Date.now() / 1000));
	const suffix = createHash("sha256")
		.update(`${dataset}:${epoch}:${rows.length}:${process.pid}`)
		.digest("hex")
		.slice(0, 8);
	const key = `${ARCHIVE_PREFIX}/${dataset}/dt=${dayOf(epoch)}/part-${epoch}-${suffix}.parquet`;
	const body = await rowsToParquet(columns, rows);
	await putObject(key, body);

	return { key, rows: rows.length, bytes: body.byteLength };
}

export type ArchiveCoverage = {
	dataset: Dataset;
	parts: number;
	bytes: number;
	first?: string;
	last?: string;
};

/** What the bucket holds: parts, bytes, and the first and last sample. */
export async function archiveSummary(): Promise<ArchiveCoverage[]> {
	return Promise.all(
		DATASETS.map(async (dataset) => {
			const listed = await listObjects(`${ARCHIVE_PREFIX}/${dataset}/`);
			const objects = listed
				.map((object) => ({ ...object, epoch: partEpoch(object.key) }))
				.filter((object) => Number.isFinite(object.epoch))
				.toSorted((a, b) => a.epoch - b.epoch);
			const first = objects[0]?.epoch;
			const last = objects.at(-1)?.epoch;

			return {
				dataset,
				parts: objects.length,
				bytes: objects.reduce((total, object) => total + object.size, 0),
				first:
					first === undefined
						? undefined
						: new Date(first * 1000).toISOString(),
				last:
					last === undefined ? undefined : new Date(last * 1000).toISOString(),
			};
		})
	);
}

/* eslint-enable require-unicode-regexp */
