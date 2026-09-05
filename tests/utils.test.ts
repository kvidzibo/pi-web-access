import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeList, withTimeout } from "../utils.ts";
import { readTextLimited } from "../fetch.ts";

test("normalization preserves array precedence, order, cap and error wording", () => {
	assert.deepEqual(normalizeList("ignored", [" b ", null, "", "b", "a", "too long"], "Query", 3, 2), ["b", "a"]);
	assert.deepEqual(normalizeList("single", [], "URL", 10, 2), []);
	assert.deepEqual(normalizeList(" a ", undefined, "URL", 10, 2), ["a"]);
	assert.deepEqual(normalizeList(undefined, undefined, "URL", 10, 2), []);
	assert.throws(() => normalizeList("long", undefined, "URL", 3, 2), /URL too long \(max 3 characters\)/);
	assert.throws(() => normalizeList("long", undefined, "Query", 3, 2), /Query too long \(max 3 characters\)/);
});

test("deadline composition preserves caller reason", () => {
	const controller = new AbortController();
	const signal = withTimeout(controller.signal, 10000);
	const reason = new Error("caller cancellation");
	controller.abort(reason);
	assert.equal(signal.reason, reason);
	assert.equal(withTimeout(undefined, 10000).aborted, false);
});

test("null-body responses remain empty but declared size limits still apply", async () => {
	assert.equal(await readTextLimited(new Response(null, { status: 204 }), 10), "");
	await assert.rejects(readTextLimited(new Response(null, { headers: { "content-length": "11" } }), 10), /too large/);
});
