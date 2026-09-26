import type { AgencyId } from "@/constants";
import { AGENCIES, AGENCY_IDS } from "@/constants";

export type ApiFare = {
	name: string;
	/** Absent when the price varies (zone or peak based). */
	amount?: number;
	currency: string;
	note?: string;
};

export type ApiAgencyFares = { agency: string; mode: string; fares: ApiFare[] };

const LOCAL_BUS: ApiFare[] = [
	{
		name: "Base fare",
		amount: 3,
		currency: "USD",
		note: "OMNY tap or MetroCard; free transfers within 2 hours",
	},
	{
		name: "Reduced fare",
		amount: 1.5,
		currency: "USD",
		note: "Seniors 65+ and riders with qualifying disabilities",
	},
	{
		name: "Weekly fare cap (OMNY)",
		amount: 35,
		currency: "USD",
		note: "After 12 paid taps in 7 days the rest of the week is free",
	},
];

/**
 * MTA ships no fare tables in its GTFS zips (checked 2026-09-26), so these are
 * curated from mta.info/fares-tolls, including the 2026-01-04 increase.
 * honey: hand-kept values; revisit whenever MTA revises fares.
 */
const FARES: Record<AgencyId, ApiFare[]> = {
	subway: LOCAL_BUS,
	lirr: [
		{
			name: "CityTicket off-peak (within NYC)",
			amount: 5.25,
			currency: "USD",
			note: "One-way, no direction change inside New York City",
		},
		{
			name: "CityTicket peak (within NYC)",
			amount: 7.25,
			currency: "USD",
			note: "One-way, no direction change inside New York City",
		},
		{
			name: "Zone fare",
			currency: "USD",
			note: "Varies by stations and peak/off-peak; buy in TrainTime before boarding",
		},
		{
			name: "Children",
			currency: "USD",
			note: "Half fare ages 5-17 with a paying adult ($1 Family Fare, up to 4); under 5 free",
		},
	],
	bus_bx: LOCAL_BUS,
	bus_b: LOCAL_BUS,
	bus_busco: [
		...LOCAL_BUS,
		{
			name: "Express bus base fare",
			amount: 7.25,
			currency: "USD",
			note: "BxM, BM, QM and SIM routes",
		},
	],
	bus_m: LOCAL_BUS,
	bus_si: LOCAL_BUS,
	bus_q: LOCAL_BUS,
};

export function getFares(agency?: AgencyId): ApiAgencyFares[] {
	const ids = agency ? [agency] : AGENCY_IDS;

	return ids.map((id) => ({
		agency: id,
		mode: AGENCIES[id].mode,
		fares: FARES[id],
	}));
}
