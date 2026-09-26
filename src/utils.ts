export function normalizeList(single: unknown, multiple: unknown, label: string, maxLength: number, maxItems: number): string[] {
	const raw = Array.isArray(multiple) ? multiple : single !== undefined ? [single] : [];
	const out: string[] = [];
	for (const item of raw) {
		if (typeof item !== "string") continue;
		const trimmed = item.trim();
		if (!trimmed) continue;
		if (trimmed.length > maxLength) throw new Error(`${label} too long (max ${maxLength} characters)`);
		if (!out.includes(trimmed)) out.push(trimmed);
		if (out.length >= maxItems) break;
	}
	return out;
}

export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
