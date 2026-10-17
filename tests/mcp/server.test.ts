import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createCache } from "../../src/cache.ts";

test("stdio MCP exposes shared tools, validates calls, preserves errors and cached content", { timeout: 15000 }, async (t) => {
	const home = mkdtempSync(join(tmpdir(), "web-access-mcp-"));
	const cache = createCache(join(home, ".pi", "agent", "web-access-cache"));
	const record = cache.store({
		kind: "fetch", queries: [],
		pages: [{ url: "https://example.com/", finalUrl: "https://example.com/", title: "Example", content: "MCP cached passage", contentType: "text/plain" }],
	});
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [fileURLToPath(new URL("../../mcp/cli.mjs", import.meta.url))],
		env: { HOME: home },
		stderr: "pipe",
	});
	const client = new Client({ name: "web-access-test", version: "1.0.0" });
	let diagnostics = "";
	transport.stderr?.on("data", (chunk) => { diagnostics += chunk; });
	t.after(async () => {
		await client.close();
		rmSync(home, { recursive: true, force: true });
	});
	await client.connect(transport);
	const { tools } = await client.listTools();
	assert.deepEqual(tools.map((tool) => tool.name), ["web_search", "fetch_content", "get_search_content"]);
	assert.match(tools[0].description!, /Prefer queries/);
	assert.equal(tools[0].inputSchema.properties!.query.maxLength, 500);
	const result = await client.callTool({ name: "get_search_content", arguments: { responseId: record.id, findText: "cached" } });
	assert.notEqual(result.isError, true);
	assert.match(JSON.stringify(result.content), /MCP cached passage/);
	assert.equal(result.structuredContent?.responseId, record.id);
	for (const [name, args, expected] of [
		["web_search", {}, /No query provided/],
		["fetch_content", { urls: "wrong" }, /Invalid arguments/],
		["fetch_content", { url: "http://127.0.0.1/" }, /Blocked internal address/],
		["get_search_content", { responseId: "missing" }, /No stored results/],
	] as const) {
		const failed = await client.callTool({ name, arguments: args });
		assert.equal(failed.isError, true);
		assert.match(JSON.stringify(failed.content), expected);
	}
	await assert.rejects(client.callTool({ name: "unknown", arguments: {} }), /Unknown tool/);
	assert.doesNotMatch(diagnostics, /failed|Error:/);
});
