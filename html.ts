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
	const dataLines = body.split("\n").filter((line) => line.startsWith("data:"));
	let payloadText = "";
	for (const line of dataLines) {
		const payload = line.slice(5).trim();
		if (!payload) continue;
		try {
			const parsed = JSON.parse(payload) as {
				error?: { message?: string };
				result?: { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
			};
			if (parsed.error) throw new Error(parsed.error.message || "Exa MCP error");
			if (parsed.result?.isError) {
				const message = parsed.result.content?.find((item) => item.type === "text")?.text?.trim();
				throw new Error(message || "Exa MCP returned an error");
			}
			const text = parsed.result?.content?.find((item) => item.type === "text" && item.text?.trim())?.text;
			if (text) {
				payloadText = text;
				break;
			}
		} catch (err) {
			if (err instanceof SyntaxError) continue;
			throw err;
		}
	}

	if (!payloadText) {
		try {
			const parsed = JSON.parse(body) as {
				error?: { message?: string };
				result?: { content?: Array<{ type?: string; text?: string }> };
			};
			if (parsed.error) throw new Error(parsed.error.message || "Exa MCP error");
			payloadText = parsed.result?.content?.find((item) => item.type === "text")?.text ?? "";
		} catch (err) {
			if (!(err instanceof SyntaxError)) throw err;
		}
	}
	if (!payloadText) throw new Error("Exa MCP returned empty content");

	try {
		const json = JSON.parse(payloadText) as {
			results?: Array<{ title?: string; url?: string; text?: string; highlights?: unknown }>;
		};
		if (Array.isArray(json.results) && json.results.length > 0) {
			return json.results
				.filter((result) => typeof result.url === "string" && result.url.length > 0)
				.map((result) => ({
					title: result.title?.trim() || result.url || "",
					url: result.url as string,
					snippet: snippetFromExa(result.text, result.highlights),
				}));
		}
	} catch {
		// formatted text block
	}

	const blocks = payloadText.split(/(?=^Title: )/m).filter((block) => block.trim().length > 0);
	const hits: SearchHit[] = [];
	for (const block of blocks) {
		const title = block.match(/^Title: (.+)/m)?.[1]?.trim() ?? "";
		const url = block.match(/^URL: (.+)/m)?.[1]?.trim() ?? "";
		if (!url) continue;
		let snippet = "";
		const textStart = block.indexOf("\nText: ");
		if (textStart >= 0) snippet = block.slice(textStart + 7).replace(/\n---\s*$/, "").trim();
		hits.push({ title: title || url, url, snippet: snippet.replace(/\s+/g, " ").trim().slice(0, 500) });
	}
	if (hits.length === 0) throw new Error("Exa MCP returned no parseable results");
	return hits;
}

function snippetFromExa(text: unknown, highlights: unknown): string {
	if (typeof text === "string" && text.trim()) return text.replace(/\s+/g, " ").trim().slice(0, 500);
	if (Array.isArray(highlights)) {
		const parts = highlights.filter((item): item is string => typeof item === "string");
		if (parts.length > 0) return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 500);
	}
	return "";
}
