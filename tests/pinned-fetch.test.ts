import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import { test, type TestContext } from "node:test";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { fetchPage, readTextLimited } from "../fetch.ts";
import { pinnedFetch } from "../ssrf.ts";
import { MAX_FETCH_BYTES } from "../constants.ts";

// Exercise the real HTTP callback without external network access. Only this
// transport fixture connects to loopback; URL validation remains unchanged.
async function serveResponse(t: TestContext, wireResponse: string | Uint8Array, end = false) {
	const sockets = new Set<net.Socket>();
	let onClose!: () => void;
	const closed = new Promise<void>((resolve) => { onClose = resolve; });
	let onRequest!: (request: string) => void;
	const received = new Promise<string>((resolve) => { onRequest = resolve; });
	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.on("error", () => {}); // The client may reset a rejected response.
		socket.once("close", () => {
			sockets.delete(socket);
			onClose();
		});
		// Keep the connection open so rejection/bodyless cleanup is observable.
		socket.once("data", (data) => {
			onRequest(data.toString());
			if (end) socket.end(wireResponse);
			else socket.write(wireResponse);
		});
	});
	t.after(async () => {
		const stopped = new Promise<void>((resolve, reject) => {
			server.close((err) => err ? reject(err) : resolve());
		});
		for (const socket of sockets) socket.destroy();
		await stopped;
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address() as net.AddressInfo;
	const url = new URL(`http://transport.example:${port}/`);
	return {
		url,
		closed,
		received,
		request: (init: RequestInit = {}) => pinnedFetch(url, { address: "127.0.0.1", family: 4 }, init),
	};
}

for (const status of [0, 99, 600, 999]) {
	test(`pinnedFetch rejects HTTP ${status} without an uncaught exception and closes the socket`, { timeout: 5000 }, async (t) => {
		const fixture = await serveResponse(t,
			`HTTP/1.1 ${String(status).padStart(3, "0")} Custom\r\nContent-Length: 1000000\r\n\r\n`);
		await assert.rejects(fixture.request(), new RegExp(`Unsupported HTTP status: ${status}`));
		await fixture.closed;
	});
}

for (const status of [200, 206, 302, 404, 599]) {
	test(`pinnedFetch preserves HTTP ${status}, headers, and body`, { timeout: 5000 }, async (t) => {
		const fixture = await serveResponse(t,
			`HTTP/1.1 ${status} Custom\r\nContent-Length: 2\r\nX-Test: preserved\r\n\r\nok`);
		const response = await fixture.request();
		assert.equal(response.status, status);
		assert.equal(response.statusText, "Custom");
		assert.equal(response.headers.get("x-test"), "preserved");
		assert.equal(await response.text(), "ok");
	});
}

for (const { status, method } of [
	{ status: 204, method: "GET" },
	{ status: 205, method: "GET" },
	{ status: 304, method: "GET" },
	{ status: 200, method: "head" },
]) {
	test(`pinnedFetch returns a null body for ${method} HTTP ${status} and closes the socket`, { timeout: 5000 }, async (t) => {
		const fixture = await serveResponse(t,
			`HTTP/1.1 ${status} Custom\r\nContent-Length: 42\r\nX-Test: preserved\r\n\r\n`);
		const response = await fixture.request({ method });
		assert.equal(response.status, status);
		assert.equal(response.headers.get("x-test"), "preserved");
		assert.equal(response.body, null);
		assert.equal(await response.text(), "");
		await fixture.closed;
	});
}

test("pinnedFetch ignores informational responses before the final response", { timeout: 5000 }, async (t) => {
	const fixture = await serveResponse(t,
		"HTTP/1.1 103 Early Hints\r\nLink: </style.css>; rel=preload\r\n\r\n" +
		"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
	const response = await fixture.request();
	assert.equal(response.status, 200);
	assert.equal(await response.text(), "ok");
});

test("pinnedFetch rejects protocol upgrades and closes the upgraded socket", { timeout: 5000 }, async (t) => {
	const fixture = await serveResponse(t,
		"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
	await assert.rejects(fixture.request(), /Unsupported HTTP upgrade/);
	await fixture.closed;
});

test("pinnedFetch rejects response-construction errors and closes the socket", { timeout: 5000 }, async (t) => {
	const fixture = await serveResponse(t, "HTTP/1.1 200 OK\r\nContent-Length: 1000000\r\n\r\n");
	const error = new TypeError("Response construction failed");
	t.mock.method(globalThis, "Response", function () { throw error; });
	await assert.rejects(fixture.request(), (err) => err === error);
	await fixture.closed;
});

test("pinnedFetch rejects header-conversion errors and closes the socket", { timeout: 5000 }, async (t) => {
	const fixture = await serveResponse(t, "HTTP/1.1 200 OK\r\nContent-Length: 1000000\r\n\r\n");
	const error = new TypeError("Header conversion failed");
	t.mock.method(Headers.prototype, "append", function () { throw error; });
	await assert.rejects(fixture.request(), (err) => err === error);
	await fixture.closed;
});

test("fetchPage reports an unsupported server status as a page error", { timeout: 5000 }, async (t) => {
	const fixture = await serveResponse(t, "HTTP/1.1 999 Custom\r\nContent-Length: 1000000\r\n\r\n");
	const page = await fetchPage(fixture.url.toString(), {
		lookup: async () => [{ address: "93.184.216.34", family: 4 }],
		fetch: async (_url, init) => fixture.request(init),
	});
	assert.match(page.error ?? "", /Unsupported HTTP status: 999/);
	assert.equal(page.content, "");
	await fixture.closed;
});

for (const [encoding, compress] of [
	["gzip", gzipSync], ["deflate", deflateSync], ["br", brotliCompressSync],
] as const) {
	test(`pinnedFetch decodes ${encoding} responses`, { timeout: 5000 }, async (t) => {
		const text = "Readable compressed text π";
		const compressed = compress(Buffer.from(text));
		const fixture = await serveResponse(t, Buffer.concat([
			Buffer.from(`HTTP/1.1 200 OK\r\nContent-Encoding: ${encoding}\r\nContent-Length: ${compressed.length}\r\n\r\n`), compressed,
		]));
		const response = await fixture.request();
		assert.equal(await response.text(), text);
		assert.equal(response.headers.has("content-encoding"), false);
		assert.equal(response.headers.has("content-length"), false);
	});

	test(`${encoding} expansion stays chunked and stops at the decoded byte limit`, { timeout: 5000 }, async (t) => {
		const compressed = compress(Buffer.alloc(MAX_FETCH_BYTES * 2, 120));
		const fixture = await serveResponse(t, Buffer.concat([
			Buffer.from(`HTTP/1.1 200 OK\r\nContent-Encoding: ${encoding}\r\nContent-Length: 1000000\r\n\r\n`), compressed,
		]));
		const response = await fixture.request();
		let maxChunkBytes = 0;
		const observed = response.body!.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				maxChunkBytes = Math.max(maxChunkBytes, chunk.byteLength);
				controller.enqueue(chunk);
			},
		}));
		await assert.rejects(readTextLimited(new Response(observed), MAX_FETCH_BYTES), /too large/);
		assert.ok(maxChunkBytes > 0 && maxChunkBytes <= 64 * 1024, `max decoded chunk: ${maxChunkBytes}`);
		await fixture.closed;
	});
}

