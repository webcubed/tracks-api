import { loadTable } from "@/lib/loadTable";
import { type Agency } from "@/types/static";

export type ApiAgency = {
	id: string;
	name: string;
	url: string;
	timezone: string;
};

function toApi(row: Agency): ApiAgency {
	return {
		id: row.agency_id,
		name: row.agency_name,
		url: row.agency_url,
		timezone: row.agency_timezone,
	};
}

let index: Map<string, ApiAgency>;

async function byId(): Promise<Map<string, ApiAgency>> {
	if (!index) {
		const rows = await loadTable("agency");
		index = new Map(rows.map((row) => [row.agency_id, toApi(row)]));
	}

	return index;
}

export async function getAgencies(): Promise<ApiAgency[]> {
	const agencies = await byId();
	return [...agencies.values()];
}

export async function getAgency(id: string): Promise<ApiAgency | undefined> {
	const agencies = await byId();
	return agencies.get(id);
}
