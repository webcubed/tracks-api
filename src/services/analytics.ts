import type { AgencyId } from "@/constants";
import { archiveUsesSharedConnection, runArchiveQuery } from "@/archive/duck";
import { archiveFiles, archiveSummary } from "@/archive/store";
import { AGENCY_IDS, getStaticFeedUrl } from "@/constants";
import { distanceMeters } from "@/lib/geo";
import { runQuery } from "@/lib/parquet";
import { clockSeconds } from "@/lib/time";
import { getRoutes } from "@/services/routes";
import { activeServices } from "@/services/schedule";
import { resolveStopIds } from "@/services/stops";

/** Five minutes late is late. Early by the same margin is not "on time" either. */
export const ON_TIME_THRESHOLD_SECONDS = 300;

/** A car that stops reporting for this long starts a new segment. */
const SEGMENT_GAP_SECONDS = 600;

/** History windows: an hour at minimum, two days at most. */
export function clampHours(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return 24;

	return Math.min(48, Math.max(1, Math.round(value)));
}

function parquetSource(files: readonly string[]): string {
	const quoted = files.map((file) => `'${file.replaceAll("'", "''")}'`);

	return `read_parquet([${quoted.join(", ")}])`;
}

function iso(seconds: number): string {
	return new Date(seconds * 1000).toISOString();
}

export type ArchiveCoverageResponse = {
	prefix: string;
	/** True when archive reads share the live DuckDB connection (serialized). */
	sharesLiveConnection: boolean;
	datasets: Array<{
		dataset: string;
		parts: number;
		bytes: number;
		first?: string;
		last?: string;
	}>;
};

export async function getCoverage(): Promise<ArchiveCoverageResponse> {
	return {
		prefix: process.env.ARCHIVE_PREFIX ?? "v1",
		sharesLiveConnection: archiveUsesSharedConnection(),
		datasets: await archiveSummary(),
	};
}

type FleetRow = {
	ts: number;
	train: string;
	branch: string;
	fleet?: string;
	cars?: string;
	lat?: number;
	lon?: number;
	next_stop?: string;
	section?: string;
};

export type CarSegment = {
	train: string;
	branch: string;
	branchName?: string;
	fleet?: string;
	from: string;
	to: string;
	minutes: number;
	km: number;
	headingTo?: string;
	section?: string;
};

export type CarHistory = {
	car: number;
	hours: number;
	window: { from: string; to: string };
	samples: number;
	firstSeen?: string;
	lastSeen?: string;
	/** Distance between consecutive samples, in kilometres. */
	km: number;
	fleet?: string;
	branches: Array<{ id: string; name?: string }>;
	trains: string[];
	segments: CarSegment[];
};

/**
 * Where one car has been: every train that pulled it, the branch each run was
 * on, and the track sections between them. A consist can move between trains
 * in a day, so segments break on train or branch change and on a reporting gap.
 */
