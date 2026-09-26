import { DDG_SEARCH_URL, USER_AGENT } from "../constants.ts";
import { parseDdgHtml } from "../html.ts";
import type { QueryResult } from "../types.ts";
import { applyDomainFilter, buildDomainQuery } from "./filters.ts";
import { hitsToAnswer, normalizeCount, requestSearchText, type SearchOptions } from "./shared.ts";

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
