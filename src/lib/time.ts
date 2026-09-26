/** Seconds since midnight; schedule times run past 24:00 for late service. */
export function clockSeconds(clock: string): number {
	const [hours = 0, minutes = 0, seconds = 0] = clock.split(":").map(Number);

	return hours * 3600 + minutes * 60 + seconds;
}

/** `clockSeconds` in reverse, zero-padded (24:05:00 stays past midnight). */
export function clockOf(seconds: number): string {
	const parts = [
		Math.floor(seconds / 3600),
		Math.floor((seconds % 3600) / 60),
		seconds % 60,
	];

	return parts.map((part) => String(part).padStart(2, "0")).join(":");
}

/** Today in the service's own timezone, not the server's. */
export function today(): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: "America/New_York",
	}).format(new Date());
}

/**
 * Strict `YYYY-MM-DD`: parse it, then check the round trip. Rejects
 * `2026-2-3`, `garbage` and impossible dates like `2026-02-31` (which parse
 * as March 3rd), and needs no regex flags: `tsconfig` targets ES2017, which
 * can't compile the `v` flag xo asks for.
 */
export function isValidDate(value: string): boolean {
	const date = new Date(`${value}T00:00:00Z`);

	if (Number.isNaN(date.getTime())) return false;

	return date.toISOString().slice(0, 10) === value;
}
