import type { AgencyId, AgencyTableMap } from "@/constants";
import { AGENCY_IDS, getStaticFeedUrl } from "@/constants";
import { runQuery } from "@/lib/parquet";

/**
 * Prints which columns exist in which feed, for every GTFS table.
 *
 * The feeds do not share a schema: subway `stops` has no
 * `wheelchair_boarding`, LIRR `routes` has no `route_short_name`, LIRR `stops`
 * has no `location_type`. Everything is VARCHAR (see convert.ts).
 *
 *   pnpm exec tsx scripts/schema.ts
 */
type ColumnRow = { column_name: string; column_type: string };

type Table = AgencyTableMap[AgencyId];

const tables: Table[] = [
	"agency",
	"routes",
	"stops",
	"trips",
	"stop_times",
	"shapes",
	"calendar",
	"calendar_dates",
	"transfers",
	"feed_info",
];

async function describe(agency: AgencyId, table: Table): Promise<ColumnRow[]> {
	try {
		return await runQuery<ColumnRow>(
			`DESCRIBE SELECT * FROM read_parquet('${getStaticFeedUrl(agency, table)}')`
		);
	} catch {
		return []; // this feed doesn't ship the table (LIRR has no calendar, …)
	}
}

const columns = await Promise.all(
	AGENCY_IDS.flatMap((agency) =>
		tables.map(async (table) => ({
			table,
			agency,
			columns: await describe(agency, table),
		}))
	)
);

const pad = (value: string, size: number) => value.padEnd(size);

for (const table of tables) {
	const presence = new Map<string, Set<AgencyId>>();

	for (const entry of columns) {
		if (entry.table !== table) continue;

		for (const column of entry.columns) {
			const feeds = presence.get(column.column_name) ?? new Set<AgencyId>();
			feeds.add(entry.agency);
			presence.set(column.column_name, feeds);
		}
	}

	if (presence.size === 0) continue;

	console.log(`\n${table}`);
	console.log(
		pad("  column", 24) + AGENCY_IDS.map((id) => pad(id, 10)).join("")
	);
	for (const [name, feeds] of [...presence].toSorted((a, b) =>
		a[0].localeCompare(b[0])
	)) {
		const marks = AGENCY_IDS.map((id) => pad(feeds.has(id) ? "yes" : "-", 10));
		console.log(pad(`  ${name}`, 24) + marks.join(""));
	}
}