export async function getCarHistory(
	car: number,
	hours: number
): Promise<CarHistory> {
	const to = Math.floor(Date.now() / 1000);
	const from = to - hours * 3600;
	const window = { from: iso(from), to: iso(to) };
	const files = await archiveFiles("lirr_fleet", from, to);
	if (files.length === 0) {
		return {
			car,
			hours,
			window,
			samples: 0,
			km: 0,
			branches: [],
			trains: [],
			segments: [],
		};
	}

	const rows = await runArchiveQuery<FleetRow>(
		`SELECT ts, train, branch, fleet, cars, lat, lon, next_stop, section
		 FROM ${parquetSource(files)}
		 WHERE list_contains(string_split(cars, ' '), ?)
		 ORDER BY ts`,
		String(car)
	);
	const samples = rows.map((row) => ({
		...row,
		ts: Number(row.ts),
		lat:
			row.lat === undefined || row.lat === null ? undefined : Number(row.lat),
		lon:
			row.lon === undefined || row.lon === null ? undefined : Number(row.lon),
	}));

	const branches = [
		...new Set(samples.map((sample) => sample.branch).filter(Boolean)),
	];
	const lirrRoutes = await getRoutes("lirr");
	const names = new Map(
		lirrRoutes.map((route) => [
			route.id,
			route.longName ?? route.shortName ?? route.id,
		])
	);
	const trains = [
		...new Set(samples.map((sample) => sample.train).filter(Boolean)),
	];
	const segments: CarSegment[] = [];
	let km = 0;
	let current: CarSegment | undefined;
	let previous: (typeof samples)[number] | undefined;

	for (const sample of samples) {
		const gap = previous ? sample.ts - previous.ts : Number.POSITIVE_INFINITY;
		const moved =
			previous?.lat !== undefined &&
			previous?.lon !== undefined &&
			sample.lat !== undefined &&
			sample.lon !== undefined
				? distanceMeters(
						{ lat: previous.lat, lon: previous.lon },
						{ lat: sample.lat, lon: sample.lon }
					) / 1000
				: 0;

		if (
			current?.train !== sample.train ||
			current?.branch !== sample.branch ||
			gap > SEGMENT_GAP_SECONDS
		) {
			current = {
				train: sample.train,
				branch: sample.branch,
				branchName: names.get(sample.branch),
				fleet: sample.fleet ?? undefined,
				from: iso(sample.ts),
				to: iso(sample.ts),
				minutes: 1,
				km: 0,
				headingTo: sample.next_stop ?? undefined,
				section: sample.section ?? undefined,
			};
			segments.push(current);
		} else {
			current.to = iso(sample.ts);
		}

		if (current) {
			current.km += Math.round(moved * 10) / 10;
			if (sample.next_stop) current.headingTo = sample.next_stop;
			if (sample.section) current.section = sample.section;
		}

		km += moved;
		previous = sample;
	}

	// Recompute durations from the segment endpoints: `minutes` above runs while
	// the segment is still being extended.
	for (const segment of segments) {
		const start = Date.parse(segment.from) / 1000;
		const end = Date.parse(segment.to) / 1000;
		segment.minutes = Math.max(1, Math.round((end - start) / 60));
		segment.km = Math.round(segment.km * 10) / 10;
	}

	return {
		car,
		hours,
		window,
		samples: samples.length,
		firstSeen: samples[0]?.ts === undefined ? undefined : iso(samples[0].ts),
		lastSeen:
			samples.at(-1)?.ts === undefined
				? undefined
				: iso(samples.at(-1)?.ts ?? 0),
		km: Math.round(km * 10) / 10,
		fleet: samples.find((sample) => sample.fleet)?.fleet,
		branches: branches.map((id) => ({ id, name: names.get(id) })),
		trains,
		segments,
	};
}

type ReliabilityRow = {
	route?: string;
	stop?: string;
	samples?: number;
	on_time?: number;
	median_delay?: number;
	p90_delay?: number;
	mean_delay?: number;
};

export type ReliabilityBucket = {
	route?: string;
	stop?: string;
	samples: number;
	onTimeRate: number;
	medianDelaySeconds: number;
	p90DelaySeconds: number;
	meanDelaySeconds: number;
};

export type ReliabilityReport = {
	agency?: string;
	route?: string;
	hours: number;
	window: { from: string; to: string };
	onTimeThresholdSeconds: number;
	samples: number;
	onTimeRate: number;
	medianDelaySeconds: number;
	p90DelaySeconds: number;
	meanDelaySeconds: number;
	routes: Array<{
		route: string;
		samples: number;
		onTimeRate: number;
		medianDelaySeconds: number;
		p90DelaySeconds: number;
		meanDelaySeconds: number;
	}>;
	stops: Array<{
		route?: string;
		stop: string;
		samples: number;
		onTimeRate: number;
		medianDelaySeconds: number;
		p90DelaySeconds: number;
		meanDelaySeconds: number;
	}>;
};

function bucket(row: ReliabilityRow): ReliabilityBucket {
	const samples = Number(row.samples ?? 0);

	return {
		route: row.route ?? undefined,
		stop: row.stop ?? undefined,
		samples,
		onTimeRate: samples === 0 ? 0 : Number(row.on_time ?? 0),
		medianDelaySeconds: Math.round(Number(row.median_delay ?? 0)),
		p90DelaySeconds: Math.round(Number(row.p90_delay ?? 0)),
		meanDelaySeconds: Math.round(Number(row.mean_delay ?? 0)),
	};
}

