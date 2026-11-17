import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "@/lib/parquet";
import { DuckDBInstance } from "@duckdb/node-api";

/**
 * The archive gets its own DuckDB connection, with its own serialization
 * queue, so a 24-hour history scan cannot sit in front of a live arrivals
 * request. `ARCHIVE_DUCKDB=shared` puts archive queries back on the live
 * connection (`lib/parquet.ts`), which is what a naive implementation does;
 * the difference is what the 24-hour benchmark measures.
 */
let connection: Promise<DuckDBConnection> | undefined;
let tail: Promise<unknown> = Promise.resolve();

export function archiveUsesSharedConnection(): boolean {
	return process.env.ARCHIVE_DUCKDB === "shared";
}

const MEMORY_LIMIT = process.env.ARCHIVE_DUCKDB_MEMORY_LIMIT ?? "128MB";

async function open(): Promise<DuckDBConnection> {
	const startedAt = Date.now();
	// One thread: the archive is a handful of small parquet files, and threads
	// are native memory the host cannot spare next to the live connection.
	const instance = await DuckDBInstance.create(":memory:", {
		memory_limit: MEMORY_LIMIT,
		threads: "1",
	});
	const db = await instance.connect();
	console.info(
		`[archive] DuckDB ready in ${((Date.now() - startedAt) / 1000).toFixed(1)}s (memory_limit=${MEMORY_LIMIT})`
	);

	return db;
}

export async function getArchiveDb(): Promise<DuckDBConnection> {
	connection ??= open();
	connection.catch(() => {
		connection = undefined;
	});

	return connection;
}

/**
 * Serialized SQL for the archive. Parameter values interpolate through `?`;
 * never splice caller input into `sql`.
 */
export async function runArchiveQuery<T>(
	sql: string,
	...parameters: string[]
): Promise<T[]> {
	if (archiveUsesSharedConnection()) return runQuery<T>(sql, ...parameters);

	const run = async (): Promise<T[]> => {
		const db = await getArchiveDb();
		const reader = await db.runAndReadAll(sql, parameters);
		await reader.readAll();
		const rows = reader.getRowObjectsJS() as unknown;
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		return rows as T[];
	};

	const task = tail.then(run, run);
	tail = task.then(
		() => undefined,
		() => undefined
	);

	return task;
}

/** DDL and `COPY` for the writer. Same queue as the reads, so they cannot race. */
export async function runArchiveStatement(sql: string): Promise<void> {
	if (archiveUsesSharedConnection()) {
		await runQuery(sql);
		return;
	}

	const run = async (): Promise<void> => {
		const db = await getArchiveDb();
		await db.run(sql);
	};

	const task = tail.then(run, run);
	tail = task.then(
		() => undefined,
		() => undefined
	);

	await task;
}
