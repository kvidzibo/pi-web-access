import { MAX_SEARCH_BODY_BYTES, SEARCH_TIMEOUT_MS } from "../constants.ts";
import { readTextLimited } from "../network/body.ts";
import { fetchRemoteUrl } from "../network/fetch.ts";
import type { RecencyFilter, SearchHit } from "../types.ts";
import { withTimeout } from "../utils.ts";

export type SearchOptions = {
	numResults?: number;
	recencyFilter?: RecencyFilter;
	domainFilter?: string[];
	signal?: AbortSignal;
	fetch?: typeof fetch;
};

export function normalizeCount(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 5;
	return Math.max(1, Math.min(20, Math.floor(value)));
}

export function hitsToAnswer(hits: SearchHit[]): string {
	if (hits.length === 0) return "No results matched this query and its filters.";
	return hits
		.map((hit) => hit.snippet ? `${hit.snippet}\nSource: ${hit.title} (${hit.url})` : `Source: ${hit.title} (${hit.url})`)
		.join("\n\n");
}

export async function requestSearchText(url: string | URL, init: RequestInit, options: SearchOptions): Promise<{ response: Response; body: string }> {
	const signal = withTimeout(options.signal, SEARCH_TIMEOUT_MS);
	try {
		const response = options.fetch
			? await options.fetch(url, { ...init, signal })
			: (await fetchRemoteUrl(url, { ...init, signal })).response;
		const body = await readTextLimited(response, MAX_SEARCH_BODY_BYTES);
		signal.throwIfAborted();
		return { response, body };
	} catch (err) {
		// Node HTTP and stream adapters wrap timeout reasons in AbortError.
		// Keep the original signal reason consistent across DNS, HTTP, and body reads.
		signal.throwIfAborted();
		throw err;
	}
}
