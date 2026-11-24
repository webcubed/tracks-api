import type { DuckDBConnection } from "@duckdb/node-api";
import { createSideDuck } from "@/lib/sideDuck";

/**
 * The archive gets its own DuckDB connection, with its own serialization
 * queue, so a 24-hour history scan cannot sit in front of a live arrivals
 * request. `ARCHIVE_DUCKDB=shared` puts archive queries back on the live
 * connection (`lib/parquet.ts`), which is what a naive implementation does;
 * the difference is what the 24-hour benchmark measures.
 *
 * Parts are downloaded to local disk before they are read, so the connection
 * needs no remote-parquet support.
 */
const archive = createSideDuck({
	label: "archive",
	memoryLimit: process.env.ARCHIVE_DUCKDB_MEMORY_LIMIT ?? "128MB",
	remote: false,
	shared: process.env.ARCHIVE_DUCKDB === "shared",
});

export function archiveUsesSharedConnection(): boolean {
	return archive.usesSharedConnection();
}

export async function getArchiveDb(): Promise<DuckDBConnection> {
	return archive.db();
}

/**
 * Serialized SQL for the archive. Parameter values interpolate through `?`;
 * never splice caller input into `sql`.
 */
export async function runArchiveQuery<T>(
	sql: string,
	...parameters: string[]
): Promise<T[]> {
	return archive.query<T>(sql, ...parameters);
}

/** DDL and `COPY` for the writer. Same queue as the reads, so they cannot race. */
export async function runArchiveStatement(sql: string): Promise<void> {
	await archive.statement(sql);
}
