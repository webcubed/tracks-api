import type { AgencyTableMap } from "@/constants";
import { getStaticFeedUrl } from "@/constants";
import { runQuery } from "@/lib/parquet";

const [agency, table, sql] = process.argv.slice(2);

if (!agency || !table || !sql) {
	throw new Error(
		"usage: tsx scripts/sql.ts <agency> <table> <sql, {{url}} expands to the parquet URL>"
	);
}

const reader = await runQuery<Record<string, unknown>>(
	sql.replaceAll(
		"{{url}}",
		getStaticFeedUrl(
			// Raw argv: the shell user vouches for these feed and table names.
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			agency as keyof AgencyTableMap,
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			table as AgencyTableMap[keyof AgencyTableMap]
		)
	)
);
console.log(`rows: ${reader.length}`);
console.log(
	JSON.stringify(
		reader,
		(_key, value: unknown) =>
			typeof value === "bigint" ? Number(value) : value,
		2
	)
);
