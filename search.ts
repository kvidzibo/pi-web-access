import { DDG_SEARCH_URL, EXA_MCP_URL, MAX_DOMAIN_FILTERS, MAX_QUERIES, MAX_QUERY_CHARS, MAX_SEARCH_BODY_BYTES, SEARCH_TIMEOUT_MS, USER_AGENT } from "./constants.ts";
import { readTextLimited } from "./fetch.ts";
import { parseDdgHtml, parseExaMcpBody } from "./html.ts";
import { fetchRemoteUrl } from "./ssrf.ts";
import type { QueryResult, RecencyFilter, SearchHit, SearchProvider } from "./types.ts";
import { normalizeList, withTimeout } from "./utils.ts";

export type SearchOptions = {
	numResults?: number;
	recencyFilter?: RecencyFilter;
	domainFilter?: string[];
	signal?: AbortSignal;
	fetch?: typeof fetch;
};

export function normalizeQueries(query?: unknown, queries?: unknown): string[] {
	return normalizeList(query, queries, "Query", MAX_QUERY_CHARS, MAX_QUERIES);
}

export function normalizeCount(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 5;
	return Math.max(1, Math.min(20, Math.floor(value)));
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

export function normalizeDomainFilters(domainFilter: string[] | undefined): { allowed: string[]; blocked: string[] } {
	const filters = { allowed: [] as string[], blocked: [] as string[] };
	let count = 0;
	for (const raw of domainFilter ?? []) {
		if (count >= MAX_DOMAIN_FILTERS) break;
		const blocked = raw.trim().startsWith("-");
		const domain = normalizeDomain(blocked ? raw.trim().slice(1) : raw);
		if (!domain) continue;
		const target = blocked ? filters.blocked : filters.allowed;
		if (!target.includes(domain)) {
			target.push(domain);
			count += 1;
		}
	}
	return filters;
}

export function matchesDomainFilters(url: string, filters: { allowed: string[]; blocked: string[] }): boolean {
	let hostname: string;
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
		hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
	} catch {
		return false;
	}
	if (filters.allowed.length > 0 && !filters.allowed.some((domain) => hostMatches(hostname, domain))) return false;
	return !filters.blocked.some((domain) => hostMatches(hostname, domain));
}

export function hitsToAnswer(hits: SearchHit[]): string {
	if (hits.length === 0) return "No results matched this query and its filters.";
	return hits
		.map((hit) => hit.snippet ? `${hit.snippet}\nSource: ${hit.title} (${hit.url})` : `Source: ${hit.title} (${hit.url})`)
		.join("\n\n");
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

export async function searchExa(query: string, options: SearchOptions = {}): Promise<QueryResult> {
	options.signal?.throwIfAborted();
	const numResults = normalizeCount(options.numResults);
	const mcpQuery = buildExaQuery(query, options);
	const { response, body } = await requestSearchText(`${EXA_MCP_URL}?tools=web_search_exa`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"x-exa-source": "@kvidzibo/pi-web-access",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "web_search_exa", arguments: { query: mcpQuery, numResults } },
		}),
	}, options);
	if (!response.ok) {
		if (response.status === 429) throw new Error(`Exa MCP rate limit (429): ${body.slice(0, 200)}`);
		throw new Error(`Exa MCP error ${response.status}: ${body.slice(0, 300)}`);
	}
	const hits = applyDomainFilter(parseExaMcpBody(body), options.domainFilter).slice(0, numResults);
	return { query, provider: "exa", answer: hitsToAnswer(hits), hits };
}

export async function searchDuckDuckGo(query: string, options: SearchOptions = {}): Promise<QueryResult> {
	options.signal?.throwIfAborted();
	const numResults = normalizeCount(options.numResults);
	const url = new URL(DDG_SEARCH_URL);
	url.searchParams.set("q", buildDomainQuery(query, options.domainFilter));
	if (options.recencyFilter) url.searchParams.set("df", { day: "d", week: "w", month: "m", year: "y" }[options.recencyFilter]);
	const { response, body } = await requestSearchText(url, {
		method: "GET",
		headers: {
			Accept: "text/html",
			"User-Agent": USER_AGENT,
		},
	}, options);
	if (!response.ok) throw new Error(`DuckDuckGo search error ${response.status}: ${body.slice(0, 300)}`);
	const parsed = parseDdgHtml(body);
	if (parsed.length === 0) throw new Error("DuckDuckGo returned no parseable results");
	const hits = applyDomainFilter(parsed, options.domainFilter).slice(0, numResults);
	return { query, provider: "duckduckgo", answer: hitsToAnswer(hits), hits };
}

async function requestSearchText(url: string | URL, init: RequestInit, options: SearchOptions): Promise<{ response: Response; body: string }> {
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

function applyDomainFilter(hits: SearchHit[], domainFilter?: string[]): SearchHit[] {
	const filters = normalizeDomainFilters(domainFilter);
	return hits.filter((hit) => matchesDomainFilters(hit.url, filters));
}

function buildDomainQuery(query: string, domainFilter?: string[]): string {
	const { allowed, blocked } = normalizeDomainFilters(domainFilter);
	const parts = [query];
	if (allowed.length === 1) parts.push(`site:${allowed[0]}`);
	else if (allowed.length > 1) parts.push(`(${allowed.map((domain) => `site:${domain}`).join(" OR ")})`);
	parts.push(...blocked.map((domain) => `-site:${domain}`));
	return parts.join(" ");
}

function buildExaQuery(query: string, options: SearchOptions): string {
	const queryWithDomains = buildDomainQuery(query, options.domainFilter);
	if (!options.recencyFilter) return queryWithDomains;
	return `${queryWithDomains} ${options.recencyFilter === "day" ? "past 24 hours" : `past ${options.recencyFilter}`}`;
}

function normalizeDomain(value: string): string | null {
	let input = value.trim().toLowerCase();
	if (!input) return null;
	try {
		const parsed = input.includes("://") ? new URL(input) : new URL(`https://${input}`);
		input = parsed.hostname;
	} catch {
		input = input.split("/")[0]?.split(":")[0] ?? "";
	}
	input = input.replace(/^\.+|\.+$/g, "");
	return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(input) ? input : null;
}

function hostMatches(hostname: string, domain: string): boolean {
	return hostname === domain || hostname.endsWith(`.${domain}`);
}

function isTimeout(err: unknown): boolean {
	return err instanceof Error && err.name === "TimeoutError";
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message || err.name : String(err) || "Unknown error";
}
