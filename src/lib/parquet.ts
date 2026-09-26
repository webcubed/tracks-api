import type { AgencyTableMap } from "@/constants";
import type { TableMap } from "@/types/static";
import { getStaticFeedUrl } from "@/constants";
import { getDb } from "@/db";

/**
 * Raw SQL against the in-memory DuckDB instance. Values interpolate via `?`
 * placeholders — never splice user input into `sql`.
 */
export async function runQuery<T>(
	sql: string,
	...parameters: string[]
): Promise<T[]> {
	const db = await getDb();
	const reader = await db.runAndReadAll(sql, parameters);
	await reader.readAll();
	const rows = reader.getRowObjectsJS() as unknown;
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return rows as T[];
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
