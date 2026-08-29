import { CONCURRENT_FETCHES, FETCH_TIMEOUT_MS, MAX_FETCH_BYTES, USER_AGENT } from "./constants.ts";
import { htmlToReadable } from "./html.ts";
import { fetchRemoteUrl, type Lookup } from "./ssrf.ts";
import type { FetchMode, PageResult } from "./types.ts";

const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|xhtml\+xml))/i;

export type FetchPageOptions = {
	mode?: FetchMode;
	signal?: AbortSignal;
	fetch?: typeof fetch;
	lookup?: Lookup;
	maxBytes?: number;
};

export function normalizeUrls(url?: unknown, urls?: unknown): string[] {
	const raw = Array.isArray(urls) ? urls : url !== undefined ? [url] : [];
	const out: string[] = [];
	for (const item of raw) {
		if (typeof item !== "string") continue;
		const trimmed = item.trim();
		if (trimmed && !out.includes(trimmed)) out.push(trimmed);
	}
	return out;
}

export function normalizeMode(value: unknown): FetchMode {
	if (value === undefined || value === null || value === "readable") return "readable";
	if (value === "raw") return value;
	throw new Error(`Invalid mode ${JSON.stringify(value)}. Use readable or raw.`);
}

export async function fetchPages(urls: string[], options: FetchPageOptions = {}): Promise<PageResult[]> {
	return mapPool(urls, CONCURRENT_FETCHES, (url) => fetchPage(url, options));
}

export async function fetchPage(url: string, options: FetchPageOptions = {}): Promise<PageResult> {
	const mode = options.mode ?? "readable";
	try {
		const { response, finalUrl } = await fetchRemoteUrl(url, {
			method: "GET",
			headers: {
				Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
				"User-Agent": USER_AGENT,
			},
			signal: withTimeout(options.signal, FETCH_TIMEOUT_MS),
		}, {
			fetch: options.fetch,
			lookup: options.lookup,
		});
		const contentType = response.headers.get("content-type") || "";
		if (!response.ok) {
			return {
				url,
				finalUrl: finalUrl.toString(),
				title: "",
				content: "",
				contentType,
				error: `HTTP ${response.status} ${response.statusText}`.trim(),
			};
		}
		if (isBinaryType(contentType)) {
			return {
				url,
				finalUrl: finalUrl.toString(),
				title: "",
				content: "",
				contentType,
				error: `Unsupported content type: ${contentType || "unknown"}`,
			};
		}
		const text = await readTextLimited(response, options.maxBytes ?? MAX_FETCH_BYTES);
		if (mode === "raw" || !isHtml(contentType, text)) {
			return {
				url,
				finalUrl: finalUrl.toString(),
				title: "",
				content: text,
				contentType,
			};
		}
		const readable = htmlToReadable(text, finalUrl.toString());
		return {
			url,
			finalUrl: finalUrl.toString(),
			title: readable.title,
			content: readable.content,
			contentType,
		};
	} catch (err) {
		return {
			url,
			finalUrl: url,
			title: "",
			content: "",
			contentType: "",
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

export async function readTextLimited(response: Response, maxBytes: number): Promise<string> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) {
		throw new Error(`Response too large (${declared} bytes)`);
	}
	if (!response.body) {
		const buffer = Buffer.from(await response.arrayBuffer());
		if (buffer.length > maxBytes) throw new Error(`Response too large (${buffer.length} bytes)`);
		return buffer.toString("utf8");
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		size += value.byteLength;
		if (size > maxBytes) {
			await reader.cancel();
			throw new Error(`Response too large (>${maxBytes} bytes)`);
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function isBinaryType(contentType: string): boolean {
	const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
	if (!type) return false;
	if (TEXT_TYPES.test(type)) return false;
	if (type === "application/octet-stream") return true;
	return type.startsWith("image/") || type.startsWith("audio/") || type.startsWith("video/") || type === "application/pdf";
}

function isHtml(contentType: string, body: string): boolean {
	const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
	if (type.includes("html")) return true;
	if (type && !type.startsWith("text/")) return false;
	return /<html[\s>]|<body[\s>]|<article[\s>]/i.test(body.slice(0, 4096));
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function mapPool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	async function worker() {
		while (next < items.length) {
			const index = next;
			next += 1;
			out[index] = await fn(items[index]);
		}
	}
	await Promise.all(Array.from({ length: Math.min(n, items.length) || 0 }, () => worker()));
	return out;
}
