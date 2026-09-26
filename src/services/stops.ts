import type { AgencyId } from "@/constants";
import type { Stops } from "@/types/static";
import { AGENCY_IDS } from "@/constants";
import { distanceMeters } from "@/lib/geo";
import { childIds, resolveStop, stopIndex } from "@/services/network";

export type ApiStop = {
	id: string;
	name: string;
	location: { lat: number; lon: number };
	geometry: { type: "Point"; coordinates: [number, number] };
	agency: string;
	routes: string[];
	/** Metres from the query point; set only by `?lat=&lon=&radius=`. */
	distance?: number;
	/** Only set when the feed says so; LIRR is the only one that ships it. */
	wheelchairAccessible?: boolean;
};

export type Proximity = { lat: number; lon: number; radius: number };

function toApi(
	agency: AgencyId,
	row: Stops,
	routes: Set<string> | undefined
): ApiStop {
	const lat = Number(row.stop_lat);
	const lon = Number(row.stop_lon);

	const stop: ApiStop = {
		id: row.stop_id,
		name: row.stop_name,
		location: { lat, lon },
		geometry: { type: "Point", coordinates: [lon, lat] },
		agency,
		routes: [...(routes ?? [])].toSorted((a, b) =>
			a.localeCompare(b, undefined, { numeric: true })
		),
	};

	// GTFS: "1" accessible, "2" not accessible, "0"/absent = no information.
	if (row.wheelchair_boarding === "1") stop.wheelchairAccessible = true;
	else if (row.wheelchair_boarding === "2") stop.wheelchairAccessible = false;

	return stop;
}

export async function getStops(
	agency?: AgencyId,
	route?: string,
	near?: Proximity
): Promise<ApiStop[]> {
	const feeds = agency ? [agency] : AGENCY_IDS;
	const indexes = await Promise.all(feeds.map(async (feed) => stopIndex(feed)));
	const stops: ApiStop[] = [];

	for (const [i, id] of feeds.entries()) {
		const index = indexes[i];
		for (const row of index.topLevel) {
			if (route && !index.routes.get(row.stop_id)?.has(route)) continue;

			stops.push(toApi(id, row, index.routes.get(row.stop_id)));
		}
	}

	if (!near) return stops;

	return stops
		.map((stop) => ({ stop, distance: distanceMeters(near, stop.location) }))
		.filter((entry) => entry.distance <= near.radius)
		.toSorted((a, b) => a.distance - b.distance)
		.map((entry) => ({ ...entry.stop, distance: Math.round(entry.distance) }));
}

/** With `feed`, resolve the id from that feed alone (an LIRR Penn shadowed by
 * a colliding subway id becomes reachable). */
export async function getStop(
	id: string,
	feed?: AgencyId
): Promise<ApiStop | undefined> {
	const resolved = await resolveStop(id, feed);
	if (!resolved) return undefined;

	return toApi(resolved.agency, resolved.row, resolved.index.routes.get(id));
}

export type ResolvedStopIds = {
	agency: AgencyId;
	stop: ApiStop;
	ids: string[];
};

/**
 * What `/v1/arrivals` needs from a stop: its response object, and every id a
 * feed may reference it by (GTFS-RT names platforms, like `127N` and `127S`).
 */
export async function resolveStopIds(
	id: string,
	feed?: AgencyId
): Promise<ResolvedStopIds | undefined> {
	const resolved = await resolveStop(id, feed);
	if (!resolved) return undefined;

	const { agency, index, row } = resolved;

	return {
		agency,
		stop: toApi(agency, row, index.routes.get(row.stop_id)),
		ids: [row.stop_id, ...childIds(index, row.stop_id)],
	};
}
