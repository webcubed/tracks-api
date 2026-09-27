import { memoize } from "@/lib/memoize";

export class ExperimentalFeedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ExperimentalFeedError";
	}
}

const fetchProductionJson = memoize(async (url: string): Promise<unknown> => {
	let response: Response;

	try {
		response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
	} catch (error) {
		throw new ExperimentalFeedError(
			`production API request failed: ${error instanceof Error ? error.message : String(error)}`
		);
	}

	if (response.status >= 300) {
		throw new ExperimentalFeedError(
			`production API responded ${response.status}`
		);
	}

	try {
		return await response.json();
	} catch {
		throw new ExperimentalFeedError("production API returned invalid JSON");
	}
}, 10_000);

export async function getProductionJson(url: string): Promise<unknown> {
	return fetchProductionJson(url);
}
