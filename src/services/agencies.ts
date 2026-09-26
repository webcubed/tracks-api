import type { AgencyId, AgencyMode } from "@/constants";
import { AGENCIES, AGENCY_IDS } from "@/constants";
import { loadTable } from "@/lib/loadTable";
import { type Agency } from "@/types/static";

export type ApiAgency = {
	id: string;
	name: string;
	url: string;
	timezone: string;
	modes: AgencyMode[];
};

let cache: ApiAgency[];

/**
 * One entry per feed (8), not per GTFS `agency` row — all six bus feeds share
 * a single `MTABC` row, so the raw table only distinguishes three operators.
 */
async function loadAgencies(): Promise<ApiAgency[]> {
	if (cache) return cache;

	cache = await Promise.all(
		AGENCY_IDS.map(async (id) => {
			const [row] = await loadTable(id, "agency");
			return {
				id,
				name: AGENCIES[id].name,
				url: row?.agency_url.trim() ?? "",
				timezone: row?.agency_timezone ?? "America/New_York",
				modes: [AGENCIES[id].mode],
			};
		})
	);

	return cache;
}

export async function getAgencies(): Promise<ApiAgency[]> {
	return loadAgencies();
}

export async function getAgency(id: string): Promise<ApiAgency | undefined> {
	const agencies = await loadAgencies();
	return agencies.find((agency) => agency.id === id);
}
