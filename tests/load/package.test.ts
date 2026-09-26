import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const MANIFEST = join(REPO, "package.json");

type LoadResult = {
	errors: Array<{ path: string; error: string }>;
	extensions: Array<{
		path: string;
		tools: Map<string, { definition: { execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown> } }>;
		handlers: Map<string, unknown>;
	}>;
};

function resolvePiLoader(): string {
	const piBin = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
	const dir = dirname(piBin);
	const candidates = [
		join(dir, "core", "extensions", "loader.js"),
		join(dir, "..", "core", "extensions", "loader.js"),
	];
	const loader = candidates.find((path) => existsSync(path));
	if (!loader) throw new Error(`Pi extension loader not found from ${piBin}`);
	return loader;
}

async function loadWithPi(paths: string[]): Promise<LoadResult> {
	const { loadExtensions } = await import(pathToFileURL(resolvePiLoader()).href);
	return loadExtensions(paths, REPO);
}

test("package manifest factory-loads web-access tools and signals errors by throwing", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "web-access-load-"));
	const previousHome = process.env.HOME;
	process.env.HOME = home;
	t.after(() => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		rmSync(home, { recursive: true, force: true });
	});
	const pkg = JSON.parse(readFileSync(MANIFEST, "utf8")) as { pi?: { extensions?: string[] } };
	assert.deepEqual(pkg.pi?.extensions, ["./index.ts"]);
	const paths = (pkg.pi?.extensions ?? []).map((rel) => join(REPO, rel));
	const result = await loadWithPi(paths);
	assert.deepEqual(
		result.errors,
		[],
		result.errors.map((item) => `${item.path}: ${item.error}`).join("\n"),
	);
	assert.equal(result.extensions.length, 1);
	const tools = result.extensions[0].tools;
	assert.deepEqual([...tools.keys()], ["web_search", "fetch_content", "get_search_content"]);
	await assert.rejects(tools.get("web_search")!.definition.execute("test", {}), /No query provided/);
	await assert.rejects(tools.get("fetch_content")!.definition.execute("test", {}), /No URL provided/);
	await assert.rejects(tools.get("fetch_content")!.definition.execute("test", { url: "http://127.0.0.1/" }), /Blocked internal address/);
	await assert.rejects(tools.get("get_search_content")!.definition.execute("test", { responseId: "missing" }), /No stored results/);
	const cacheDir = join(home, ".pi", "agent", "web-access-cache");
	const before = readdirSync(cacheDir);
	const controller = new AbortController();
	const reason = new Error("user canceled");
	controller.abort(reason);
	await assert.rejects(tools.get("fetch_content")!.definition.execute("test", { url: "https://example.com/" }, controller.signal), (err) => err === reason);
	assert.deepEqual(readdirSync(cacheDir), before, "cancellation must not create a cache record");
});
