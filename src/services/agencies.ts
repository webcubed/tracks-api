import type { AgencyTableMap } from "@/constants";
import { AGENCIES } from "@/constants";
import { queryTable } from "@/lib/parquet";
import { type Agency } from "@/types/static";

export type ApiAgency = {
	id: string;
	name: string;
	url: string;
	timezone: string;
};
const cache = new Map<string, ApiAgency>();
let loaded = false;
function toApi(row: Agency): ApiAgency {
	return {
		id: row.agency_id,
		name: row.agency_name,
		url: row.agency_url,
		timezone: row.agency_timezone,
	};
}

async function load(): Promise<void> {
	if (loaded) return;

	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	const agencyKeys = Object.values(AGENCIES) as unknown as Array<
		keyof AgencyTableMap
	>;

	const promises = agencyKeys.map(async (a) => queryTable(a, "agency"));
	const results = await Promise.all(promises);

	for (const rows of results) {
		for (const row of rows) {
			cache.set(row.agency_id, toApi(row));
		}
	}

	loaded = true;
}

export async function getAgencies() {
	await load();
	return [...cache.values()];
}

export async function getAgency(id: string): Promise<ApiAgency | undefined> {
	await load();
	return cache.get(id);
}
