export type RouteBranch = Array<[number, number]>;

export type RouteVariant = {
	points: RouteBranch;
	trips: number;
};

const CELL_DEGREES = 0.005;
const GAP_METERS = 45;
const MIN_BRANCH_METERS = 120;
const DEDUPE_METERS = 100;
const MIN_BRANCH_TRIPS = 20;
const METERS_PER_DEGREE_LON = 84_200;
const METERS_PER_DEGREE_LAT = 111_320;

type SegmentIndex = {
	points: RouteBranch;
	grid: Map<string, number[]>;
};

function cellKey(lon: number, lat: number): string {
	return `${Math.floor(lon / CELL_DEGREES)}:${Math.floor(lat / CELL_DEGREES)}`;
}

function segmentIndex(points: RouteBranch): SegmentIndex {
	const grid = new Map<string, number[]>();

	for (let index = 0; index < points.length - 1; index += 1) {
		const from = points[index];
		const to = points[index + 1];
		const minX = Math.floor(Math.min(from[0], to[0]) / CELL_DEGREES);
		const maxX = Math.floor(Math.max(from[0], to[0]) / CELL_DEGREES);
		const minY = Math.floor(Math.min(from[1], to[1]) / CELL_DEGREES);
		const maxY = Math.floor(Math.max(from[1], to[1]) / CELL_DEGREES);

		for (let x = minX; x <= maxX; x += 1) {
			for (let y = minY; y <= maxY; y += 1) {
				const key = `${x}:${y}`;
				const cell = grid.get(key);
				if (cell) cell.push(index);
				else grid.set(key, [index]);
			}
		}
	}

	return { points, grid };
}

function segmentsNear(
	point: [number, number],
	index: SegmentIndex
): Set<number> {
	const x = Math.floor(point[0] / CELL_DEGREES);
	const y = Math.floor(point[1] / CELL_DEGREES);
	const found = new Set<number>();

	for (let dx = -1; dx <= 1; dx += 1) {
		for (let dy = -1; dy <= 1; dy += 1) {
			for (const segment of index.grid.get(`${x + dx}:${y + dy}`) ?? [])
				found.add(segment);
		}
	}

	return found;
}

function closestOnSegment(
	point: [number, number],
	from: [number, number],
	to: [number, number]
): { distance: number; point: [number, number] } {
	const shrink = Math.cos((point[1] * Math.PI) / 180);
	const ax = (from[0] - point[0]) * METERS_PER_DEGREE_LON * shrink;
	const ay = (from[1] - point[1]) * METERS_PER_DEGREE_LAT;
	const bx = (to[0] - point[0]) * METERS_PER_DEGREE_LON * shrink;
	const by = (to[1] - point[1]) * METERS_PER_DEGREE_LAT;
	const dx = bx - ax;
	const dy = by - ay;
	const lengthSquared = dx * dx + dy * dy;
	const t =
		lengthSquared === 0
			? 0
			: Math.min(1, Math.max(0, -(ax * dx + ay * dy) / lengthSquared));
	const px = ax + dx * t;
	const py = ay + dy * t;

	return {
		distance: Math.hypot(px, py),
		point: [
			point[0] + px / METERS_PER_DEGREE_LON / shrink,
			point[1] + py / METERS_PER_DEGREE_LAT,
		],
	};
}

function distanceToLine(point: [number, number], index: SegmentIndex): number {
	let closest = Number.POSITIVE_INFINITY;

	for (const segment of segmentsNear(point, index)) {
		const result = closestOnSegment(
			point,
			index.points[segment],
			index.points[segment + 1]
		);
		closest = Math.min(closest, result.distance);
	}

	return closest;
}

function nearestPointOnLine(
	point: [number, number],
	index: SegmentIndex
): [number, number] | undefined {
	let closest = Number.POSITIVE_INFINITY;
	let nearest: [number, number] | undefined;

	let candidates = segmentsNear(point, index);
	if (candidates.size === 0) {
		candidates = new Set(
			Array.from({ length: index.points.length - 1 }, (_, item) => item)
		);
	}

	for (const segment of candidates) {
		const result = closestOnSegment(
			point,
			index.points[segment],
			index.points[segment + 1]
		);
		if (result.distance < closest) {
			closest = result.distance;
			nearest = result.point;
		}
	}

	return nearest;
}

function branchMeters(points: RouteBranch): number {
	let total = 0;
	for (let index = 1; index < points.length; index += 1) {
		const from = points[index - 1];
		const to = points[index];
		total += Math.hypot(
			(to[0] - from[0]) * METERS_PER_DEGREE_LON,
			(to[1] - from[1]) * METERS_PER_DEGREE_LAT
		);
	}

	return total;
}

function sameBranch(first: RouteBranch, second: RouteBranch): boolean {
	const toMeters = (from: [number, number], to: [number, number]) =>
		Math.hypot(
			(to[0] - from[0]) * METERS_PER_DEGREE_LON,
			(to[1] - from[1]) * METERS_PER_DEGREE_LAT
		);
	const firstStart = first[0];
	const firstEnd = first.at(-1);
	const secondStart = second[0];
	const secondEnd = second.at(-1);
	if (!firstStart || !firstEnd || !secondStart || !secondEnd) return false;

	return (
		(toMeters(firstStart, secondStart) < DEDUPE_METERS &&
			toMeters(firstEnd, secondEnd) < DEDUPE_METERS) ||
		(toMeters(firstStart, secondEnd) < DEDUPE_METERS &&
			toMeters(firstEnd, secondStart) < DEDUPE_METERS)
	);
}

function branchForRun(
	points: RouteBranch,
	start: number,
	end: number,
	index: SegmentIndex
): RouteBranch | undefined {
	const connectsAtStart = start > 0;
	const connectsAtEnd = end < points.length - 1;

	// A detour that leaves and rejoins the trunk is another alignment of the
	// same service, not a branch to a different terminal.
	if (connectsAtStart === connectsAtEnd) return undefined;

	const run = points.slice(start, end + 1);
	const connection = nearestPointOnLine(
		connectsAtStart ? run[0] : (run.at(-1) ?? run[0]),
		index
	);
	if (!connection) return undefined;

	const branch = connectsAtStart ? [connection, ...run] : [...run, connection];

	return branchMeters(branch) >= MIN_BRANCH_METERS ? branch : undefined;
}

/** Pull the off-trunk alignments that the single representative shape omits. */
export function findRouteBranches(
	representative: RouteBranch,
	variants: RouteVariant[]
): RouteBranch[] {
	if (representative.length < 2) return [];
	const index = segmentIndex(representative);
	const branches: RouteBranch[] = [];

	for (const { points, trips } of variants) {
		if (trips < MIN_BRANCH_TRIPS) continue;
		const awayFromTrunk = points.map(
			(point) => distanceToLine(point, index) > GAP_METERS
		);

		let start = 0;
		while (start < points.length) {
			if (!awayFromTrunk[start]) {
				start += 1;
				continue;
			}

			let end = start;
			while (end + 1 < points.length && awayFromTrunk[end + 1]) end += 1;

			const branch = branchForRun(points, start, end, index);
			if (branch && !branches.some((item) => sameBranch(item, branch)))
				branches.push(branch);

			start = end + 1;
		}
	}

	return branches;
}
