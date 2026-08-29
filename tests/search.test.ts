import assert from "node:assert/strict";
import { test } from "node:test";
import {
	hitsToAnswer,
	matchesDomainFilters,
	normalizeCount,
	normalizeDomainFilters,
	normalizeProvider,
	normalizeQueries,
	searchDuckDuckGo,
	searchExa,
	searchQueries,
} from "../search.ts";

test("normalizeQueries drops blanks and dupes", () => {
	assert.deepEqual(normalizeQueries("  rust  ", ["rust", "", "go"]), ["rust", "go"]);
	assert.deepEqual(normalizeQueries(undefined, undefined), []);
});

test("normalizeProvider and count", () => {
	assert.equal(normalizeProvider(undefined), "auto");
	assert.equal(normalizeProvider("duckduckgo"), "duckduckgo");
	assert.throws(() => normalizeProvider("brave"), /Unsupported provider/);
	assert.equal(normalizeCount(99), 20);
	assert.equal(normalizeCount(-1), 1);
});

test("domain filters allow and deny", () => {
	const filters = normalizeDomainFilters(["github.com", "-gist.github.com"]);
	assert.equal(matchesDomainFilters("https://github.com/foo", filters), true);
	assert.equal(matchesDomainFilters("https://gist.github.com/foo", filters), false);
	assert.equal(matchesDomainFilters("https://example.com", filters), false);
});

test("searchExa uses MCP and parses SSE", async () => {
	const payload = [
		"data: {\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"Title: Rust\\nURL: https://doc.rust-lang.org\\nText: The book\"}]}}",
	].join("\n");
	const result = await searchExa("rust book", {
		fetch: async (input) => {
			assert.match(String(input), /mcp.exa.ai/);
			return new Response(payload, { status: 200 });
		},
	});
	assert.equal(result.provider, "exa");
	assert.equal(result.hits[0].url, "https://doc.rust-lang.org");
	assert.match(hitsToAnswer(result.hits), /The book/);
});

test("auto falls back to DuckDuckGo on Exa 429", async () => {
	const ddg = `<div class="result"><a class="result__a" href="/l/?uddg=https%3A%2F%2Ffallback.example">Fallback</a>
	<a class="result__snippet">from ddg</a></div>`;
	let exaCalls = 0;
	const results = await searchQueries(["widgets"], "auto", {
		fetch: async (input) => {
			const url = String(input);
			if (url.includes("mcp.exa.ai")) {
				exaCalls += 1;
				return new Response("rate", { status: 429 });
			}
			return new Response(ddg, { status: 200 });
		},
	});
	assert.equal(exaCalls, 1);
	assert.equal(results[0].provider, "duckduckgo");
	assert.equal(results[0].hits[0].url, "https://fallback.example/");
	assert.match(results[0].answer, /Exa failed/);
});

test("searchDuckDuckGo errors when no results", async () => {
	await assert.rejects(
		() => searchDuckDuckGo("nothing", { fetch: async () => new Response("<html></html>", { status: 200 }) }),
		/no parseable results/,
	);
});
