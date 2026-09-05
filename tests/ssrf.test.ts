import assert from "node:assert/strict";
import { test } from "node:test";
import {
	fetchRemoteUrl,
	isBlockedAddress,
	isBlockedIPv4,
	isBlockedIPv6,
	looksLikeNonCanonicalIp,
	pinnedConnectOptions,
	resolvePinnedTarget,
	validateRemoteUrl,
} from "../ssrf.ts";

test("blocks loopback and RFC1918 IPv4", () => {
	assert.equal(isBlockedIPv4("127.0.0.1"), true);
	assert.equal(isBlockedIPv4("10.0.0.1"), true);
	assert.equal(isBlockedIPv4("192.168.1.1"), true);
	assert.equal(isBlockedIPv4("172.16.0.1"), true);
	assert.equal(isBlockedIPv4("169.254.169.254"), true);
	assert.equal(isBlockedIPv4("0.0.0.0"), true);
	assert.equal(isBlockedIPv4("192.0.2.1"), true);
	assert.equal(isBlockedIPv4("198.51.100.1"), true);
	assert.equal(isBlockedIPv4("203.0.113.1"), true);
	assert.equal(isBlockedIPv4("100.64.0.1"), true);
	assert.equal(isBlockedIPv4("8.8.8.8"), false);
});

test("blocks IPv6 loopback, ULA, link-local, mapped loopback", () => {
	assert.equal(isBlockedIPv6("::1"), true);
	assert.equal(isBlockedIPv6("::"), true);
	assert.equal(isBlockedIPv6("fc00::1"), true);
	assert.equal(isBlockedIPv6("fe80::1"), true);
	assert.equal(isBlockedIPv6("fec0::1"), true);
	assert.equal(isBlockedIPv6("ff02::1"), true);
	assert.equal(isBlockedIPv6("::ffff:127.0.0.1"), true);
	assert.equal(isBlockedIPv6("2002:c0a8:1::1"), true);
	assert.equal(isBlockedIPv6("64:ff9b::c0a8:1"), true);
	assert.equal(isBlockedIPv6("64:ff9b:1::7f00:1"), true);
	assert.equal(isBlockedIPv6("::ffff:0:127.0.0.1"), true);
	assert.equal(isBlockedIPv6("3fff::1"), true);
	assert.equal(isBlockedIPv6("5f00::1"), true);
	assert.equal(isBlockedIPv6("2001::1"), true);
	assert.equal(isBlockedIPv6("2002:0808:0808::1"), false);
	assert.equal(isBlockedIPv6("2001:4860:4860::8888"), false);
});

test("non-canonical IP hostnames detected", () => {
	assert.equal(looksLikeNonCanonicalIp("2130706433"), true);
	assert.equal(looksLikeNonCanonicalIp("0x7f000001"), true);
	assert.equal(looksLikeNonCanonicalIp("0177.0.0.1"), true);
	assert.equal(looksLikeNonCanonicalIp("example.com"), false);
});

test("validateRemoteUrl rejects credentials, file, localhost, dword IP", async () => {
	await assert.rejects(() => validateRemoteUrl("file:///etc/passwd"), /Only HTTP/);
	await assert.rejects(() => validateRemoteUrl("http://user:pass@example.com/"), /credentials/);
	await assert.rejects(() => validateRemoteUrl("http://localhost/"), /internal hostname/);
	await assert.rejects(() => validateRemoteUrl("http://127.0.0.1/"), /internal address/);
	await assert.rejects(() => validateRemoteUrl("http://169.254.169.254/latest"), /internal address/);
	await assert.rejects(() => validateRemoteUrl("http://2130706433/"), /internal address/);
	await assert.rejects(() => validateRemoteUrl("http://0x7f000001/"), /internal address/);
	await assert.rejects(() => validateRemoteUrl("http://0177.0.0.1/"), /internal address/);
	await assert.rejects(() => validateRemoteUrl("http://metadata.google.internal/"), /internal hostname/);
});

