import http from "node:http";
import https from "node:https";
import net from "node:net";
import { addAbortSignal, pipeline, Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { normalizeHostname, type LookupAddress } from "./policy.ts";

export type PinnedFetch = (url: URL, address: LookupAddress, init: RequestInit) => Promise<Response>;

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

export function pinnedConnectOptions(url: URL, address: LookupAddress): https.RequestOptions {
	const isHttps = url.protocol === "https:";
	return {
		protocol: url.protocol,
		hostname: address.address,
		port: url.port ? Number(url.port) : isHttps ? 443 : 80,
		path: `${url.pathname}${url.search}`,
		family: address.family === 6 ? 6 : 4,
		servername: isHttps && !net.isIP(normalizeHostname(url.hostname)) ? normalizeHostname(url.hostname) : undefined,
		headers: { host: url.host },
	};
}

export async function cancelBody(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// already consumed or not cancelable
	}
}

function responseBody(res: http.IncomingMessage, headers: Headers, signal?: AbortSignal | null): ReadableStream<Uint8Array> {
	const encodings = (headers.get("content-encoding") ?? "").toLowerCase().split(",").map((item) => item.trim()).filter((item) => item && item !== "identity");
	if (encodings.length > 3) throw new Error("Too many content encodings (max 3)");
	// Validate before allocating streams, so unsupported encodings cannot leak decoders.
	for (const encoding of encodings) {
		if (!["gzip", "deflate", "br"].includes(encoding)) throw new Error(`Unsupported content encoding: ${encoding}`);
	}
	let stream: Readable = res;
	if (encodings.length > 0) {
		const decoders = encodings.reverse().map((encoding) => encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate() : createBrotliDecompress());
		stream = decoders[decoders.length - 1];
		// pipeline propagates errors/cancellation in both directions; toWeb exposes
		// decoder errors to the reader. Its callback consumes pipeline completion.
		pipeline([res, ...decoders], () => {});
		headers.delete("content-encoding");
		headers.delete("content-length");
	}
	if (signal) addAbortSignal(signal, stream);
	return Readable.toWeb(stream, {
		strategy: { highWaterMark: 64 * 1024, size: (chunk: Uint8Array) => chunk.byteLength },
	}) as ReadableStream<Uint8Array>;
}

export async function pinnedFetch(url: URL, address: LookupAddress, init: RequestInit = {}): Promise<Response> {
	init.signal?.throwIfAborted();
	const isHttps = url.protocol === "https:";
	const lib = isHttps ? https : http;
	const method = (init.method ?? "GET").toUpperCase();
	if (["CONNECT", "TRACE", "TRACK"].includes(method)) throw new Error(`Unsupported request method: ${method}`);
	const headers = new Headers(init.headers);
	headers.set("Host", url.host);
	if (!headers.has("accept-encoding")) headers.set("Accept-Encoding", "gzip, deflate, br");
	const outgoing: http.OutgoingHttpHeaders = {};
	headers.forEach((value, key) => {
		outgoing[key] = value;
	});
	const connect = pinnedConnectOptions(url, address);

	return new Promise((resolve, reject) => {
		const req = lib.request({
			...connect,
			method,
			headers: { ...connect.headers, ...outgoing },
			signal: init.signal ?? undefined,
		}, (res) => {
			// This callback runs after the Promise executor returns, so exceptions
			// must be rejected here rather than escaping as uncaughtException.
			try {
				const status = res.statusCode;
				if (status === undefined || !Number.isInteger(status) || status < 200 || status > 599) {
					throw new Error(`Unsupported HTTP status: ${status ?? "missing"}`);
				}
				const respHeaders = new Headers();
				for (const [key, value] of Object.entries(res.headersDistinct ?? res.headers)) {
					if (value === undefined) continue;
					const values = Array.isArray(value) ? value : [value];
					for (const item of values) {
						if (item !== undefined) respHeaders.append(key, item);
					}
				}
				const nullBody = method === "HEAD" || NULL_BODY_STATUSES.has(status);
				const response = new Response(nullBody ? null : responseBody(res, respHeaders, init.signal), {
					status,
					statusText: res.statusMessage ?? "",
					headers: respHeaders,
				});
				// No consumer will read these streams; do not drain unbounded data.
				if (nullBody) res.destroy();
				resolve(response);
			} catch (err) {
				res.destroy();
				req.destroy();
				reject(err);
			}
		});
		// Upgrades bypass the response callback and cannot be Fetch Responses.
		req.once("upgrade", (res, socket) => {
			socket.destroy();
			reject(new Error(`Unsupported HTTP upgrade (status ${res.statusCode ?? "missing"})`));
		});
		req.on("error", reject);
		const body = init.body;
		if (body == null) {
			req.end();
			return;
		}
		if (typeof body === "string" || body instanceof Uint8Array) {
			req.end(body);
			return;
		}
		req.destroy(new Error("Unsupported request body"));
	});
}
