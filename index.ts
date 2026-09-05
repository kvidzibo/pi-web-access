import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createCache, findPassages, formatRecordForModel, selectStoredText, sliceText } from "./cache.ts";
import { MAX_DOMAIN_FILTERS, MAX_INLINE_CHARS, MAX_QUERIES, MAX_QUERY_CHARS, MAX_URLS, MAX_URL_CHARS } from "./constants.ts";
import { fetchPages, normalizeMode, normalizeUrls } from "./fetch.ts";
import { normalizeCount, normalizeProvider, normalizeQueries, normalizeRecency, searchQueries } from "./search.ts";
import type { FindMode } from "./types.ts";

const cache = createCache(join(homedir(), ".pi", "agent", "web-access-cache"));

export default function webAccess(pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web via keyless Exa MCP, with DuckDuckGo HTML fallback. Returns cited snippets. No curator UI. provider auto|exa|duckduckgo only.",
		promptSnippet: "Use web_search for current facts. Prefer queries[] with 2-4 varied angles. Omit provider unless overriding.",
		promptGuidelines: [
			"Use web_search for current facts. Prefer queries[] with 2-4 varied angles over one query.",
			"After web_search, use get_search_content with the returned responseId to page stored hits or fetched pages.",
		],
		parameters: Type.Object({
			query: Type.Optional(Type.String({ maxLength: MAX_QUERY_CHARS, description: "Single search query. For research, prefer queries[]." })),
			queries: Type.Optional(Type.Array(Type.String({ maxLength: MAX_QUERY_CHARS }), { maxItems: MAX_QUERIES, description: "Multiple queries searched in sequence." })),
			numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Results per query (default 5, max 20)" })),
			includeContent: Type.Optional(Type.Boolean({ description: "Also fetch readable content for result URLs" })),
			recencyFilter: Type.Optional(Type.String({ description: "day, week, month, or year" })),
			domainFilter: Type.Optional(Type.Array(Type.String({ maxLength: 253 }), { maxItems: MAX_DOMAIN_FILTERS, description: "Limit to domains; prefix with - to exclude" })),
			provider: Type.Optional(Type.String({ description: "auto (default), exa, or duckduckgo" })),
		}),
		async execute(_id, params, signal, onUpdate) {
			try {
				const queries = normalizeQueries(params.query, params.queries);
				if (queries.length === 0) fail("No query provided. Use query or queries.");
				const provider = normalizeProvider(params.provider);
				const recencyFilter = normalizeRecency(params.recencyFilter);
				onUpdate?.({ content: [{ type: "text", text: `Searching ${queries.length} quer${queries.length === 1 ? "y" : "ies"} via ${provider}...` }] });
				const results = await searchQueries(queries, provider, {
					numResults: normalizeCount(params.numResults),
					recencyFilter,
					domainFilter: Array.isArray(params.domainFilter) ? params.domainFilter.filter((item): item is string => typeof item === "string") : undefined,
					signal,
				});
				const pages = params.includeContent === true
					? await fetchPages(
						uniqueUrls(results.flatMap((result) => result.hits.map((hit) => hit.url))).slice(0, MAX_URLS),
						{ signal },
					)
					: [];
				signal?.throwIfAborted();
				const record = cache.store({ kind: "search", queries: results, pages });
				const failed = results.every((result) => result.error !== undefined && result.hits.length === 0);
				if (failed) fail(formatRecordForModel(record));
				return {
					content: [{ type: "text" as const, text: formatRecordForModel(record) }],
					details: { responseId: record.id, queries: results, pageCount: pages.length },
				};
			} catch (err) {
				fail(err);
			}
		},
	});

	pi.registerTool({
		name: "fetch_content",
		label: "Fetch Content",
		description:
			"Fetch HTTP(S) URL(s) from this machine and extract readable markdown. mode raw returns the textual body. Local SSRF gate blocks private/loopback/link-local/special-use IPs and pins DNS to the connecting socket. No GitHub clone, video, PDF, or hosted scrapers.",
		promptSnippet: "Use fetch_content to read a page as markdown. Use mode raw for exact textual HTTP bodies.",
		promptGuidelines: [
			"Use fetch_content to read public HTTP(S) pages. Do not use it for localhost or private IPs.",
			"After fetch_content, use get_search_content with responseId to page or search the stored full text.",
		],
		parameters: Type.Object({
			url: Type.Optional(Type.String({ maxLength: MAX_URL_CHARS, description: "Single URL to fetch" })),
			urls: Type.Optional(Type.Array(Type.String({ maxLength: MAX_URL_CHARS }), { maxItems: MAX_URLS, description: "Multiple URLs (parallel)" })),
			mode: Type.Optional(Type.String({ description: "readable (default) or raw." })),
		}),
		async execute(_id, params, signal, onUpdate) {
			try {
				const urls = normalizeUrls(params.url, params.urls);
				if (urls.length === 0) fail("No URL provided.");
				const mode = normalizeMode(params.mode);
				onUpdate?.({ content: [{ type: "text", text: `Fetching ${urls.length} URL(s)...` }] });
				const pages = await fetchPages(urls, { mode, signal });
				signal?.throwIfAborted();
				const record = cache.store({ kind: "fetch", queries: [], pages });
				const failed = pages.every((page) => page.error !== undefined);
				if (failed) fail(formatRecordForModel(record));
				return {
					content: [{ type: "text" as const, text: formatRecordForModel(record) }],
					details: { responseId: record.id, pages: pages.map((page) => ({ url: page.url, finalUrl: page.finalUrl, error: page.error, chars: page.content.length })) },
				};
			} catch (err) {
				fail(err);
			}
		},
	});

	pi.registerTool({
		name: "get_search_content",
		label: "Get Search Content",
		description: "Retrieve stored content from a previous web_search or fetch_content call via responseId. Cache dir ~/.pi/agent/web-access-cache; entries expire after 1 hour and are pruned on extension load and on store/get.",
		promptSnippet: "Use get_search_content after web_search or fetch_content to page or findText in stored content.",
		promptGuidelines: [
			"Use get_search_content with a responseId from web_search or fetch_content. Use findText to locate passages. Do not combine findText with offset or limit.",
		],
		parameters: Type.Object({
			responseId: Type.String({ description: "The responseId from web_search or fetch_content" }),
			query: Type.Optional(Type.String({ description: "Get content for this query" })),
			queryIndex: Type.Optional(Type.Integer({ minimum: 0, description: "Get content for query at index" })),
			url: Type.Optional(Type.String({ description: "Get content for this URL" })),
			urlIndex: Type.Optional(Type.Integer({ minimum: 0, description: "Get content for URL at index" })),
			offset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset (default 0). Not with findText." })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_INLINE_CHARS, description: `Max characters to return (default and max ${MAX_INLINE_CHARS}). Not with findText.` })),
			findText: Type.Optional(Type.Union([
				Type.String({ minLength: 1, maxLength: 500 }),
				Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 10 }),
			], { description: "Text or texts to find. Cannot combine with offset or limit." })),
			findMode: Type.Optional(Type.String({ description: "exact, case-insensitive (default), or fuzzy. Requires findText." })),
		}),
		async execute(_id, params) {
			try {
				if (params.findText !== undefined && (params.offset !== undefined || params.limit !== undefined)) {
					fail("findText cannot be combined with offset or limit.");
				}
				if (params.findMode !== undefined && params.findText === undefined) {
					fail("findMode requires findText.");
				}
				const record = cache.get(String(params.responseId));
				if (!record) fail(`No stored results for responseId ${params.responseId}.`);
				const selected = selectStoredText(record, {
					query: optionalString(params.query),
					queryIndex: optionalInt(params.queryIndex),
					url: optionalString(params.url),
					urlIndex: optionalInt(params.urlIndex),
				});
				if (params.findText !== undefined) {
					const needles = Array.isArray(params.findText) ? params.findText : [params.findText];
					const mode = normalizeFindMode(params.findMode);
					return {
						content: [{ type: "text" as const, text: findPassages(selected.text, needles.filter((item): item is string => typeof item === "string"), mode) }],
						details: { responseId: record.id, label: selected.label, findMode: mode },
					};
				}
				const sliced = sliceText(selected.text, optionalInt(params.offset) ?? 0, optionalInt(params.limit) ?? MAX_INLINE_CHARS);
				return {
					content: [{ type: "text" as const, text: sliced.text }],
					details: { responseId: record.id, label: selected.label, ...sliced },
				};
			} catch (err) {
				fail(err);
			}
		},
	});
}

// Pi marks execute() failures through rejected promises, not an isError field
// on a returned value. Preserve useful errors and normalize non-Error throws.
function fail(error: unknown): never {
	if (error instanceof Error && error.message) throw error;
	throw new Error(error instanceof Error ? error.name : String(error) || "Unknown error");
}

function uniqueUrls(urls: string[]): string[] {
	const out: string[] = [];
	for (const url of urls) {
		if (!out.includes(url)) out.push(url);
	}
	return out;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function optionalInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function normalizeFindMode(value: unknown): FindMode {
	if (value === undefined || value === null || value === "case-insensitive") return "case-insensitive";
	if (value === "exact" || value === "fuzzy") return value;
	throw new Error(`Invalid findMode ${JSON.stringify(value)}`);
}
