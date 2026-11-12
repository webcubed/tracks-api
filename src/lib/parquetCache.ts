import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoize } from "@/lib/memoize";

/**
 * Journey scans read the same few parquet indexes once per round. DuckDB's
 * remote reads were re-fetching enough of a 9-20 MB file each time to spend
 * seconds per scan, so keep one copy on disk and point DuckDB at that.
 */
const CACHE_TTL_MS = Number(
	process.env.JOURNEY_PARQUET_CACHE_TTL_MS ?? 30 * 60_000
);
const CACHE_DIR = join(tmpdir(), "tracks-parquet-cache");

async function download(url: string): Promise<string> {
	const name = `${createHash("sha256").update(url).digest("hex").slice(0, 32)}.parquet`;
	const target = join(CACHE_DIR, name);

	try {
		const info = await stat(target);
		if (Date.now() - info.mtimeMs < CACHE_TTL_MS) return target;
	} catch {
		// Not cached yet.
	}

	await mkdir(CACHE_DIR, { recursive: true });
	const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;

	try {
		const response = await fetch(url, { redirect: "follow" });
		if (!response.ok || !response.body) {
			throw new Error(`parquet download failed: ${response.status}`);
		}

		const body = Buffer.from(await response.arrayBuffer());
		if (
			body.length < 8 ||
			body.subarray(0, 4).toString() !== "PAR1" ||
			body.subarray(-4).toString() !== "PAR1"
		) {
			throw new Error("parquet download was not a parquet file");
		}

		await writeFile(temporary, body);
		await rename(temporary, target);
		return target;
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}

const cache = memoize(download, CACHE_TTL_MS, 32);

/**
 * A local path for `url`, or the original URL when the disk cache is disabled
 * or the download fails. A failed download must not make journey planning fail.
 */
export async function cachedParquet(url: string): Promise<string> {
	if (process.env.JOURNEY_PARQUET_CACHE === "0") return url;
	try {
		return await cache(url);
	} catch {
		return url;
	}
}
