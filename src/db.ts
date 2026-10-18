import type { DuckDBConnection } from "@duckdb/node-api";
import { DuckDBInstance } from "@duckdb/node-api";

// Memoize the promise, not the value: concurrent callers share one instance.
let connection: Promise<DuckDBConnection> | undefined;

export async function getDb(): Promise<DuckDBConnection> {
	connection ??= open();
	// Don't let a failed init poison the handle forever.
	connection.catch(() => {
		connection = undefined;
	});
	return connection;
}

// 64 MB measured as the sweet spot for 512 MB hosts: wide timetable scans
// still complete comfortably, and the peak RSS of a multi-feed journey plan
// stays well clear of the container ceiling (96 MB pushed it to the edge).
const DUCKDB_MEMORY_LIMIT = process.env.DUCKDB_MEMORY_LIMIT ?? "64MB";
const DUCKDB_THREADS = process.env.DUCKDB_THREADS ?? "1";

async function open(): Promise<DuckDBConnection> {
	const startedAt = Date.now();
	console.info(
		`[startup] Initializing in-memory DuckDB (memory_limit=${DUCKDB_MEMORY_LIMIT}, threads=${DUCKDB_THREADS}) and loading httpfs/json extensions`
	);
	const instance = await DuckDBInstance.create(":memory:", {
		memory_limit: DUCKDB_MEMORY_LIMIT,
		threads: DUCKDB_THREADS,
	});
	const db = await instance.connect();
	await db.run("INSTALL httpfs");
	await db.run("LOAD httpfs");
	await db.run("INSTALL json");
	await db.run("LOAD json");
	// Repeated journey rounds read the same remote Parquet footers; retain their
	// metadata in DuckDB's per-connection object cache.
	await db.run("PRAGMA enable_object_cache");
	console.info(
		`[startup] DuckDB ready in ${((Date.now() - startedAt) / 1000).toFixed(1)}s; warming up static data for feeds now.`
	);
	return db;
}