test("validateRemoteUrl rejects DNS to private IP", async () => {
	await assert.rejects(
		() => validateRemoteUrl("https://evil.example", {
			lookup: async () => [{ address: "127.0.0.1", family: 4 }],
		}),
		/internal address/,
	);
});

test("validateRemoteUrl allows public DNS", async () => {
	const url = await validateRemoteUrl("https://example.com/path", {
		lookup: async () => [{ address: "93.184.216.34", family: 4 }],
	});
	assert.equal(url.hostname, "example.com");
});

test("redirect to localhost is blocked", async () => {
	const fetchImpl = async () => new Response(null, {
		status: 302,
		headers: { location: "http://127.0.0.1/" },
	});
	await assert.rejects(
		() => fetchRemoteUrl("https://example.com/", {}, {
			fetch: fetchImpl as typeof fetch,
			lookup: async () => [{ address: "93.184.216.34", family: 4 }],
		}),
		/internal address/,
	);
});

test("isBlockedAddress rejects non-IP", () => {
	assert.equal(isBlockedAddress("not-an-ip"), true);
});

test("pinned connect uses lookup address not hostname", () => {
	const url = new URL("https://evil.example/path");
	const opts = pinnedConnectOptions(url, { address: "93.184.216.34", family: 4 });
	assert.equal(opts.hostname, "93.184.216.34");
	assert.equal(opts.servername, "evil.example");
	assert.equal(opts.headers?.host, "evil.example");
	assert.equal(opts.path, "/path");
});

test("fetchRemoteUrl pins lookup address on the production connect path", async () => {
	let pinned: string | undefined;
	const { finalUrl, address } = await fetchRemoteUrl("https://evil.example/", {}, {
		lookup: async () => [{ address: "93.184.216.34", family: 4 }],
		pinnedFetch: async (url, target) => {
			pinned = target.address;
			assert.equal(url.hostname, "evil.example");
			return new Response("ok", { status: 200 });
		},
	});
	assert.equal(pinned, "93.184.216.34");
	assert.equal(address.address, "93.184.216.34");
	assert.equal(finalUrl.hostname, "evil.example");
});

test("mixed public+private DNS is fail-closed", async () => {
	await assert.rejects(
		() => fetchRemoteUrl("https://evil.example/", {}, {
			lookup: async () => [
				{ address: "93.184.216.34", family: 4 },
				{ address: "127.0.0.1", family: 4 },
			],
			pinnedFetch: async () => new Response("should not run"),
		}),
		/internal address/,
	);
});

test("DNS lookup observes cancellation without opening a connection", { timeout: 2000 }, async () => {
	const controller = new AbortController();
	let connected = false;
	let markStarted!: () => void;
	const started = new Promise<void>((resolve) => { markStarted = resolve; });
	const result = fetchRemoteUrl("https://example.com/", { signal: controller.signal }, {
		lookup: () => { markStarted(); return new Promise(() => {}); },
		pinnedFetch: async () => { connected = true; return new Response("unexpected"); },
	});
	const rejected = assert.rejects(result, { name: "AbortError" });
	await started;
	controller.abort();
	await rejected;
	assert.equal(connected, false);
});

test("late DNS rejections are handled after cancellation", async () => {
	const controller = new AbortController();
	let rejectLookup!: (error: Error) => void;
	let markStarted!: () => void;
	const started = new Promise<void>((resolve) => { markStarted = resolve; });
	const result = validateRemoteUrl("https://example.com/", {
		signal: controller.signal,
		lookup: () => new Promise((_resolve, reject) => { rejectLookup = reject; markStarted(); }),
	});
	const rejected = assert.rejects(result, { name: "AbortError" });
	await started;
	controller.abort();
	await rejected;
	rejectLookup(new Error("late DNS failure"));
	await new Promise<void>((resolve) => setImmediate(resolve));
});

test("already-aborted requests do not resolve DNS", async () => {
	const controller = new AbortController();
	controller.abort();
	let lookedUp = false;
	await assert.rejects(fetchRemoteUrl("https://example.com/", { signal: controller.signal }, {
		lookup: async () => { lookedUp = true; return [{ address: "8.8.8.8", family: 4 }]; },
		pinnedFetch: async () => new Response("unexpected"),
	}), { name: "AbortError" });
	assert.equal(lookedUp, false);
});

