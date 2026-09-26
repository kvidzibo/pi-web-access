import { MAX_QUERIES, MAX_QUERY_CHARS } from "../constants.ts";
import type { QueryResult, RecencyFilter, SearchProvider } from "../types.ts";
import { normalizeList } from "../utils.ts";
import { searchDuckDuckGo } from "./duckduckgo.ts";
import { searchExa } from "./exa.ts";
import type { SearchOptions } from "./shared.ts";

export type { SearchOptions } from "./shared.ts";
export { searchExa } from "./exa.ts";
export { searchDuckDuckGo } from "./duckduckgo.ts";
export { normalizeDomainFilters, matchesDomainFilters } from "./filters.ts";
export { hitsToAnswer, normalizeCount } from "./shared.ts";

export function normalizeQueries(query?: unknown, queries?: unknown): string[] {
	return normalizeList(query, queries, "Query", MAX_QUERY_CHARS, MAX_QUERIES);
}

export function normalizeProvider(value: unknown): SearchProvider {
	if (value === undefined || value === null || value === "auto") return "auto";
	if (value === "exa" || value === "duckduckgo") return value;
	throw new Error(`Unsupported provider ${JSON.stringify(value)}. Use auto, exa, or duckduckgo.`);
}

export function normalizeRecency(value: unknown): RecencyFilter | undefined {
	if (value === undefined || value === null) return undefined;
	if (value === "day" || value === "week" || value === "month" || value === "year") return value;
	throw new Error(`Invalid recencyFilter ${JSON.stringify(value)}`);
}

export async function searchQueries(
	queries: string[],
	provider: SearchProvider,
	options: SearchOptions = {},
): Promise<QueryResult[]> {
	const results: QueryResult[] = [];
	for (const query of queries) {
		options.signal?.throwIfAborted();
		try {
			results.push(await searchOne(query, provider, options));
		} catch (err) {
			options.signal?.throwIfAborted();
			results.push({ query, provider, answer: "", hits: [], error: errorMessage(err) });
		}
	}
	return results;
}

async function searchOne(query: string, provider: SearchProvider, options: SearchOptions): Promise<QueryResult> {
	if (provider === "exa") return searchExa(query, options);
	if (provider === "duckduckgo") return searchDuckDuckGo(query, options);
	try {
		return await searchExa(query, options);
	} catch (err) {
		options.signal?.throwIfAborted();
		if (isTimeout(err)) throw err;
		const exaError = errorMessage(err);
		try {
			const fallback = await searchDuckDuckGo(query, options);
			fallback.answer = `${fallback.answer}\n\n[fallback: Exa failed: ${exaError}]`;
			return fallback;
		} catch (fallbackErr) {
			options.signal?.throwIfAborted();
			if (isTimeout(fallbackErr)) throw fallbackErr;
			const ddgError = errorMessage(fallbackErr);
			return {
				query,
				provider: "auto",
				answer: "",
				hits: [],
				error: `Exa failed: ${exaError}; DuckDuckGo failed: ${ddgError}`,
			};
		}
	}
}

function isTimeout(err: unknown): boolean {
	return err instanceof Error && err.name === "TimeoutError";
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message || err.name : String(err) || "Unknown error";
}
