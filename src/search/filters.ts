import { MAX_DOMAIN_FILTERS } from "../constants.ts";
import type { SearchHit } from "../types.ts";

export function normalizeDomainFilters(domainFilter: string[] | undefined): { allowed: string[]; blocked: string[] } {
	const filters = { allowed: [] as string[], blocked: [] as string[] };
	let count = 0;
	for (const raw of domainFilter ?? []) {
		if (count >= MAX_DOMAIN_FILTERS) break;
		const blocked = raw.trim().startsWith("-");
		const domain = normalizeDomain(blocked ? raw.trim().slice(1) : raw);
		if (!domain) continue;
		const target = blocked ? filters.blocked : filters.allowed;
		if (!target.includes(domain)) {
			target.push(domain);
			count += 1;
		}
	}
	return filters;
}

export function matchesDomainFilters(url: string, filters: { allowed: string[]; blocked: string[] }): boolean {
	let hostname: string;
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
		hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
	} catch {
		return false;
	}
	if (filters.allowed.length > 0 && !filters.allowed.some((domain) => hostMatches(hostname, domain))) return false;
	return !filters.blocked.some((domain) => hostMatches(hostname, domain));
}

export function applyDomainFilter(hits: SearchHit[], domainFilter?: string[]): SearchHit[] {
	const filters = normalizeDomainFilters(domainFilter);
	return hits.filter((hit) => matchesDomainFilters(hit.url, filters));
}

export function buildDomainQuery(query: string, domainFilter?: string[]): string {
	const { allowed, blocked } = normalizeDomainFilters(domainFilter);
	const parts = [query];
	if (allowed.length === 1) parts.push(`site:${allowed[0]}`);
	else if (allowed.length > 1) parts.push(`(${allowed.map((domain) => `site:${domain}`).join(" OR ")})`);
	parts.push(...blocked.map((domain) => `-site:${domain}`));
	return parts.join(" ");
}

function normalizeDomain(value: string): string | null {
	let input = value.trim().toLowerCase();
	if (!input) return null;
	try {
		const parsed = input.includes("://") ? new URL(input) : new URL(`https://${input}`);
		input = parsed.hostname;
	} catch {
		input = input.split("/")[0]?.split(":")[0] ?? "";
	}
	input = input.replace(/^\.+|\.+$/g, "");
	return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(input) ? input : null;
}

function hostMatches(hostname: string, domain: string): boolean {
	return hostname === domain || hostname.endsWith(`.${domain}`);
}