test("URL validation snapshots caller-owned URL objects before DNS lookup", async () => {
	const url = new URL("https://example.com/original");
	const target = await resolvePinnedTarget(url, {
		lookup: async () => {
			url.href = "http://localhost/changed";
			return [{ address: "8.8.8.8", family: 4 }];
		},
	});
	assert.equal(target.url.href, "https://example.com/original");
});

test("IP-literal HTTPS targets do not send an IP as TLS SNI", () => {
	for (const [host, address, family] of [
		["8.8.8.8", "8.8.8.8", 4],
		["[2001:4860:4860::8888]", "2001:4860:4860::8888", 6],
	] as const) {
		assert.equal(pinnedConnectOptions(new URL(`https://${host}/`), { address, family }).servername, undefined);
	}
});

test("cross-origin redirects strip credentials and stale Host headers", async () => {
	const calls: Headers[] = [];
	await fetchRemoteUrl("https://first.example/", {
		headers: { Authorization: "Bearer test-only", Cookie: "fixture=1", "Proxy-Authorization": "Basic fixture", Host: "first.example", "X-Keep": "yes" },
	}, {
		lookup: async () => [{ address: "8.8.8.8", family: 4 }],
		pinnedFetch: async (_url, _address, init) => {
			calls.push(new Headers(init.headers));
			return calls.length === 1
				? new Response(null, { status: 302, headers: { location: "https://second.example/" } })
				: new Response("ok");
		},
	});
	for (const name of ["authorization", "cookie", "proxy-authorization", "host"]) assert.equal(calls[1].has(name), false, name);
	assert.equal(calls[1].get("x-keep"), "yes");
	assert.equal(calls[0].get("authorization"), "Bearer test-only");
});

test("POST redirects rewritten to GET drop body headers and retain same-origin auth", async () => {
	let calls = 0;
	await fetchRemoteUrl("https://example.com/", {
		method: "POST", body: "body",
		headers: { "Content-Length": "4", "Content-Type": "text/plain", "Content-Encoding": "identity", "Content-Language": "en", "Content-Location": "/body", "Transfer-Encoding": "chunked", Authorization: "Bearer fixture" },
	}, {
		lookup: async () => [{ address: "8.8.8.8", family: 4 }],
		pinnedFetch: async (_url, _address, init) => {
			if (++calls === 1) return new Response(null, { status: 302, headers: { location: "/next" } });
			assert.equal(init.method, "GET");
			assert.equal(init.body, undefined);
			const headers = new Headers(init.headers);
			for (const name of ["content-length", "content-type", "content-encoding", "content-language", "content-location", "transfer-encoding"]) assert.equal(headers.has(name), false, name);
			assert.equal(headers.get("authorization"), "Bearer fixture");
			return new Response("ok");
		},
	});
});

test("303 redirects preserve HEAD", async () => {
	let calls = 0;
	await fetchRemoteUrl("https://example.com/", { method: "HEAD" }, {
		lookup: async () => [{ address: "8.8.8.8", family: 4 }],
		pinnedFetch: async (_url, _address, init) => {
			if (++calls === 1) return new Response(null, { status: 303, headers: { location: "/next" } });
			assert.equal(init.method, "HEAD");
			return new Response(null);
		},
	});
});

test("redirect body is cancelled", async () => {
	let cancelled = false;
	const body = new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode("redirect-body"));
		},
		cancel() {
			cancelled = true;
		},
	});
	let calls = 0;
	await fetchRemoteUrl("https://example.com/", {}, {
		lookup: async () => [{ address: "93.184.216.34", family: 4 }],
		fetch: async () => {
			calls += 1;
			if (calls === 1) {
				return new Response(body, { status: 302, headers: { location: "https://example.com/next" } });
			}
			return new Response("ok", { status: 200 });
		},
	});
	assert.equal(cancelled, true);
	assert.equal(calls, 2);
});
