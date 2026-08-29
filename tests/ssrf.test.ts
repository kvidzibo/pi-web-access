import assert from "node:assert/strict";
import { test } from "node:test";
import {
	fetchRemoteUrl,
	isBlockedAddress,
	isBlockedIPv4,
	isBlockedIPv6,
	looksLikeNonCanonicalIp,
	pinnedConnectOptions,
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