test("pinnedFetch decodes stacked encodings in reverse order", { timeout: 5000 }, async (t) => {
	const compressed = brotliCompressSync(gzipSync("stacked"));
	const fixture = await serveResponse(t, Buffer.concat([
		Buffer.from(`HTTP/1.1 200 OK\r\nContent-Encoding: gzip, br\r\nContent-Length: ${compressed.length}\r\n\r\n`), compressed,
	]));
	assert.equal(await (await fixture.request()).text(), "stacked");
});

test("decoded response size is bounded and cancellation closes the transport", { timeout: 5000 }, async (t) => {
	const compressed = gzipSync("x".repeat(100_000));
	const fixture = await serveResponse(t, Buffer.concat([
		Buffer.from("HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 1000000\r\n\r\n"), compressed,
	]));
	await assert.rejects(readTextLimited(await fixture.request(), 1000), /too large/);
	await fixture.closed;
});

test("corrupt compression rejects body consumption and closes an incomplete transport", { timeout: 5000 }, async (t) => {
	const fixture = await serveResponse(t, "HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 1000000\r\n\r\nbad");
	await assert.rejects((await fixture.request()).text());
	await fixture.closed;
});

test("truncated response bodies reject instead of silently succeeding", { timeout: 5000 }, async (t) => {
	const fixture = await serveResponse(t, "HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nshort", true);
	await assert.rejects((await fixture.request()).text());
});

test("unsupported content encodings reject and close the socket", { timeout: 5000 }, async (t) => {
	const fixture = await serveResponse(t, "HTTP/1.1 200 OK\r\nContent-Encoding: unknown\r\nContent-Length: 1000000\r\n\r\n");
	await assert.rejects(fixture.request(), /Unsupported content encoding/);
	await fixture.closed;
});

test("pinnedFetch derives Host from the URL and advertises supported encodings", { timeout: 5000 }, async (t) => {
	const fixture = await serveResponse(t, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
	assert.equal(await (await fixture.request({ headers: { Host: "wrong.example" } })).text(), "ok");
	const request = await fixture.received;
	assert.ok(request.toLowerCase().includes(`host: ${fixture.url.host}`));
	assert.match(request, /accept-encoding: gzip, deflate, br/i);
});

test("abort after headers also cancels a decompression pipeline", { timeout: 5000 }, async (t) => {
	const controller = new AbortController();
	const fixture = await serveResponse(t, "HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 1000000\r\n\r\n");
	const response = await fixture.request({ signal: controller.signal });
	const rejected = assert.rejects(response.text());
	controller.abort();
	await rejected;
	await fixture.closed;
});

test("pinnedFetch rejects CONNECT rather than leaving an unhandled tunnel", { timeout: 5000 }, async (t) => {
	const fixture = await serveResponse(t, "HTTP/1.1 200 Connection Established\r\n\r\n");
	await assert.rejects(fixture.request({ method: "CONNECT" }), /Unsupported request method/);
});

test("pinnedFetch still rejects an aborted request", { timeout: 5000 }, async (t) => {
	const fixture = await serveResponse(t, "");
	const controller = new AbortController();
	const rejected = assert.rejects(fixture.request({ signal: controller.signal }), { name: "AbortError" });
	controller.abort();
	await rejected;
});
