import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchPage, fetchPages, normalizeMode, normalizeUrls, readTextLimited } from "../fetch.ts";

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

test("cancels body when content-length exceeds max", async () => {
	let cancelled = false;
	const body = new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode("0123456789"));
		},
		cancel() {
			cancelled = true;
		},
	});
	const page = await fetchPage("https://example.com/big", {
		lookup: publicLookup,
		maxBytes: 8,
		fetch: async () => new Response(body, {
			status: 200,
			headers: { "content-type": "text/plain", "content-length": "100" },
		}),
	});
	assert.match(page.error ?? "", /too large/);
	assert.equal(cancelled, true);
});

test("caller cancellation rejects fetchPage and fetchPages instead of returning page errors", async () => {
	const controller = new AbortController();
	const reason = new Error("user canceled");
	let markStarted!: () => void;
	const started = new Promise<void>((resolve) => { markStarted = resolve; });
	const page = fetchPage("https://example.com/", {
		signal: controller.signal,
		lookup: () => { markStarted(); return new Promise(() => {}); },
	});
	const rejected = assert.rejects(page, (err) => err === reason);
	await started;
	controller.abort(reason);
	await rejected;
	await assert.rejects(fetchPages(["https://example.com/", "https://other.example/"], { signal: controller.signal }), (err) => err === reason);
	await assert.rejects(fetchPages([], { signal: controller.signal }), (err) => err === reason);
	const racingController = new AbortController();
	let canceled = false;
	await assert.rejects(fetchPage("https://example.com/", {
		signal: racingController.signal, lookup: publicLookup,
		fetch: async () => {
			racingController.abort(reason);
			return new Response(new ReadableStream({ cancel() { canceled = true; } }));
		},
	}), (err) => err === reason);
	assert.equal(canceled, true);
});

test("transport errors with empty messages still produce a nonempty page error", async () => {
	const page = await fetchPage("https://example.com/", {
		lookup: publicLookup,
		fetch: async () => { throw new TypeError(""); },
	});
	assert.equal(page.error, "TypeError");
});

test("readTextLimited releases reader locks after success and failure", async () => {
	const ok = new Response("ok");
	assert.equal(await readTextLimited(ok, 10), "ok");
	assert.equal(ok.body?.locked, false);
	const oversized = new Response("too large");
	await assert.rejects(readTextLimited(oversized, 1), /too large/);
	assert.equal(oversized.body?.locked, false);
});

test("rejects pdf content type", async () => {
	const page = await fetchPage("https://example.com/doc.pdf", {
		lookup: publicLookup,
		fetch: async () => new Response("binary", { status: 200, headers: { "content-type": "application/pdf" } }),
	});
	assert.match(page.error ?? "", /Unsupported content type/);
});

test("cancels unused pdf body", async () => {
	let cancelled = false;
	const body = new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode("%PDF"));
		},
		cancel() {
			cancelled = true;
		},
	});
	const page = await fetchPage("https://example.com/doc.pdf", {
		lookup: publicLookup,
		fetch: async () => new Response(body, { status: 200, headers: { "content-type": "application/pdf" } }),
	});
	assert.match(page.error ?? "", /Unsupported content type/);
	assert.equal(cancelled, true);
});