/**
 * Delay for each `(trip, stop)` as it stands now: the newest prediction wins,
 * so a train that recovered before arrival is judged on arrival, not on the
 * worst thing it said an hour earlier. One pass over the parts feeds the
 * total, the per-route rows and the worst stops through grouping sets.
 */
export async function getReliability(options: {
	agency?: AgencyId;
	route?: string;
	hours: number;
}): Promise<ReliabilityReport> {
	const { agency, route, hours } = options;
	const to = Math.floor(Date.now() / 1000);
	const from = to - hours * 3600;
	const window = { from: iso(from), to: iso(to) };
	const report: ReliabilityReport = {
		agency,
		route,
		hours,
		window,
		onTimeThresholdSeconds: ON_TIME_THRESHOLD_SECONDS,
		samples: 0,
		onTimeRate: 0,
		medianDelaySeconds: 0,
		p90DelaySeconds: 0,
		meanDelaySeconds: 0,
		routes: [],
		stops: [],
	};

	const files = await archiveFiles("arrivals", from, to);
	if (files.length === 0) return report;

	const rows = await runArchiveQuery<ReliabilityRow>(
		`WITH latest AS (
		   SELECT route, stop, delay FROM (
		     SELECT route, stop, delay,
		            row_number() OVER (PARTITION BY trip, stop ORDER BY ts DESC) AS rank
		     FROM ${parquetSource(files)}
		     WHERE agency = ? AND (? = '' OR route = ?) AND delay IS NOT NULL
		   ) WHERE rank = 1
		 )
		 SELECT coalesce(route, '') AS route, coalesce(stop, '') AS stop,
		        count(*) AS samples,
		        avg(CASE WHEN abs(delay) <= ? THEN 1 ELSE 0 END) AS on_time,
		        median(delay) AS median_delay,
		        quantile_cont(delay, 0.9) AS p90_delay,
		        avg(delay) AS mean_delay
		 FROM latest
		 GROUP BY GROUPING SETS ((route, stop), (route), ())`,
		agency ?? "",
		route ?? "",
		route ?? "",
		String(ON_TIME_THRESHOLD_SECONDS)
	);

	for (const row of rows) {
		const entry = bucket(row);
		if (!entry.route && !entry.stop) {
			report.samples = entry.samples;
			report.onTimeRate = entry.onTimeRate;
			report.medianDelaySeconds = entry.medianDelaySeconds;
			report.p90DelaySeconds = entry.p90DelaySeconds;
			report.meanDelaySeconds = entry.meanDelaySeconds;
			continue;
		}

		if (!entry.stop) {
			report.routes.push({
				route: entry.route ?? "",
				samples: entry.samples,
				onTimeRate: entry.onTimeRate,
				medianDelaySeconds: entry.medianDelaySeconds,
				p90DelaySeconds: entry.p90DelaySeconds,
				meanDelaySeconds: entry.meanDelaySeconds,
			});
			continue;
		}

		report.stops.push({
			route: entry.route,
			stop: entry.stop ?? "",
			samples: entry.samples,
			onTimeRate: entry.onTimeRate,
			medianDelaySeconds: entry.medianDelaySeconds,
			p90DelaySeconds: entry.p90DelaySeconds,
			meanDelaySeconds: entry.meanDelaySeconds,
		});
	}

	report.routes.sort((a, b) => b.samples - a.samples);
	report.stops.sort(
		(a, b) => a.onTimeRate - b.onTimeRate || b.samples - a.samples
	);

	return report;
}

export type StopReliability = {
	stop: { id: string; name: string };
	agency: string;
	hours: number;
	window: { from: string; to: string };
	samples: number;
	onTimeRate: number;
	medianDelaySeconds: number;
	p90DelaySeconds: number;
	meanDelaySeconds: number;
	routes: Array<{
		route: string;
		samples: number;
		onTimeRate: number;
		medianDelaySeconds: number;
	}>;
};

