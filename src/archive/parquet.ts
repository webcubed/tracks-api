import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getArchiveDb, runArchiveStatement } from "@/archive/duck";

/** Values as they sit in a row before DuckDB sees them. */
export type Row = Array<string | number | undefined>;

export type ColumnType = "BIGINT" | "DOUBLE" | "INTEGER" | "VARCHAR";

export type ColumnSpec = {
	name: string;
	type: ColumnType;
};

/** DuckDB caps a statement at 1024 rows of values here; keep well under. */
const INSERT_CHUNK = 400;

/**
 * One temp table at a time. The recorder flushes both datasets at once, and a
 * shared table name let the second flush find the first one's columns.
 */
let writeTail: Promise<unknown> = Promise.resolve();
let writes = 0;

function literal(value: string | number | undefined, type: ColumnType): string {
	if (value === undefined) return "NULL";
	if (type === "VARCHAR") return `'${String(value).replaceAll("'", "''")}'`;
	if (typeof value === "number")
		return Number.isFinite(value) ? String(value) : "NULL";

	return String(value);
}

/**
 * Rows to parquet bytes, through DuckDB's own writer (ZSTD). The project
 * already ships DuckDB for reading, so the archive does not need a parquet
 * library to serialize a few hundred rows per flush.
 */
export async function rowsToParquet(
	columns: readonly ColumnSpec[],
	rows: readonly Row[]
): Promise<Uint8Array> {
	if (rows.length === 0) return new Uint8Array();

	const task = writeTail.then(
		async () => write(columns, rows),
		async () => write(columns, rows)
	);
	writeTail = task.then(
		() => undefined,
		() => undefined
	);

	return task;
}

async function write(
	columns: readonly ColumnSpec[],
	rows: readonly Row[]
): Promise<Uint8Array> {
	writes += 1;
	const table = `archive_batch_${process.pid}_${writes}`;
	const definitions = columns
		.map((column) => `"${column.name}" ${column.type}`)
		.join(", ");
	const target = join(
		tmpdir(),
		`tracks-archive-${process.pid}-${Date.now()}-${writes}.parquet`
	);

	await runArchiveStatement(
		`CREATE OR REPLACE TABLE ${table} (${definitions})`
	);

	try {
		const db = await getArchiveDb();
		for (let start = 0; start < rows.length; start += INSERT_CHUNK) {
			const chunk = rows.slice(start, start + INSERT_CHUNK);
			const values = chunk
				.map(
					(row) =>
						`(${row
							.map((value, index) =>
								literal(value, columns[index]?.type ?? "VARCHAR")
							)
							.join(", ")})`
				)
				.join(", ");
			// eslint-disable-next-line no-await-in-loop -- sequential on one temp table
			await db.run(`INSERT INTO ${table} VALUES ${values}`);
		}

		await runArchiveStatement(
			`COPY ${table} TO '${target}' (FORMAT PARQUET, COMPRESSION ZSTD)`
		);
		// Read now: the recorder may keep several flushes queued behind this one.
		// eslint-disable-next-line no-await-in-loop -- one read per batch
		return new Uint8Array(await readFile(target));
	} finally {
		await unlink(target).catch(() => undefined);
		await runArchiveStatement(`DROP TABLE IF EXISTS ${table}`);
	}
}
