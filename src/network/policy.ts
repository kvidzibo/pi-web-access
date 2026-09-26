import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";

export type LookupAddress = { address: string; family: number };
export type Lookup = (hostname: string) => Promise<LookupAddress[]>;

const METADATA_HOSTS = new Set(["metadata.google.internal", "metadata.internal", "metadata"]);

export function normalizeHostname(hostname: string): string {
	return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

export function looksLikeNonCanonicalIp(hostname: string): boolean {
	return /^(?:\d+|0x[0-9a-f]+)(?:\.(?:\d+|0x[0-9a-f]+)){0,3}$/i.test(hostname);
}

function ipv4ToInt(parts: number[]): number {
	return ((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3];
}

function inCidr(ip: number, baseParts: number[], bits: number): boolean {
	const base = ipv4ToInt(baseParts);
	const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
	return (ip & mask) === (base & mask);
}

export function isBlockedIPv4(address: string): boolean {
	const parts = address.split(".").map((part) => Number(part));
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
	const ip = ipv4ToInt(parts);
	return inCidr(ip, [0, 0, 0, 0], 8) ||
		inCidr(ip, [10, 0, 0, 0], 8) ||
		inCidr(ip, [100, 64, 0, 0], 10) ||
		inCidr(ip, [127, 0, 0, 0], 8) ||
		inCidr(ip, [169, 254, 0, 0], 16) ||
		inCidr(ip, [172, 16, 0, 0], 12) ||
		inCidr(ip, [192, 0, 0, 0], 24) ||
		inCidr(ip, [192, 0, 2, 0], 24) ||
		inCidr(ip, [192, 88, 99, 0], 24) ||
		inCidr(ip, [192, 168, 0, 0], 16) ||
		inCidr(ip, [198, 18, 0, 0], 15) ||
		inCidr(ip, [198, 51, 100, 0], 24) ||
		inCidr(ip, [203, 0, 113, 0], 24) ||
		inCidr(ip, [224, 0, 0, 0], 4) ||
		inCidr(ip, [240, 0, 0, 0], 4);
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

function ipv4FromGroups(hi: number, lo: number): string {
	return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".");
}

export function isBlockedIPv6(address: string): boolean {
	const groups = parseIPv6(address);
	if (!groups) return true;
	if (groups.every((group) => group === 0)) return true;
	if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true;
	if ((groups[0] & 0xfe00) === 0xfc00) return true;
	if ((groups[0] & 0xffc0) === 0xfe80) return true;
	if ((groups[0] & 0xffc0) === 0xfec0) return true;
	if ((groups[0] & 0xff00) === 0xff00) return true;
	if (groups[0] === 0x2001 && groups[1] === 0xdb8) return true;
	if (groups[0] === 0x2001 && groups[1] === 0x2 && groups[2] === 0) return true;
	if (groups[0] === 0x2001 && groups[1] === 0) return true;
	if (groups[0] === 0x100 && groups[1] === 0) return true;
	if (groups[0] === 0x3fff && (groups[1] & 0xf000) === 0) return true;
	if (groups[0] === 0x5f00) return true;
	if (groups[0] === 0x64 && groups[1] === 0xff9b) return true;
	const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
	if (mapped) return isBlockedIPv4(ipv4FromGroups(groups[6], groups[7]));
	const translatable = groups.slice(0, 4).every((group) => group === 0) && groups[4] === 0xffff && groups[5] === 0;
	if (translatable) return true;
	if (groups.slice(0, 6).every((group) => group === 0)) return isBlockedIPv4(ipv4FromGroups(groups[6], groups[7]));
	if (groups[0] === 0x2002) return isBlockedIPv4(ipv4FromGroups(groups[1], groups[2]));
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
	signal?: AbortSignal | null;
};

export async function validateRemoteUrl(rawUrl: string | URL, options: ValidateOptions = {}): Promise<URL> {
	const { url } = await resolvePinnedTarget(rawUrl, options);
	return url;
}

export async function resolvePinnedTarget(rawUrl: string | URL, options: ValidateOptions = {}): Promise<{
	url: URL;
	address: LookupAddress;
}> {
	options.signal?.throwIfAborted();
	let url: URL;
	try {
		url = new URL(rawUrl);
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

	const family = net.isIP(hostname);
	if (family) {
		if (isBlockedAddress(hostname)) throw new Error(`Blocked internal address: ${hostname}`);
		return { url, address: { address: hostname, family } };
	}

	let addresses: LookupAddress[];
	try {
		addresses = await withAbort(
			() => (options.lookup ?? ((host: string) => dnsLookup(host, { all: true, verbatim: true })))(hostname),
			options.signal,
		);
	} catch (err) {
		options.signal?.throwIfAborted();
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to resolve ${hostname}: ${message}`);
	}
	if (addresses.length === 0) throw new Error(`Failed to resolve ${hostname}: no addresses returned`);
	for (const { address } of addresses) {
		if (isBlockedAddress(address)) throw new Error(`Blocked internal address for ${hostname}: ${address}`);
	}
	return { url, address: addresses[0] };
}

async function withAbort<T>(operation: () => Promise<T>, signal?: AbortSignal | null): Promise<T> {
	signal?.throwIfAborted();
	if (!signal) return operation();
	let onAbort!: () => void;
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([
			Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }),
			aborted,
		]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}
