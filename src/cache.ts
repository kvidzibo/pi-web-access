import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE_MAX_BYTES, CACHE_MAX_ENTRIES, CACHE_TTL_MS, FIND_MAX_CHARS, MAX_INLINE_CHARS } from "./constants.ts";
import type { FindMode, PageResult, QueryResult, StoredRecord } from "./types.ts";

export type CacheLimits = {
	ttlMs: number;
	maxEntries: number;
	maxBytes: number;
};

const DEFAULT_LIMITS: CacheLimits = {
	ttlMs: CACHE_TTL_MS,
	maxEntries: CACHE_MAX_ENTRIES,
	maxBytes: CACHE_MAX_BYTES,
};

export function createCache(dir: string, limits: Partial<CacheLimits> = {}) {
	const resolved = { ...DEFAULT_LIMITS, ...limits };
	ensureDir(dir);

	function store(partial: Omit<StoredRecord, "id" | "createdAt"> & { id?: string; createdAt?: number }): StoredRecord {
		ensureDir(dir);
		prune();
		const record: StoredRecord = {
			id: partial.id ?? randomUUID(),
			createdAt: partial.createdAt ?? Date.now(),
			kind: partial.kind,
			queries: partial.queries,
			pages: partial.pages,
		};
		const path = fileFor(record.id);
		const body = JSON.stringify(record);
		writeFileSync(path, body, { encoding: "utf8", mode: 0o600 });
		chmodSync(path, 0o600);
		prune();
		return record;
	}

	function get(id: string): StoredRecord | undefined {
		prune();
		if (!isSafeId(id)) return undefined;
		const path = fileFor(id);
		let raw: string;
		try {
			raw = readFileSync(path, "utf8");
		} catch {
			return undefined;
		}
		try {
			const parsed = JSON.parse(raw) as StoredRecord;
			if (!parsed || typeof parsed !== "object" || parsed.id !== id) return undefined;
			if (Date.now() - parsed.createdAt > resolved.ttlMs) {
				rmSync(path, { force: true });
				return undefined;
			}
			return parsed;
		} catch {
			return undefined;
		}
	}

	function prune(): void {
		const entries = listEntries().sort((a, b) => a.createdAt - b.createdAt);
		const now = Date.now();
		let bytes = 0;
		const keep: typeof entries = [];
		for (const entry of entries) {
			if (now - entry.createdAt > resolved.ttlMs) {
				rmSync(entry.path, { force: true });
				continue;
			}
			keep.push(entry);
			bytes += entry.bytes;
		}
		while (keep.length > resolved.maxEntries || bytes > resolved.maxBytes) {
			const oldest = keep.shift();
			if (!oldest) break;
			rmSync(oldest.path, { force: true });
			bytes -= oldest.bytes;
		}
	}

	function fileFor(id: string): string {
		if (!isSafeId(id)) throw new Error(`Invalid cache id: ${id}`);
		return join(dir, `${id}.json`);
	}

	prune();

	function listEntries(): Array<{ id: string; path: string; createdAt: number; bytes: number }> {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			return [];
		}
		const out: Array<{ id: string; path: string; createdAt: number; bytes: number }> = [];
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const id = name.slice(0, -5);
			if (!isSafeId(id)) continue;
			const path = join(dir, name);
			try {
				const stat = statSync(path);
				out.push({ id, path, createdAt: stat.mtimeMs, bytes: stat.size });
			} catch {
				// skip unreadable
			}
		}
		return out;
	}

	return { dir, store, get, prune };
}

