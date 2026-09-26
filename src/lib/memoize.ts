type Entry<V> = { promise: Promise<V>; at: number };

const clearHooks: Array<() => void> = [];

/**
 * Drop every memoized value so the next caller reloads. The hourly static
 * refresh drives this; the realtime proto root clears too, costing a few
 * milliseconds to re-parse on the next fetch.
 */
export function clearMemoized(): void {
	for (const clear of clearHooks) clear();
}

/**
 * Memoize an async loader by call arguments. Concurrent callers share one
 * in-flight load; a rejected load evicts itself so the next call retries.
 * With `ttlMs`, an entry older than it is replaced by a fresh load.
 */
export function memoize<Args extends unknown[], V>(
	load: (...args: Args) => Promise<V>,
	ttlMs = Number.POSITIVE_INFINITY
): (...args: Args) => Promise<V> {
	const cache = new Map<string, Entry<V>>();
	clearHooks.push(() => {
		cache.clear();
	});

	return async (...args: Args) => {
		const key = JSON.stringify(args);
		const hit = cache.get(key);
		if (hit && Date.now() - hit.at < ttlMs) return hit.promise;

		const entry: Entry<V> = { promise: load(...args), at: Date.now() };
		cache.set(key, entry);
		entry.promise.catch(() => {
			// A stale entry rejecting after replacement must not evict the new one.
			if (cache.get(key) === entry) cache.delete(key);
		});

		return entry.promise;
	};
}
