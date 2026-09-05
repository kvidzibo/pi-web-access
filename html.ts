import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { DDG_SEARCH_URL } from "./constants.ts";
import type { SearchHit } from "./types.ts";

const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
	bulletListMarker: "-",
});

export function htmlToReadable(html: string, url: string): { title: string; content: string } {
	const { document } = parseHTML(html);
	let base = url;
	try { base = new URL(document.querySelector("base[href]")?.getAttribute("href") ?? url, url).href; }
	catch { /* An invalid document base falls back to the final fetched URL. */ }
	for (const [selector, attribute] of [["a[href],area[href]", "href"], ["img[src],source[src]", "src"]]) {
		for (const element of document.querySelectorAll(selector)) {
			const value = element.getAttribute(attribute);
			if (!value || value.startsWith("#")) continue;
			try { element.setAttribute(attribute, new URL(value, base).href); }
			catch { /* Preserve non-resolvable links as text, never fetch them here. */ }
		}
	}
	let article: { title?: string | null; content?: string | null } | null = null;
	try {
		article = new Readability(document as unknown as Document, { charThreshold: 80 }).parse();
	} catch {
		article = null;
	}
	const title = article?.title?.trim() || document.querySelector("title")?.textContent?.trim() || url;
	const contentHtml = article?.content || document.body?.innerHTML || html;
	const content = turndown.turndown(contentHtml).trim();
	return { title, content };
}

export function decodeDdgUrl(href: string): string | null {
	try {
		const link = new URL(href, DDG_SEARCH_URL);
		const destination = link.searchParams.get("uddg") ?? link.href;
		const url = new URL(destination);
		return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
	} catch {
		return null;
	}
}

export function parseDdgHtml(html: string): SearchHit[] {
	const { document } = parseHTML(html);
	const hits: SearchHit[] = [];
	for (const container of document.querySelectorAll(".result")) {
		if (container.classList.contains("result--ad")) continue;
		const anchor = container.querySelector(".result__a");
		const title = anchor?.textContent?.trim() ?? "";
		const href = anchor?.getAttribute("href")?.trim() ?? "";
		const url = href ? decodeDdgUrl(href) : null;
		if (!title || !url) continue;
		const snippet = container.querySelector(".result__snippet")?.textContent?.trim() ?? "";
		hits.push({ title, url, snippet });
	}
	return hits;
}

export function parseExaMcpBody(body: string): SearchHit[] {
	// SSE joins all data fields in an event with newlines, including pretty JSON.
	const events = body.replace(/\r\n?/g, "\n").split("\n\n").map((event) => event.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).replace(/^ /, "")).join("\n")).filter(Boolean);
	let sawContent = false;
	for (const payload of events.length > 0 ? events : [body]) {
		let parsed: {
			error?: { message?: string };
			result?: { isError?: boolean; content?: Array<{ type?: string; text?: string } | null> };
		};
		try { parsed = JSON.parse(payload); } catch { continue; }
		if (!parsed || typeof parsed !== "object") continue;
		if (parsed.error) throw new Error(parsed.error.message || "Exa MCP error");
		const result = parsed.result;
		const texts = Array.isArray(result?.content) ? result.content
			.filter((item) => item?.type === "text" && typeof item.text === "string")
			.map((item) => item!.text!.trim()).filter(Boolean) : [];
		if (result?.isError) throw new Error(texts.join("\n") || "Exa MCP returned an error");
		if (texts.length === 0) continue;
		sawContent = true;
		const parsedBlocks = texts.map(parseExaText).filter((hits): hits is SearchHit[] => hits !== undefined);
		if (parsedBlocks.length > 0) return parsedBlocks.flat();
	}
	throw new Error(sawContent ? "Exa MCP returned no parseable results" : "Exa MCP returned empty content");
}

function parseExaText(payloadText: string): SearchHit[] | undefined {
	try {
		const json = JSON.parse(payloadText) as {
			results?: Array<{ title?: unknown; url?: unknown; text?: unknown; highlights?: unknown } | null>;
		};
		if (Array.isArray(json?.results)) {
			return json.results.flatMap((result) => {
				const url = httpUrl(result?.url);
				return url ? [{
					title: typeof result?.title === "string" ? result.title.trim() || url : url,
					url,
					snippet: snippetFromExa(result?.text, result?.highlights),
				}] : [];
			});
		}
	} catch {
		// Exa also returns formatted text instead of a JSON results array.
	}
	const blocks = payloadText.split(/(?=^Title: )/m).filter((block) => block.trim().length > 0);
	const hits: SearchHit[] = [];
	for (const block of blocks) {
		const title = block.match(/^Title: (.+)/m)?.[1]?.trim() ?? "";
		const url = httpUrl(block.match(/^URL: (.+)/m)?.[1]);
		if (!url) continue;
		let snippet = "";
		const textStart = block.indexOf("\nText: ");
		if (textStart >= 0) snippet = block.slice(textStart + 7).replace(/\n---\s*$/, "").trim();
		hits.push({ title: title || url, url, snippet: snippet.replace(/\s+/g, " ").trim().slice(0, 500) });
	}
	return hits.length > 0 ? hits : undefined;
}

function httpUrl(value: unknown): string | null {
	if (typeof value !== "string") return null;
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? value.trim() : null;
	} catch {
		return null;
	}
}

function snippetFromExa(text: unknown, highlights: unknown): string {
	if (typeof text === "string" && text.trim()) return text.replace(/\s+/g, " ").trim().slice(0, 500);
	if (Array.isArray(highlights)) {
		const parts = highlights.filter((item): item is string => typeof item === "string");
		if (parts.length > 0) return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 500);
	}
	return "";
}
