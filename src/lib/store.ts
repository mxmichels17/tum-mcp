// Small private state (tokens, sessions) in the CACHE KV namespace.
// Values are encrypted with AES-GCM when COOKIE_ENCRYPTION_KEY is set (recommended).

const encoder = new TextEncoder();

async function key(env: Env): Promise<CryptoKey | undefined> {
	const secret = env.COOKIE_ENCRYPTION_KEY?.trim();
	if (!secret || secret.length < 32) return undefined;
	const hash = await crypto.subtle.digest("SHA-256", encoder.encode(`tum-mcp-store:${secret}`));
	return crypto.subtle.importKey("raw", hash, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function b64(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
}

function unb64(s: string): Uint8Array {
	const bin = atob(s);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export async function storePut(env: Env, name: string, value: unknown, ttlSeconds?: number): Promise<void> {
	const plain = JSON.stringify(value);
	const k = await key(env);
	let stored = `p:${plain}`;
	if (k) {
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, encoder.encode(plain)));
		stored = `e:${b64(iv)}:${b64(ct)}`;
	}
	await env.CACHE.put(`state:${name}`, stored, ttlSeconds ? { expirationTtl: Math.max(60, ttlSeconds) } : undefined);
}

export async function storeGet<T>(env: Env, name: string): Promise<T | undefined> {
	const stored = await env.CACHE.get(`state:${name}`);
	if (!stored) return undefined;
	try {
		if (stored.startsWith("p:")) return JSON.parse(stored.slice(2)) as T;
		const [, iv, ct] = stored.split(":");
		const k = await key(env);
		if (!k) return undefined;
		const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, k, unb64(ct));
		return JSON.parse(new TextDecoder().decode(plain)) as T;
	} catch {
		return undefined;
	}
}

export async function storeDelete(env: Env, name: string): Promise<void> {
	await env.CACHE.delete(`state:${name}`);
}
