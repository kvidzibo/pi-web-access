import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchPage, normalizeMode, normalizeUrls } from "../fetch.ts";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

test("normalizeUrls and mode", () => {
	assert.deepEqual(normalizeUrls("https://a.example", ["https://a.example", "https://b.example"]), [
		"https://a.example",
		"https://b.example",
	]);
	assert.equal(normalizeMode(undefined), "readable");
	assert.throws(() => normalizeMode("pdf"), /Invalid mode/);
});

test("readable extracts html", async () => {
	const html = `<!doctype html><html><head><title>Guide</title></head><body><article><h1>Guide</h1><p>Install widgets now.</p></article></body></html>`;
	const page = await fetchPage("https://example.com/guide", {
		lookup: publicLookup,
		fetch: async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
	});
	assert.equal(page.error, undefined);
	assert.match(page.content, /Install widgets/i);
	assert.match(page.title, /Guide/);
});

test("raw returns body unchanged", async () => {
	const page = await fetchPage("https://example.com/api", {
		mode: "raw",
		lookup: publicLookup,
		fetch: async () => new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }),
	});
	assert.equal(page.content, '{"ok":true}');
});

test("rejects private targets as page error", async () => {
	const page = await fetchPage("http://127.0.0.1/");
	assert.match(page.error ?? "", /internal address/);
});

test("rejects oversized body", async () => {
	const page = await fetchPage("https://example.com/big", {
		lookup: publicLookup,
		maxBytes: 8,
		fetch: async () => new Response("0123456789", { status: 200, headers: { "content-type": "text/plain" } }),
	});
	assert.match(page.error ?? "", /too large/);
});

test("rejects pdf content type", async () => {
	const page = await fetchPage("https://example.com/doc.pdf", {
		lookup: publicLookup,
		fetch: async () => new Response("binary", { status: 200, headers: { "content-type": "application/pdf" } }),
	});
	assert.match(page.error ?? "", /Unsupported content type/);
});