/** Reliability at one station, across every route and platform it serves. */
export async function getStopReliability(
	stopId: string,
	agency: AgencyId | undefined,
	hours: number
): Promise<StopReliability | undefined> {
	const resolved = await resolveStopIds(stopId, agency);
	if (!resolved) return undefined;

	const to = Math.floor(Date.now() / 1000);
	const from = to - hours * 3600;
	const window = { from: iso(from), to: iso(to) };
	const ids = resolved.ids.map(String);
	const empty: StopReliability = {
		stop: { id: resolved.stop.id, name: resolved.stop.name },
		agency: resolved.agency,
		hours,
		window,
		samples: 0,
		onTimeRate: 0,
		medianDelaySeconds: 0,
		p90DelaySeconds: 0,
		meanDelaySeconds: 0,
		routes: [],
	};
	const files = await archiveFiles("arrivals", from, to);
	if (files.length === 0) return empty;

	const placeholders = ids.map(() => "?").join(", ");
	const rows = await runArchiveQuery<ReliabilityRow>(
		`WITH latest AS (
		   SELECT route, delay FROM (
		     SELECT route, delay,
		            row_number() OVER (PARTITION BY trip, stop ORDER BY ts DESC) AS rank
		     FROM ${parquetSource(files)}
		     WHERE agency = ? AND stop IN (${placeholders}) AND delay IS NOT NULL
		   ) WHERE rank = 1
		 )
		 SELECT coalesce(route, '') AS route, count(*) AS samples,
		        avg(CASE WHEN abs(delay) <= ? THEN 1 ELSE 0 END) AS on_time,
		        median(delay) AS median_delay,
		        quantile_cont(delay, 0.9) AS p90_delay,
		        avg(delay) AS mean_delay
		 FROM latest
		 GROUP BY GROUPING SETS ((route), ())`,
		resolved.agency,
		...ids,
		String(ON_TIME_THRESHOLD_SECONDS)
	);

	for (const row of rows) {
		const entry = bucket(row);
		if (entry.route) {
			empty.routes.push({
				route: entry.route,
				samples: entry.samples,
				onTimeRate: entry.onTimeRate,
				medianDelaySeconds: entry.medianDelaySeconds,
			});
			continue;
		}

		empty.samples = entry.samples;
		empty.onTimeRate = entry.onTimeRate;
		empty.medianDelaySeconds = entry.medianDelaySeconds;
		empty.p90DelaySeconds = entry.p90DelaySeconds;
		empty.meanDelaySeconds = entry.meanDelaySeconds;
	}

	empty.routes.sort((a, b) => b.samples - a.samples);

	return empty;
}

type DepartureRow = {
	route: string;
	departure_time: string;
};

export type FrequencyHour = { hour: string; trips: number };

export type FrequencyRoute = {
	route: string;
	/** The feed's own name for the route, so a panel can say what it serves. */
	longName?: string;
	shortName?: string;
	trips: number;
	firstDeparture?: string;
	lastDeparture?: string;
	/** Shortest gap between two departures, in minutes. */
	peakHeadwayMinutes?: number;
	medianHeadwayMinutes?: number;
	tripsPerHour: FrequencyHour[];
};

export type FrequencyReport = {
	agency: string;
	date: string;
	route?: string;
	stop?: { id: string; name: string };
	trips: number;
	routes: FrequencyRoute[];
	/** Where the numbers come from: the timetable the feed publishes for the date. */
	source: "timetable";
};

function headways(times: number[]): { peak?: number; median?: number } {
	const sorted = times.toSorted((a, b) => a - b);
	const gaps = sorted
		.slice(1)
		.map((time, index) => time - (sorted[index] ?? time))
		.filter((gap) => gap > 0);
	if (gaps.length === 0) return {};

	const minutes = gaps.map((gap) => gap / 60).toSorted((a, b) => a - b);
	const middle = Math.floor(minutes.length / 2);
	const median =
		minutes.length % 2 === 0
			? ((minutes[middle - 1] ?? 0) + (minutes[middle] ?? 0)) / 2
			: (minutes[middle] ?? 0);

	return {
		peak: Math.round((minutes[0] ?? 0) * 10) / 10,
		median: Math.round(median * 10) / 10,
	};
}

