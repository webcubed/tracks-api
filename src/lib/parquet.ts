import type { AgencyTableMap } from "@/constants";
import type { TableMap } from "@/types/static";
import { getStaticFeedUrl } from "@/constants";
import { getDb } from "@/db";

let queryTail = Promise.resolve();

/**
 * Raw SQL against the in-memory DuckDB instance. Values interpolate via `?`
 * placeholders; never splice user input into `sql`.
 *
 * Queries are serialized onto `queryTail`: the process shares one DuckDB
 * connection with a bounded 96 MB memory limit, so running queries in turn
 * prevents concurrent requests from multiplying peak native memory on 512 MB
 * hosts (e.g. Render free tier).
 */
export async function runQuery<T>(
	sql: string,
	...parameters: string[]
): Promise<T[]> {
	const run = async (): Promise<T[]> => {
		const db = await getDb();
		const reader = await db.runAndReadAll(sql, parameters);
		await reader.readAll();
		const rows = reader.getRowObjectsJS() as unknown;
		// DuckDB's row type carries nothing the compiler can check against; `T`
		// is the caller's claim about the SELECT.
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		return rows as T[];
	};

	const task = queryTail.then(run, run);
	queryTail = task.then(
		() => undefined,
		() => undefined
	);

	return task;
}

export async function queryTable<
	TAgency extends keyof AgencyTableMap,
	TTable extends AgencyTableMap[TAgency],
>(
	agency: TAgency,
	table: TTable,
	where?: string,
	...parameters: string[]
): Promise<Array<TableMap[TTable]>> {
	const url = getStaticFeedUrl(agency, table);
	const sql = `SELECT * FROM read_parquet('${url}')${where ? ` WHERE ${where}` : ""}`;
	return runQuery<TableMap[TTable]>(sql, ...parameters);
}
