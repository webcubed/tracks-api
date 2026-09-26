/**
 * Memoize an async loader by call arguments. Concurrent callers share one
 * in-flight load; a rejected load evicts itself so the next call retries.
 */
export function memoize<Args extends unknown[], V>(
	load: (...args: Args) => Promise<V>
): (...args: Args) => Promise<V> {
	const cache = new Map<string, Promise<V>>();

	return async (...args: Args) => {
		const key = JSON.stringify(args);
		let pending = cache.get(key);
		if (!pending) {
			pending = load(...args);
			cache.set(key, pending);
			pending.catch(() => cache.delete(key));
		}

		return pending;
	};
}
