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
	ttlMs = Number.POSITIVE_INFINITY,
	maxEntries = 100
): (...args: Args) => Promise<V> {
	const cache = new Map<string, Entry<V>>();
	clearHooks.push(() => {
		cache.clear();
	});

	return async (...args: Args) => {
		const now = Date.now();
		const key = JSON.stringify(args);
		const hit = cache.get(key);
		if (hit && now - hit.at < ttlMs) return hit.promise;

		if (Number.isFinite(ttlMs) && cache.size >= maxEntries) {
			for (const [k, existing] of cache) {
				if (now - existing.at >= ttlMs) cache.delete(k);
			}

			if (cache.size >= maxEntries) {
				const oldestKey = cache.keys().next().value;
				if (oldestKey !== undefined) cache.delete(oldestKey);
			}
		}

		const entry: Entry<V> = { promise: load(...args), at: now };
		cache.set(key, entry);
		entry.promise.catch(() => {
			// A stale entry rejecting after replacement must not evict the new one.
			if (cache.get(key) === entry) cache.delete(key);
		});

		return entry.promise;
	};
}
