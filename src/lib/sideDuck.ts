import type { DuckDBConnection } from "@duckdb/node-api";
import { runQuery } from "@/lib/parquet";
import { DuckDBInstance } from "@duckdb/node-api";

export type SideDuckOptions = {
	/** Log prefix, e.g. `archive`. */
	label: string;
	memoryLimit: string;
	/** Read remote parquet over https, which needs the httpfs extension. */
	remote: boolean;
	/** Put queries back on the live connection, which is what a naive build does. */
	shared: boolean;
};

export type SideDuck = {
	usesSharedConnection: () => boolean;
	/** The raw handle, for writers that run their own statements. */
	db: () => Promise<DuckDBConnection>;
	query: <T>(sql: string, ...parameters: string[]) => Promise<T[]>;
	statement: (sql: string) => Promise<void>;
};

/**
 * A DuckDB connection beside the live one, with its own serialization queue, so
 * a scan that reads tens of megabytes cannot sit in front of a live request.
 * The live connection (`lib/parquet.ts`) runs every query in turn; anything
 * slower than a live response belongs here instead.
 */
export function createSideDuck(options: SideDuckOptions): SideDuck {
	let connection: Promise<DuckDBConnection> | undefined;
	let tail: Promise<unknown> = Promise.resolve();

	const db = async (): Promise<DuckDBConnection> => {
		connection ??= open(options);
		connection.catch(() => {
			connection = undefined;
		});

		return connection;
	};

	const enqueue = async <T>(
		run: (handle: DuckDBConnection) => Promise<T>
	): Promise<T> => {
		const task = tail.then(
			async () => run(await db()),
			async () => run(await db())
		);
		tail = task.then(
			() => undefined,
			() => undefined
		);

		return task;
	};

	const query = async <T>(
		sql: string,
		...parameters: string[]
	): Promise<T[]> => {
		if (options.shared) return runQuery<T>(sql, ...parameters);

		return enqueue(async (handle) => {
			const reader = await handle.runAndReadAll(sql, parameters);
			await reader.readAll();
			const rows = reader.getRowObjectsJS() as unknown;
			// DuckDB's row type carries nothing the compiler can check against.
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			return rows as T[];
		});
	};

	const statement = async (sql: string): Promise<void> => {
		if (options.shared) {
			await runQuery(sql);
			return;
		}

		await enqueue(async (handle) => {
			await handle.run(sql);
		});
	};

	return {
		usesSharedConnection: () => options.shared,
		db,
		query,
		statement,
	};
}

async function open(options: SideDuckOptions): Promise<DuckDBConnection> {
	const startedAt = Date.now();
	// One thread: threads are native memory the host cannot spare next to the
	// live connection, and these scans are IO-bound on remote parquet anyway.
	const instance = await DuckDBInstance.create(":memory:", {
		memory_limit: options.memoryLimit,
		threads: "1",
	});
	const handle = await instance.connect();
	if (options.remote) {
		await handle.run("INSTALL httpfs");
		await handle.run("LOAD httpfs");
		// Repeated scans read the same remote parquet footers.
		await handle.run("PRAGMA enable_object_cache");
	}

	console.info(
		`[${options.label}] DuckDB ready in ${((Date.now() - startedAt) / 1000).toFixed(1)}s (memory_limit=${options.memoryLimit})`
	);

	return handle;
}
