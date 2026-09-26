import type { AgencyId, AgencyTableMap } from "@/constants";
import type { TableMap } from "@/types/static";
import { memoize } from "@/lib/memoize";
import { queryTable } from "@/lib/parquet";

const load = memoize(
	async (agency: AgencyId, table: AgencyTableMap[AgencyId]) =>
		queryTable(agency, table)
);

/**
 * Every row of one table from one feed, held in memory.
 *
 * Keys on feed + table, not table alone: rows from different feeds are
 * indistinguishable (`Routes.agency_id` is the GTFS operator, shared by all
 * six bus feeds), so flattening them loses which feed a row came from.
 */
export async function loadTable<
	A extends AgencyId,
	T extends AgencyTableMap[A],
>(agency: A, table: T): Promise<Array<TableMap[T]>> {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return load(agency, table) as Promise<Array<TableMap[T]>>;
}