/**
 * How often service runs, from the timetable rather than from recorded
 * traffic: the timetable answers for any date, including tomorrow, and it is
 * what the operator committed to. Recorded headways could only describe the
 * days the recorder happened to be running.
 *
 * `stop` counts every trip calling there; without it, only first stops count,
 * so a route's own frequency is not multiplied by its stop count.
 */
const frequencyMemo = new Map<string, Promise<FrequencyReport | undefined>>();

/**
 * A timetable answer is fixed for its date, and one scan reads tens of
 * megabytes of remote parquet. One scan per feed, date and filter serves every
 * request; a scan already in flight is shared rather than started again.
 */
async function memoizedFrequency(
	key: string,
	scan: () => Promise<FrequencyReport | undefined>
): Promise<FrequencyReport | undefined> {
	const pending = frequencyMemo.get(key);
	if (pending) return pending;

	const running = scan().catch((error: unknown) => {
		frequencyMemo.delete(key);
		throw error;
	});
	frequencyMemo.set(key, running);

	return running;
}

/**
 * Drop cached scans. The supplemented timetable is republished hourly, so a
 * report describes the feed as it stood when it was built, not as it stands now.
 */
export function clearFrequencyCache(): void {
	frequencyMemo.clear();
}

export async function getFrequency(options: {
	agency: AgencyId;
	date: string;
	route?: string;
	stopId?: string;
}): Promise<FrequencyReport | undefined> {
	const { agency, date, route, stopId } = options;
	const key = [agency, date, route ?? "", stopId ?? ""].join("|");

	return memoizedFrequency(key, async () => scanFrequency(options));
}

async function scanFrequency(options: {
	agency: AgencyId;
	date: string;
	route?: string;
	stopId?: string;
}): Promise<FrequencyReport | undefined> {
	const { agency, date, route, stopId } = options;
	const resolved = stopId ? await resolveStopIds(stopId, agency) : undefined;
	if (stopId && !resolved) return undefined;

	const service = activeServices(agency, date);
	const stopFilter = resolved
		? `st.stop_id IN (${resolved.ids.map(() => "?").join(", ")}) AND st.departure_time <> ''`
		: "st.stop_sequence = '1' AND st.departure_time <> ''";
	const parameters = [
		...(resolved?.ids.map(String) ?? []),
		...(route ? [route] : []),
		...service.parameters,
	];

	const rows = await runQuery<DepartureRow>(
		`SELECT t.route_id AS route, st.departure_time
		 FROM read_parquet('${getStaticFeedUrl(agency, "stop_times")}') st
		 JOIN read_parquet('${getStaticFeedUrl(agency, "trips")}') t ON t.trip_id = st.trip_id
		 WHERE ${stopFilter}
		   ${route ? "AND t.route_id = ?" : ""}
		   AND t.service_id IN (${service.sql})
		 ORDER BY st.departure_time`,
		...parameters
	);

	const byRoute = new Map<string, DepartureRow[]>();
	for (const row of rows) {
		const list = byRoute.get(row.route) ?? [];
		list.push(row);
		byRoute.set(row.route, list);
	}

	// Route names come from the feed's routes table, which the hourly warmup
	// already holds: no extra parquet read, and a panel can name a bus route.
	const feedRoutes = await getRoutes(agency);
	const names = new Map(
		feedRoutes.map((route) => [
			route.id,
			{
				longName: route.longName || undefined,
				shortName: route.shortName || undefined,
			},
		])
	);
	const routes: FrequencyRoute[] = [...byRoute]
		.map(([id, departures]) => {
			const times = departures.map((departure) =>
				clockSeconds(departure.departure_time)
			);
			const perHour = new Map<number, number>();
			for (const time of times)
				perHour.set(
					Math.floor(time / 3600),
					(perHour.get(Math.floor(time / 3600)) ?? 0) + 1
				);
			const { peak, median } = headways(times);

			return {
				route: id,
				longName: names.get(id)?.longName,
				shortName: names.get(id)?.shortName,
				trips: departures.length,
				firstDeparture: departures[0]?.departure_time,
				lastDeparture: departures.at(-1)?.departure_time,
				peakHeadwayMinutes: peak,
				medianHeadwayMinutes: median,
				tripsPerHour: [...perHour]
					.toSorted(([a], [b]) => a - b)
					.map(([hour, trips]) => ({
						hour: String(hour).padStart(2, "0"),
						trips,
					})),
			};
		})
		.toSorted((a, b) =>
			a.route.localeCompare(b.route, undefined, { numeric: true })
		);

	return {
		agency,
		date,
		route,
		stop: resolved
			? { id: resolved.stop.id, name: resolved.stop.name }
			: undefined,
		trips: rows.length,
		routes,
		source: "timetable",
	};
}

