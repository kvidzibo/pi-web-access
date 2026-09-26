import { EXA_MCP_URL } from "../constants.ts";
import { parseExaMcpBody } from "../html.ts";
import type { QueryResult } from "../types.ts";
import { applyDomainFilter, buildDomainQuery } from "./filters.ts";
import { hitsToAnswer, normalizeCount, requestSearchText, type SearchOptions } from "./shared.ts";

export async function searchExa(query: string, options: SearchOptions = {}): Promise<QueryResult> {
	options.signal?.throwIfAborted();
	const numResults = normalizeCount(options.numResults);
	const queryWithDomains = buildDomainQuery(query, options.domainFilter);
	const mcpQuery = options.recencyFilter
		? `${queryWithDomains} ${options.recencyFilter === "day" ? "past 24 hours" : `past ${options.recencyFilter}`}`
		: queryWithDomains;
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
