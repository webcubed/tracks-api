import type { AgencyTableMap } from "@/constants";
import type { TableMap } from "@/types/static";
import { AGENCIES } from "@/constants";
import { queryTable } from "@/lib/parquet";

// honey: unbounded, no eviction — fine while static GTFS only changes on a release.
const tables = new Map<string, Promise<unknown>>();

export async function loadTable<
	TTable extends AgencyTableMap[keyof AgencyTableMap],
>(table: TTable): Promise<Array<TableMap[TTable]>> {
	let pending = tables.get(table);
	if (!pending) {
		pending = Promise.all(
			Object.values(AGENCIES).map(async (a) => queryTable(a, table))
		).then((results) => results.flat());
		tables.set(table, pending);
		// Don't let a failed fetch poison the cache forever.
		pending.catch(() => tables.delete(table));
	}

	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return (await pending) as Array<TableMap[TTable]>;
}
