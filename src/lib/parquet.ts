import type { AgencyTableMap } from "@/constants";
import type { DuckDBConnection } from "@duckdb/node-api";
import { getStaticFeedUrl } from "@/constants";
import { getDb } from "@/db";

export async function queryTable<
	TAgency extends keyof AgencyTableMap,
	TTable extends AgencyTableMap[TAgency],
>(agency: TAgency, table: TTable, where?: string, ...parameters: string[]) {
	const db = await getDb();
	const url = getStaticFeedUrl(agency, table);
	const sql = `SELECT * FROM read_parquet('${url}')${where ? ` WHERE ${where}` : ""}`;
	const reader = await db.runAndReadAll(sql, parameters);
	await reader.readAll();
	return reader.getRowObjectsJS();
}
