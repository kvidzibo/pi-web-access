import { DDG_SEARCH_URL, EXA_MCP_URL, SEARCH_TIMEOUT_MS, USER_AGENT } from "./constants.ts";
import { parseDdgHtml, parseExaMcpBody } from "./html.ts";
import type { QueryResult, RecencyFilter, SearchHit, SearchProvider } from "./types.ts";

export type SearchOptions = {
	numResults?: number;
	recencyFilter?: RecencyFilter;
	domainFilter?: string[];
	signal?: AbortSignal;
	fetch?: typeof fetch;
};

export function normalizeQueries(query?: unknown, queries?: unknown): string[] {
	const raw = Array.isArray(queries) ? queries : query !== undefined ? [query] : [];
	const out: string[] = [];
	for (const item of raw) {
		if (typeof item !== "string") continue;
		const trimmed = item.trim();
		if (trimmed && !out.includes(trimmed)) out.push(trimmed);
	}
	return out;
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
	for (const raw of domainFilter ?? []) {
		const blocked = raw.trim().startsWith("-");
		const domain = normalizeDomain(blocked ? raw.trim().slice(1) : raw);
		if (!domain) continue;
		const target = blocked ? filters.blocked : filters.allowed;
		if (!target.includes(domain)) target.push(domain);
	}
	return filters;
}

export function matchesDomainFilters(url: string, filters: { allowed: string[]; blocked: string[] }): boolean {
	if (filters.allowed.length === 0 && filters.blocked.length === 0) return true;
	let hostname: string;
	try {
		hostname = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (filters.allowed.length > 0 && !filters.allowed.some((domain) => hostMatches(hostname, domain))) return false;
	return !filters.blocked.some((domain) => hostMatches(hostname, domain));
}

export function hitsToAnswer(hits: SearchHit[]): string {
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
		results.push(await searchOne(query, provider, options));
	}
	return results;
}

async function searchOne(query: string, provider: SearchProvider, options: SearchOptions): Promise<QueryResult> {
	if (provider === "exa") return searchExa(query, options);
	if (provider === "duckduckgo") return searchDuckDuckGo(query, options);

	try {
		return await searchExa(query, options);
	} catch (err) {
		if (isAbort(err)) throw err;
		const exaError = err instanceof Error ? err.message : String(err);
		try {
			const fallback = await searchDuckDuckGo(query, options);
			fallback.answer = `${fallback.answer}\n\n[fallback: Exa failed: ${exaError}]`;
			return fallback;
		} catch (fallbackErr) {
			if (isAbort(fallbackErr)) throw fallbackErr;
			const ddgError = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
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
	const numResults = normalizeCount(options.numResults);
	const fetchImpl = options.fetch ?? fetch;
	const mcpQuery = buildExaQuery(query, options);
	const response = await fetchImpl(`${EXA_MCP_URL}?tools=web_search_exa`, {
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
		signal: withTimeout(options.signal, SEARCH_TIMEOUT_MS),
	});
	const body = await response.text();
	if (!response.ok) {
		if (response.status === 429) throw new Error(`Exa MCP rate limit (429): ${body.slice(0, 200)}`);
		throw new Error(`Exa MCP error ${response.status}: ${body.slice(0, 300)}`);
	}
	const hits = applyDomainFilter(parseExaMcpBody(body), options.domainFilter).slice(0, numResults);
	return { query, provider: "exa", answer: hitsToAnswer(hits), hits };
}

export async function searchDuckDuckGo(query: string, options: SearchOptions = {}): Promise<QueryResult> {
	const numResults = normalizeCount(options.numResults);
	const fetchImpl = options.fetch ?? fetch;
	const url = new URL(DDG_SEARCH_URL);
	url.searchParams.set("q", query);
	const response = await fetchImpl(url, {
		method: "GET",
		headers: {
			Accept: "text/html",
			"User-Agent": USER_AGENT,
		},
		signal: withTimeout(options.signal, SEARCH_TIMEOUT_MS),
	});
	const body = await response.text();
	if (!response.ok) throw new Error(`DuckDuckGo search error ${response.status}: ${body.slice(0, 300)}`);
	const parsed = parseDdgHtml(body);
	if (parsed.length === 0) throw new Error("DuckDuckGo returned no parseable results");
	const hits = applyDomainFilter(parsed, options.domainFilter).slice(0, numResults);
	return { query, provider: "duckduckgo", answer: hitsToAnswer(hits), hits };
}

function applyDomainFilter(hits: SearchHit[], domainFilter?: string[]): SearchHit[] {
	const filters = normalizeDomainFilters(domainFilter);
	return hits.filter((hit) => matchesDomainFilters(hit.url, filters));
}

function buildExaQuery(query: string, options: SearchOptions): string {
	const parts = [query];
	for (const raw of options.domainFilter ?? []) {
		const blocked = raw.trim().startsWith("-");
		const domain = normalizeDomain(blocked ? raw.trim().slice(1) : raw);
		if (!domain) continue;
		parts.push(blocked ? `-site:${domain}` : `site:${domain}`);
	}
	if (options.recencyFilter) {
		const now = new Date();
		if (options.recencyFilter === "day") parts.push("past 24 hours");
		else if (options.recencyFilter === "week") parts.push("past week");
		else if (options.recencyFilter === "month") parts.push(`${now.toLocaleString("en", { month: "long" })} ${now.getFullYear()}`);
		else parts.push(String(now.getFullYear()));
	}
	return parts.join(" ");
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

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function isAbort(err: unknown): boolean {
	return err instanceof Error && (err.name === "AbortError" || err.message.toLowerCase().includes("abort"));
}
