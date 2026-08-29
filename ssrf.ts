import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";
import { MAX_REDIRECTS } from "./constants.ts";

export type LookupAddress = { address: string; family: number };
export type Lookup = (hostname: string) => Promise<LookupAddress[]>;
type FetchImpl = typeof fetch;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const METADATA_HOSTS = new Set(["metadata.google.internal", "metadata.internal", "metadata"]);

export function normalizeHostname(hostname: string): string {
	return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

export function looksLikeNonCanonicalIp(hostname: string): boolean {
	return /^(?:\d+|0x[0-9a-f]+)(?:\.(?:\d+|0x[0-9a-f]+)){0,3}$/i.test(hostname);
}

export function isBlockedIPv4(address: string): boolean {
	const parts = address.split(".").map((part) => Number(part));
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
	const [a, b] = parts;
	return a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 198 && (b === 18 || b === 19)) ||
		a >= 224;
}

export function parseIPv6(address: string): number[] | null {
	let input = address;
	if (input.includes(".")) {
		const lastColon = input.lastIndexOf(":");
		const ipv4 = input.slice(lastColon + 1);
		if (net.isIP(ipv4) !== 4) return null;
		const octets = ipv4.split(".").map((part) => Number(part));
		input = `${input.slice(0, lastColon)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
	}

	const pieces = input.split("::");
	if (pieces.length > 2) return null;
	const left = pieces[0] ? pieces[0].split(":") : [];
	const right = pieces.length === 2 && pieces[1] ? pieces[1].split(":") : [];
	const missing = 8 - left.length - right.length;
	if (pieces.length === 1 && missing !== 0) return null;
	if (pieces.length === 2 && missing < 0) return null;

	const groups = [...left, ...Array(missing).fill("0"), ...right].map((part) => {
		if (!/^[0-9a-f]{1,4}$/i.test(part)) return -1;
		return parseInt(part, 16);
	});
	return groups.length === 8 && groups.every((group) => group >= 0 && group <= 0xffff) ? groups : null;
}

export function isBlockedIPv6(address: string): boolean {
	const groups = parseIPv6(address);
	if (!groups) return true;
	if (groups.every((group) => group === 0)) return true;
	if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true;
	if ((groups[0] & 0xfe00) === 0xfc00) return true;
	if ((groups[0] & 0xffc0) === 0xfe80) return true;
	const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
	if (mapped) {
		const ipv4 = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".");
		return isBlockedIPv4(ipv4);
	}
	return false;
}

export function isBlockedAddress(address: string): boolean {
	const normalized = normalizeHostname(address);
	const version = net.isIP(normalized);
	if (version === 4) return isBlockedIPv4(normalized);
	if (version === 6) return isBlockedIPv6(normalized);
	return true;
}

export type ValidateOptions = {
	lookup?: Lookup;
};

export async function validateRemoteUrl(rawUrl: string | URL, options: ValidateOptions = {}): Promise<URL> {
	let url: URL;
	try {
		url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
	} catch {
		throw new Error(`Invalid URL: ${String(rawUrl)}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Only HTTP and HTTPS URLs can be fetched");
	}
	if (url.username || url.password) {
		throw new Error("URLs with credentials are blocked");
	}

	const hostname = normalizeHostname(url.hostname);
	if (!hostname) throw new Error("URL must include a hostname");
	if (hostname === "localhost" || hostname.endsWith(".localhost") || METADATA_HOSTS.has(hostname)) {
		throw new Error(`Blocked internal hostname: ${hostname}`);
	}
	if (looksLikeNonCanonicalIp(hostname) && net.isIP(hostname) !== 4) {
		throw new Error(`Blocked non-canonical IP hostname: ${hostname}`);
	}
	if (net.isIP(hostname)) {
		if (isBlockedAddress(hostname)) throw new Error(`Blocked internal address: ${hostname}`);
		return url;
	}

	let addresses: LookupAddress[];
	try {
		addresses = await (options.lookup ?? ((host: string) => dnsLookup(host, { all: true, verbatim: true })))(hostname);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to resolve ${hostname}: ${message}`);
	}
	if (addresses.length === 0) throw new Error(`Failed to resolve ${hostname}: no addresses returned`);
	for (const { address } of addresses) {
		if (isBlockedAddress(address)) throw new Error(`Blocked internal address for ${hostname}: ${address}`);
	}
	return url;
}

export type FetchRemoteOptions = ValidateOptions & {
	fetch?: FetchImpl;
	maxRedirects?: number;
};

export async function fetchRemoteUrl(
	url: string | URL,
	init: RequestInit = {},
	options: FetchRemoteOptions = {},
): Promise<{ response: Response; finalUrl: URL }> {
	const fetchImpl = options.fetch ?? fetch;
	const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
	let current = await validateRemoteUrl(url, options);
	let requestInit = init;

	for (let redirects = 0; redirects <= maxRedirects; redirects++) {
		const response = await fetchImpl(current, { ...requestInit, redirect: "manual" });
		if (!REDIRECT_STATUSES.has(response.status)) return { response, finalUrl: current };

		const location = response.headers.get("location");
		if (!location) return { response, finalUrl: current };
		if (redirects === maxRedirects) throw new Error(`Too many redirects fetching ${current.toString()}`);

		current = await validateRemoteUrl(new URL(location, current), options);
		if (response.status === 303 || ((response.status === 301 || response.status === 302) && requestInit.method?.toUpperCase() === "POST")) {
			const { body: _body, ...nextInit } = requestInit;
			requestInit = { ...nextInit, method: "GET" };
		}
	}

	throw new Error(`Too many redirects fetching ${current.toString()}`);
}
