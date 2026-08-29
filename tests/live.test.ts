import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchPage } from "../fetch.ts";
import { searchExa } from "../search.ts";

const live = process.env.WEB_ACCESS_LIVE === "1";

test("live Exa MCP search", { skip: !live }, async () => {
	const result = await searchExa("TypeScript handbook");
	assert.ok(result.hits.length > 0, result.error ?? "no hits");
	assert.match(result.hits[0].url, /^https?:\/\//);
});

test("live fetch example.com", { skip: !live }, async () => {
	const page = await fetchPage("https://example.com/");
	assert.equal(page.error, undefined, page.error);
	assert.match(page.content, /example/i);
});
