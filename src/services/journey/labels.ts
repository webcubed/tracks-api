import type { AgencyId } from "@/constants";
import type { Label, Search } from "@/services/journey/types";
import type { Station } from "@/services/network";
import { distanceMeters } from "@/lib/geo";
import {
	CELL_DEGREES,
	TRANSFER_S,
	WALK_M,
	WALK_S,
} from "@/services/journey/types";

/**
 * Keep a label unless a station-mate dominates it: earlier arrival on no
 * more rides means being there earlier lets you board everything it can.
 * The destination is exempt: each arrival there is its own itinerary
 * (that's where "next 5 trains" come from).
 */
export function admit(search: Search, label: Label): boolean {
	const key = `${label.feed}:${label.station}`;
	const existing = search.labels.get(key) ?? [];

	if (key !== search.destKey) {
		const dominated = existing.some(
			(other) => other.arrival <= label.arrival && other.rides <= label.rides
		);
		if (dominated) return false;
	}

	existing.push(label);
	search.labels.set(key, existing);
	search.walkQueue.push(label);

	return true;
}

export function drainWalks(search: Search): void {
	let label = search.walkQueue.shift();
	while (label) {
		soakLabel(search, label);
		transferLabel(search, label);
		label = search.walkQueue.shift();
	}
}

/** Every cross-feed station within walking distance of `label` gains a label
 * for being reached on foot. Same-feed neighbours come from transfers.txt
 * instead: in-feed coordinates can't be trusted at station-complex level. */
function soakLabel(search: Search, label: Label): void {
	for (const [feed, grid] of search.grids) {
		if (feed === label.feed) continue;

		for (const station of near(grid, label)) {
			if (distanceMeters(label, station.location) > WALK_M) continue;

			admit(search, {
				feed,
				station: station.id,
				lat: station.location.lat,
				lon: station.location.lon,
				arrival: label.arrival + WALK_S,
				rides: label.rides,
				round: label.round,
				via: { kind: "walk", from: label },
			});
		}
	}
}

/** Same-feed in-complex transfers from transfers.txt (Times Sq's 127 to
 * R16/N/Q/R/W, Jamaica's coordinated LIRR interchanges). */
function transferLabel(search: Search, label: Label): void {
	const edges = search.transfers.get(label.feed)?.get(label.station);
	if (!edges) return;

	for (const [station, seconds] of edges) {
		const target = search.stationsById.get(label.feed)?.get(station);
		if (!target) continue;

		admit(search, {
			feed: label.feed,
			station: target.id,
			lat: target.location.lat,
			lon: target.location.lon,
			arrival: label.arrival + Math.max(seconds, TRANSFER_S),
			rides: label.rides,
			round: label.round,
			via: { kind: "walk", from: label },
		});
	}
}

/** Candidates from the 5x5 cells around a point, filtered by real distance. */
function near(grid: Map<string, Station[]>, label: Label): Station[] {
	const row = Math.floor(label.lat / CELL_DEGREES);
	const column = Math.floor(label.lon / CELL_DEGREES);
	const found: Station[] = [];

	for (let r = row - 2; r <= row + 2; r++) {
		for (let c = column - 2; c <= column + 2; c++) {
			found.push(...(grid.get(`${r}:${c}`) ?? []));
		}
	}

	return found;
}

export function cellKey(point: { lat: number; lon: number }): string {
	return `${Math.floor(point.lat / CELL_DEGREES)}:${Math.floor(point.lon / CELL_DEGREES)}`;
}