export function isSafeId(id: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

export function sliceText(text: string, offset = 0, limit = MAX_INLINE_CHARS): {
	text: string;
	offset: number;
	limit: number;
	contentLength: number;
	nextOffset: number | null;
	truncated: boolean;
} {
	if (!Number.isInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer");
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_INLINE_CHARS) {
		throw new Error(`limit must be an integer from 1 to ${MAX_INLINE_CHARS}`);
	}
	if (offset > text.length) throw new Error(`offset ${offset} is out of range (0-${text.length})`);
	const end = Math.min(offset + limit, text.length);
	return {
		text: text.slice(offset, end),
		offset,
		limit,
		contentLength: text.length,
		nextOffset: end < text.length ? end : null,
		truncated: end < text.length,
	};
}

export function findPassages(text: string, needles: string[], mode: FindMode = "case-insensitive"): string {
	const matches: string[] = [];
	let remaining = FIND_MAX_CHARS;
	for (const needle of needles) {
		if (!needle) continue;
		const found = locate(text, needle, mode);
		if (found.length === 0) {
			const line = `No matches for ${JSON.stringify(needle)}`;
			if (line.length <= remaining) {
				matches.push(line);
				remaining -= line.length;
			}
			continue;
		}
		for (const hit of found) {
			const line = `match ${JSON.stringify(needle)} @${hit.index}: ${hit.context}`;
			if (line.length > remaining) {
				matches.push("… find output truncated");
				remaining = 0;
				break;
			}
			matches.push(line);
			remaining -= line.length + 1;
		}
		if (remaining <= 0) break;
	}
	return matches.join("\n") || "No matches";
}

export function selectStoredText(record: StoredRecord, options: {
	query?: string;
	queryIndex?: number;
	url?: string;
	urlIndex?: number;
}): { label: string; text: string } {
	if (options.url !== undefined || options.urlIndex !== undefined) {
		const page = pickPage(record.pages, options.url, options.urlIndex);
		return { label: page.finalUrl || page.url, text: page.content || page.error || "" };
	}
	if (options.query !== undefined || options.queryIndex !== undefined) {
		const query = pickQuery(record.queries, options.query, options.queryIndex);
		return { label: query.query, text: formatQuery(query) };
	}
	if (record.pages.length === 1) {
		const page = record.pages[0];
		return { label: page.finalUrl || page.url, text: page.content || page.error || "" };
	}
	const listing = [
		`kind: ${record.kind}`,
		`queries (${record.queries.length}):`,
		...record.queries.map((query, index) => `  [${index}] ${query.query} (${query.hits.length} hits${query.error ? `; error: ${query.error}` : ""})`),
		`pages (${record.pages.length}):`,
		...record.pages.map((page, index) => `  [${index}] ${page.finalUrl || page.url}${page.error ? ` error=${page.error}` : ` chars=${page.content.length}`}`),
		"Pass urlIndex or queryIndex to get_search_content.",
	].join("\n");
	return { label: record.id, text: listing };
}

export function formatQuery(query: QueryResult): string {
	const lines = [`# ${query.query}`, `provider: ${query.provider}`];
	if (query.error) lines.push(`error: ${query.error}`);
	if (query.answer) lines.push("", query.answer);
	if (query.hits.length > 0) {
		lines.push("", "Sources:");
		for (const [index, hit] of query.hits.entries()) {
			lines.push(`${index + 1}. ${hit.title} — ${hit.url}`);
			if (hit.snippet) lines.push(`   ${hit.snippet}`);
		}
	}
	return lines.join("\n");
}

export function formatRecordForModel(record: StoredRecord, inlineLimit = MAX_INLINE_CHARS): string {
	const parts: string[] = [`responseId: ${record.id}`];
	for (const query of record.queries) parts.push(formatQuery(query));
	for (const page of record.pages) {
		const body = page.error || page.content;
		parts.push(`# ${page.title || page.url}\nURL: ${page.finalUrl || page.url}\n\n${body}`);
	}
	const joined = parts.join("\n\n");
	if (joined.length <= inlineLimit) return joined;
	const marker = `\n\n[truncated; get_search_content responseId=${record.id}]`;
	return `${joined.slice(0, inlineLimit)}${marker}`;
}

function pickPage(pages: PageResult[], url?: string, urlIndex?: number): PageResult {
	if (urlIndex !== undefined) {
		if (!Number.isInteger(urlIndex) || urlIndex < 0 || urlIndex >= pages.length) {
			throw new Error(`urlIndex ${urlIndex} is out of range (0-${Math.max(pages.length - 1, 0)})`);
		}
		return pages[urlIndex];
	}
	const match = pages.find((page) => page.url === url || page.finalUrl === url);
	if (!match) throw new Error(`No stored page for url ${url}`);
	return match;
}

function pickQuery(queries: QueryResult[], query?: string, queryIndex?: number): QueryResult {
	if (queryIndex !== undefined) {
		if (!Number.isInteger(queryIndex) || queryIndex < 0 || queryIndex >= queries.length) {
			throw new Error(`queryIndex ${queryIndex} is out of range (0-${Math.max(queries.length - 1, 0)})`);
		}
		return queries[queryIndex];
	}
	const match = queries.find((item) => item.query === query);
	if (!match) throw new Error(`No stored query ${JSON.stringify(query)}`);
	return match;
}

function locate(text: string, needle: string, mode: FindMode): Array<{ index: number; context: string }> {
	const hits: Array<{ index: number; context: string }> = [];
	const folded = mode === "exact" ? text : text.toLowerCase();
	// Default Unicode lowercasing can expand a code point (İ -> i + combining dot).
	// Lowercase the whole string to retain contextual mappings such as Greek sigma.
	const foldMap: number[] = [];
	if (folded.length !== text.length) {
		let offset = 0;
		for (const char of text) {
			for (let j = 0; j < char.toLowerCase().length; j++) foldMap.push(offset + Math.min(j, char.length - 1));
			offset += char.length;
		}
	}
	const normalized = mode === "fuzzy" ? collapseWithMap(folded) : undefined;
	const hay = normalized?.text ?? folded;
	const find = mode === "fuzzy" ? collapse(needle.toLowerCase()) : mode === "exact" ? needle : needle.toLowerCase();
	let from = 0;
	while (from < hay.length) {
		const index = hay.indexOf(find, from);
		if (index < 0) break;
		const start = normalized?.map[index] ?? index;
		const end = normalized?.map[index + find.length - 1] ?? index + find.length - 1;
		const originalIndex = foldMap[start] ?? start;
		const originalEnd = foldMap[end] ?? end;
		hits.push({ index: originalIndex, context: contextAround(text, originalIndex, originalEnd - originalIndex + 1) });
		from = index + Math.max(find.length, 1);
		if (hits.length >= 20) break;
	}
	return hits;
}

function collapse(value: string): string {
	return collapseWithMap(value).text;
}

function collapseWithMap(value: string): { text: string; map: number[] } {
	const chars: string[] = [];
	const map: number[] = [];
	let prevSpace = false;
	for (let i = 0; i < value.length; i++) {
		const space = /\s/.test(value[i]);
		if (space) {
			if (!prevSpace && chars.length > 0) {
				chars.push(" ");
				map.push(i);
			}
			prevSpace = true;
			continue;
		}
		chars.push(value[i]);
		map.push(i);
		prevSpace = false;
	}
	return { text: chars.join(""), map };
}

function contextAround(text: string, index: number, length: number): string {
	const start = Math.max(0, index - 80);
	const end = Math.min(text.length, index + length + 80);
	return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "…" : ""}`;
}

function ensureDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
}
