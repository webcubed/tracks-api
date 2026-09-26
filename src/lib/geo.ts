export type Point = { lat: number; lon: number };

/** Great-circle distance in metres. */
export function distanceMeters(from: Point, to: Point): number {
	const lat = ((to.lat - from.lat) * Math.PI) / 180;
	const lon = ((to.lon - from.lon) * Math.PI) / 180;
	const h =
		Math.sin(lat / 2) ** 2 +
		Math.cos((from.lat * Math.PI) / 180) *
			Math.cos((to.lat * Math.PI) / 180) *
			Math.sin(lon / 2) ** 2;

	return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}
