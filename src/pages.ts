import { CONCURRENT_FETCHES, FETCH_TIMEOUT_MS, MAX_FETCH_BYTES, MAX_URLS, MAX_URL_CHARS, USER_AGENT } from "./constants.ts";
import { htmlToReadable } from "./html.ts";
import { readTextLimited } from "./network/body.ts";
import { fetchRemoteUrl } from "./network/fetch.ts";
import type { Lookup } from "./network/policy.ts";
import { cancelBody } from "./network/transport.ts";
import type { FetchMode, PageResult } from "./types.ts";
import { normalizeList, withTimeout } from "./utils.ts";

const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|xhtml\+xml))/i;

export type FetchPageOptions = {
	mode?: FetchMode;
	signal?: AbortSignal;
	fetch?: typeof fetch;
	lookup?: Lookup;
	maxBytes?: number;
};

export function normalizeUrls(url?: unknown, urls?: unknown): string[] {
	return normalizeList(url, urls, "URL", MAX_URL_CHARS, MAX_URLS);
}

export function normalizeMode(value: unknown): FetchMode {
	if (value === undefined || value === null || value === "readable") return "readable";
	if (value === "raw") return value;
	throw new Error(`Invalid mode ${JSON.stringify(value)}. Use readable or raw.`);
}

export async function fetchPages(urls: string[], options: FetchPageOptions = {}): Promise<PageResult[]> {
	options.signal?.throwIfAborted();
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
		if (options.signal?.aborted) {
			await cancelBody(response);
			options.signal.throwIfAborted();
		}
		const contentType = response.headers.get("content-type") || "";
		const page: PageResult = { url, finalUrl: finalUrl.toString(), title: "", content: "", contentType };
		if (!response.ok) {
			await cancelBody(response);
			options.signal?.throwIfAborted();
			return { ...page, error: `HTTP ${response.status} ${response.statusText}`.trim() };
		}
		if (isBinaryType(contentType)) {
			await cancelBody(response);
			options.signal?.throwIfAborted();
			return { ...page, error: `Unsupported content type: ${contentType || "unknown"}` };
		}
		const text = await readTextLimited(response, options.maxBytes ?? MAX_FETCH_BYTES);
		options.signal?.throwIfAborted();
		if (mode === "raw" || !isHtml(contentType, text)) {
			return { ...page, content: text };
		}
		const readable = htmlToReadable(text, page.finalUrl);
		return { ...page, title: readable.title, content: readable.content };
	} catch (err) {
		options.signal?.throwIfAborted();
		return {
			url,
			finalUrl: url,
			title: "",
			content: "",
			contentType: "",
			error: err instanceof Error ? err.message || err.name : String(err) || "Unknown error",
		};
	}
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
