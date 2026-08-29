import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeDdgUrl, htmlToReadable, parseDdgHtml, parseExaMcpBody } from "../html.ts";

test("htmlToReadable extracts article", () => {
	const html = `<!doctype html><html><head><title>Ignore</title></head><body>
	<nav>nav junk</nav>
	<article><h1>Real Title</h1><p>This is the main article content about widgets.</p></article>
	</body></html>`;
	const result = htmlToReadable(html, "https://example.com/widgets");
	assert.match(result.content, /widgets/i);
	assert.ok(result.title.length > 0);
});

test("decodeDdgUrl unwraps uddg", () => {
	const href = "/l/?uddg=https%3A%2F%2Fdocs.example.com%2Fguide";
	assert.equal(decodeDdgUrl(href), "https://docs.example.com/guide");
});

test("parseDdgHtml skips ads and keeps results", () => {
	const html = `<div class="result result--ad"><a class="result__a" href="https://ad.example">Ad</a></div>
	<div class="result"><a class="result__a" href="/l/?uddg=https%3A%2F%2Fgood.example%2Fpage">Good Title</a>
	<a class="result__snippet">A useful snippet</a></div>`;
	const hits = parseDdgHtml(html);
	assert.equal(hits.length, 1);
	assert.equal(hits[0].title, "Good Title");
	assert.equal(hits[0].url, "https://good.example/page");
});

test("parseExaMcpBody reads SSE text blocks", () => {
	const body = [
		"event: message",
		`data: {"result":{"content":[{"type":"text","text":"Title: One\\nURL: https://one.example\\nText: hello there\\n---\\nTitle: Two\\nURL: https://two.example\\nText: second"}]}}`,
		"",
	].join("\n");
	const hits = parseExaMcpBody(body);
	assert.equal(hits.length, 2);
	assert.equal(hits[0].url, "https://one.example");
	assert.match(hits[0].snippet, /hello/);
});

test("parseExaMcpBody reads JSON results", () => {
	const payload = JSON.stringify({
		results: [{ title: "Docs", url: "https://docs.example", text: "Install the package" }],
	});
	const body = `data: ${JSON.stringify({ result: { content: [{ type: "text", text: payload }] } })}`;
	const hits = parseExaMcpBody(body);
	assert.equal(hits[0].title, "Docs");
	assert.match(hits[0].snippet, /Install/);
});

test("parseExaMcpBody surfaces RPC errors", () => {
	assert.throws(() => parseExaMcpBody(`data: {"error":{"message":"nope"}}`), /nope/);
});
