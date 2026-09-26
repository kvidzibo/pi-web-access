import { MAX_REDIRECTS } from "../constants.ts";
import { resolvePinnedTarget, type LookupAddress, type ValidateOptions } from "./policy.ts";
import { cancelBody, pinnedFetch, type PinnedFetch } from "./transport.ts";

type FetchImpl = typeof fetch;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type FetchRemoteOptions = ValidateOptions & {
	fetch?: FetchImpl;
	pinnedFetch?: PinnedFetch;
	maxRedirects?: number;
};

export async function fetchRemoteUrl(
	url: string | URL,
	init: RequestInit = {},
	options: FetchRemoteOptions = {},
): Promise<{ response: Response; finalUrl: URL; address: LookupAddress }> {
	const fetchImpl = options.fetch;
	const pin = options.pinnedFetch ?? pinnedFetch;
	const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
	const signal = init.signal ?? options.signal;
	const validateOptions = { ...options, signal };
	let current = await resolvePinnedTarget(url, validateOptions);
	let requestInit = { ...init, signal };

	for (let redirects = 0; redirects <= maxRedirects; redirects++) {
		signal?.throwIfAborted();
		const response = fetchImpl
			? await fetchImpl(current.url, { ...requestInit, redirect: "manual" })
			: await pin(current.url, current.address, { ...requestInit, redirect: "manual" });
		if (!REDIRECT_STATUSES.has(response.status)) return { response, finalUrl: current.url, address: current.address };

		const location = response.headers.get("location");
		if (!location) return { response, finalUrl: current.url, address: current.address };
		if (redirects === maxRedirects) {
			await cancelBody(response);
			throw new Error(`Too many redirects fetching ${current.url.toString()}`);
		}

		await cancelBody(response);
		const next = await resolvePinnedTarget(new URL(location, current.url), validateOptions);
		const headers = new Headers(requestInit.headers);
		headers.delete("host");
		if (next.url.origin !== current.url.origin) {
			for (const name of ["authorization", "proxy-authorization", "cookie", "cookie2"]) headers.delete(name);
		}
		const method = (requestInit.method ?? "GET").toUpperCase();
		if ((response.status === 303 && method !== "GET" && method !== "HEAD") ||
			((response.status === 301 || response.status === 302) && method === "POST")) {
			const { body: _body, ...nextInit } = requestInit;
			requestInit = { ...nextInit, method: "GET" };
			for (const name of ["content-length", "content-type", "content-encoding", "content-language", "content-location", "transfer-encoding"]) headers.delete(name);
		}
		requestInit = { ...requestInit, headers };
		current = next;
	}

	throw new Error(`Too many redirects fetching ${current.url.toString()}`);
}
