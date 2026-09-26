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
