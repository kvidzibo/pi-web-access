import assert from "node:assert/strict";
import dns, { lookup as dnsLookup } from "node:dns/promises";
import { EventEmitter } from "node:events";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { Readable } from "node:stream";
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
	assert.deepEqual(normalizeQueries(undefined, ["a", "b", "c", "d", "e"]), ["a", "b", "c", "d"]);
	assert.throws(() => normalizeQueries("x".repeat(501)), /too long/);
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

test("DuckDuckGo requests include recency and OR-combined domain filters", async () => {
	const result = await searchDuckDuckGo("widgets", {
		recencyFilter: "week", domainFilter: ["docs.example", "news.example", "-ads.example"],
		fetch: async (input) => {
			const url = new URL(String(input));
			assert.equal(url.searchParams.get("df"), "w");
			assert.equal(url.searchParams.get("q"), "widgets (site:docs.example OR site:news.example) -site:ads.example");
			return new Response('<div class="result"><a class="result__a" href="https://docs.example/">Docs</a></div>');
		},
	});
	assert.equal(result.hits.length, 1);
});

test("explicit-provider batches preserve successful queries after a failure", async () => {
	let calls = 0;
	const results = await searchQueries(["first", "second"], "exa", {
		fetch: async () => ++calls === 1 ? new Response("failed", { status: 503 }) : new Response(JSON.stringify({
			result: { content: [{ type: "text", text: "Title: Good\nURL: https://good.example\nText: Found" }] },
		})),
	});
	assert.equal(results.length, 2);
	assert.match(results[0].error ?? "", /503/);
	assert.equal(results[1].hits.length, 1);
});

for (const phase of ["DNS", "HTTP", "body"]) {
	test(`${phase} provider timeouts end only that query without fallback`, async (t) => {
		const timers: ReturnType<typeof setTimeout>[] = [];
		t.after(() => timers.forEach(clearTimeout));
		t.mock.method(AbortSignal, "timeout", () => {
			const controller = new AbortController();
			timers.push(setTimeout(() => controller.abort(new DOMException("provider deadline", "TimeoutError")), 10));
			return controller.signal;
		});
		let calls = 0;
		const urls: string[] = [];
		const results = await searchQueries(["slow", "healthy"], "auto", {
			fetch: async (input, init) => {
				urls.push(String(input));
				assert.match(String(input), /mcp\.exa\.ai/, "timeouts must not trigger DuckDuckGo fallback");
				if (++calls > 1) return new Response(JSON.stringify({ result: { content: [{ type: "text", text: "Title: Good\nURL: https://good.example" }] } }));
				const signal = init!.signal!;
				const failure = () => phase === "DNS" ? signal.reason : Object.assign(new Error("transport aborted"), { name: "AbortError", cause: signal.reason });
				if (phase === "body") return new Response(new ReadableStream({
					start(controller) { signal.addEventListener("abort", () => controller.error(failure()), { once: true }); },
				}));
				return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(failure()), { once: true }));
			},
		});
		assert.equal(calls, 2);
		assert.equal(urls.length, 2);
		assert.ok(urls.every((url) => url.includes("mcp.exa.ai")));
		assert.equal(results.length, 2);
		assert.match(results[0].error ?? "", /provider deadline/);
		assert.equal(results[1].hits.length, 1);
	});
}

test("custom abort reasons stop auto fallback and subsequent queries", async () => {
	const controller = new AbortController();
	const reason = new Error("stop now");
	let calls = 0;
	await assert.rejects(searchQueries(["first", "second"], "auto", {
		signal: controller.signal,
		fetch: async () => { calls++; controller.abort(reason); throw reason; },
	}), (err) => err === reason);
	assert.equal(calls, 1);
});

test("domain matching normalizes trailing dots and rejects non-HTTP URLs", () => {
	assert.equal(matchesDomainFilters("https://blocked.example./", normalizeDomainFilters(["-blocked.example"])), false);
	assert.equal(matchesDomainFilters("javascript:alert(1)", normalizeDomainFilters([])), false);
});

test("empty filtered results have an explicit answer", async () => {
	const result = await searchDuckDuckGo("widgets", {
		domainFilter: ["docs.example"],
		fetch: async () => new Response('<div class="result"><a class="result__a" href="https://other.example/">Other</a></div>'),
	});
	assert.equal(result.hits.length, 0);
	assert.match(result.answer, /No results/);
});

test("default search transports pin DNS and block private redirect targets", async (t) => {
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	const lookup = t.mock.method(dns, "lookup", async () => [{ address: "8.8.8.8", family: 4 }]);
	syncBuiltinESMExports();
	assert.equal(dnsLookup, lookup);
	t.mock.method(globalThis, "fetch", async () => { throw new Error("Unpinned fetch must not run"); });
	let requests = 0;
	t.mock.method(https, "request", (options, callback) => {
		requests++;
		assert.equal(options.hostname, "8.8.8.8");
		const request = Object.assign(new EventEmitter(), {
			end() {
				queueMicrotask(() => callback(Object.assign(Readable.from([]), {
					statusCode: 302, statusMessage: "Found", headers: { location: "http://127.0.0.1/private" },
				})));
			},
			destroy() { return request; },
		});
		return request;
	});
	for (const search of [searchExa, searchDuckDuckGo]) {
		await assert.rejects(search("widgets"), /Blocked internal address/);
	}
	assert.equal(requests, 2);
});

test("searchDuckDuckGo errors when no results", async () => {
	await assert.rejects(
		() => searchDuckDuckGo("nothing", { fetch: async () => new Response("<html></html>", { status: 200 }) }),
		/no parseable results/,
	);
});
