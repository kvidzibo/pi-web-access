import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCache, findPassages, isSafeId, selectStoredText, sliceText } from "../cache.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "web-access-cache-"));
}

test("store and get roundtrip", () => {
	const dir = tempDir();
	try {
		const cache = createCache(dir);
		const stored = cache.store({
			kind: "fetch",
			queries: [],
			pages: [{ url: "https://example.com", finalUrl: "https://example.com/", title: "Example", content: "hello world", contentType: "text/html" }],
		});
		assert.equal(isSafeId(stored.id), true);
		const loaded = cache.get(stored.id);
		assert.equal(loaded?.pages[0]?.content, "hello world");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("expired entries disappear", () => {
	const dir = tempDir();
	try {
		const cache = createCache(dir, { ttlMs: 1 });
		const stored = cache.store({ kind: "fetch", queries: [], pages: [] });
		const wait = Date.now() + 5;
		while (Date.now() < wait) {
			// spin
		}
		assert.equal(cache.get(stored.id), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("evicts oldest when over maxEntries", () => {
	const dir = tempDir();
	try {
		const cache = createCache(dir, { maxEntries: 2, ttlMs: 60_000 });
		const a = cache.store({ kind: "fetch", queries: [], pages: [] });
		const b = cache.store({ kind: "fetch", queries: [], pages: [] });
		const c = cache.store({ kind: "fetch", queries: [], pages: [] });
		assert.equal(cache.get(a.id), undefined);
		assert.ok(cache.get(b.id));
		assert.ok(cache.get(c.id));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("slice and find helpers", () => {
	const text = "Hello Installation Guide and retry timeout";
	const sliced = sliceText(text, 6, 12);
	assert.equal(sliced.text, "Installation");
	assert.equal(sliced.nextOffset, 18);
	assert.match(findPassages(text, ["installation"], "case-insensitive"), /Installation/);
	assert.match(findPassages(text, ["INSTALLATION"], "exact"), /No matches/);
	assert.match(findPassages(text, ["retry timeout"], "fuzzy"), /retry timeout/);
	const spaced = "Hello\n\tretry\t\ttimeout now";
	const fuzzy = findPassages(spaced, ["retry timeout"], "fuzzy");
	assert.match(fuzzy, /retry/);
	assert.match(fuzzy, /@\d+/);
	assert.doesNotMatch(fuzzy, /@0:/);
});

test("prunes expired files on create", () => {
	const dir = tempDir();
	try {
		const first = createCache(dir, { ttlMs: 1 });
		const stored = first.store({ kind: "fetch", queries: [], pages: [] });
		const wait = Date.now() + 5;
		while (Date.now() < wait) {
			// spin
		}
		createCache(dir, { ttlMs: 1 });
		assert.equal(existsSync(join(dir, `${stored.id}.json`)), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("evicts when over maxBytes", () => {
	const dir = tempDir();
	try {
		const cache = createCache(dir, { maxBytes: 400, maxEntries: 50, ttlMs: 60_000 });
		const a = cache.store({
			kind: "fetch",
			queries: [],
			pages: [{ url: "https://a.example", finalUrl: "https://a.example/", title: "A", content: "x".repeat(200), contentType: "text/plain" }],
		});
		cache.store({
			kind: "fetch",
			queries: [],
			pages: [{ url: "https://b.example", finalUrl: "https://b.example/", title: "B", content: "y".repeat(200), contentType: "text/plain" }],
		});
		assert.equal(cache.get(a.id), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cache dir 0700 and files 0600", () => {
	const dir = tempDir();
	try {
		const cache = createCache(dir);
		const stored = cache.store({ kind: "fetch", queries: [], pages: [] });
		assert.equal(statSync(dir).mode & 0o777, 0o700);
		assert.equal(statSync(join(dir, `${stored.id}.json`)).mode & 0o777, 0o600);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("selectStoredText lists when many pages", () => {
	const selected = selectStoredText({
		id: "11111111-1111-4111-8111-111111111111",
		createdAt: 1,
		kind: "fetch",
		queries: [],
		pages: [
			{ url: "https://a.example", finalUrl: "https://a.example/", title: "A", content: "aaa", contentType: "text/html" },
			{ url: "https://b.example", finalUrl: "https://b.example/", title: "B", content: "bbb", contentType: "text/html" },
		],
	}, {});
	assert.match(selected.text, /urlIndex/);
	const page = selectStoredText({
		id: "11111111-1111-4111-8111-111111111111",
		createdAt: 1,
		kind: "fetch",
		queries: [],
		pages: [
			{ url: "https://a.example", finalUrl: "https://a.example/", title: "A", content: "aaa", contentType: "text/html" },
			{ url: "https://b.example", finalUrl: "https://b.example/", title: "B", content: "bbb", contentType: "text/html" },
		],
	}, { urlIndex: 1 });
	assert.equal(page.text, "bbb");
});

test("rejects unsafe ids", () => {
	assert.equal(isSafeId("../etc/passwd"), false);
	assert.equal(isSafeId("not-a-uuid"), false);
});