/** The borough feeds the bus tab covers: every `bus_*` feed. */
const BUS_FEEDS: readonly AgencyId[] = AGENCY_IDS.filter((id) =>
	id.startsWith("bus_")
);

function mergeHours(
	left: FrequencyHour[],
	right: FrequencyHour[]
): FrequencyHour[] {
	const buckets = new Map(left.map((entry) => [entry.hour, entry.trips]));
	for (const entry of right)
		buckets.set(entry.hour, (buckets.get(entry.hour) ?? 0) + entry.trips);

	return [...buckets]
		.toSorted(([a], [b]) => Number(a) - Number(b))
		.map(([hour, trips]) => ({ hour, trips }));
}

function soonest(left?: number, right?: number): number | undefined {
	if (left === undefined) return right;
	if (right === undefined) return left;

	return Math.min(left, right);
}

/**
 * Bus rhythm across every borough. The six feeds are scanned one at a time
 * (queries share one DuckDB connection) and merged, which is why the result is
 * memoized per date, warmed at startup and rebuilt just after midnight: twenty
 * seconds of remote parquet should not sit in front of a page load.
 *
 * Route ids are unique across the borough feeds today; if one is ever shared,
 * the merge counts both feeds rather than dropping a borough.
 */
export async function getBusFrequency(
	date: string,
	route?: string
): Promise<FrequencyReport | undefined> {
	return memoizedFrequency(`bus|${date}|${route ?? ""}`, async () => {
		const reports: FrequencyReport[] = [];
		for (const feed of BUS_FEEDS) {
			// eslint-disable-next-line no-await-in-loop -- one shared DuckDB connection
			const report = await getFrequency({ agency: feed, date, route });
			if (report) reports.push(report);
		}

		const merged = new Map<string, FrequencyRoute>();
		let trips = 0;
		for (const report of reports) {
			trips += report.trips;
			for (const entry of report.routes) {
				const existing = merged.get(entry.route);
				if (!existing) {
					merged.set(entry.route, {
						...entry,
						tripsPerHour: [...entry.tripsPerHour],
					});
					continue;
				}

				existing.trips += entry.trips;
				existing.tripsPerHour = mergeHours(
					existing.tripsPerHour,
					entry.tripsPerHour
				);
				existing.peakHeadwayMinutes = soonest(
					existing.peakHeadwayMinutes,
					entry.peakHeadwayMinutes
				);
				existing.medianHeadwayMinutes = soonest(
					existing.medianHeadwayMinutes,
					entry.medianHeadwayMinutes
				);
				if (
					entry.firstDeparture !== undefined &&
					(existing.firstDeparture === undefined ||
						entry.firstDeparture < existing.firstDeparture)
				)
					existing.firstDeparture = entry.firstDeparture;
				if (
					entry.lastDeparture !== undefined &&
					(existing.lastDeparture === undefined ||
						entry.lastDeparture > existing.lastDeparture)
				)
					existing.lastDeparture = entry.lastDeparture;
			}
		}

		return {
			agency: "bus",
			date,
			route,
			trips,
			routes: [...merged.values()].toSorted((a, b) =>
				a.route.localeCompare(b.route, undefined, { numeric: true })
			),
			source: "timetable" as const,
		};
	});
}
