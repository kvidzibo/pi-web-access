import { cancelBody } from "./transport.ts";

export async function readTextLimited(response: Response, maxBytes: number): Promise<string> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) {
		await cancelBody(response);
		throw new Error(`Response too large (${declared} bytes)`);
	}
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			size += value.byteLength;
			if (size > maxBytes) throw new Error(`Response too large (>${maxBytes} bytes)`);
			chunks.push(value);
		}
		return Buffer.concat(chunks).toString("utf8");
	} catch (err) {
		try { await reader.cancel(); } catch { /* Preserve the original read/size error. */ }
		throw err;
	} finally {
		reader.releaseLock();
	}
}
