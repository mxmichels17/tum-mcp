// Signed download links for stored files. collector_item hands out files that are too large for a tool
// result (base64 in the MCP answer) as a link to this Worker: GET /files/download?k=<R2 key>&e=<expiry>&s=<signature>.
// The signature is an HMAC-SHA256 over key and expiry with a key derived from COOKIE_ENCRYPTION_KEY, so only
// links made by the server work, and only until they expire. The file is streamed from R2, never held in memory.

const encoder = new TextEncoder();
export const DOWNLOAD_PATH = "/files/download";
/** Links are valid for one hour. */
export const LINK_TTL_S = 3600;

async function hmacKey(env: Env): Promise<CryptoKey> {
	const secret = env.COOKIE_ENCRYPTION_KEY?.trim();
	if (!secret || secret.length < 32) throw new Error("COOKIE_ENCRYPTION_KEY is not set (needed to sign download links)");
	const raw = await crypto.subtle.digest("SHA-256", encoder.encode(`tum-mcp-download:${secret}`));
	return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function signature(env: Env, key: string, expires: number): Promise<string> {
	return hex(await crypto.subtle.sign("HMAC", await hmacKey(env), encoder.encode(`${key}|${expires}`)));
}

/** A link that downloads one stored R2 object until it expires. */
export async function signedDownloadUrl(env: Env, key: string, now = Date.now()): Promise<{ url: string; expires: string }> {
	const origin = (env.PUBLIC_ORIGIN || "").replace(/\/$/, "");
	if (!origin) throw new Error("PUBLIC_ORIGIN is not set (wrangler.jsonc vars)");
	const expires = Math.floor(now / 1000) + LINK_TTL_S;
	const u = new URL(`${origin}${DOWNLOAD_PATH}`);
	u.searchParams.set("k", key);
	u.searchParams.set("e", String(expires));
	u.searchParams.set("s", await signature(env, key, expires));
	return { url: u.toString(), expires: new Date(expires * 1000).toISOString() };
}

/** Constant-time comparison of two hex strings. */
function sameHex(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let d = 0;
	for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return d === 0;
}

/** GET /files/download: checks the signature and the expiry, then streams the R2 object. */
export async function handleDownload(request: Request, env: Env, now = Date.now()): Promise<Response> {
	if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
	const u = new URL(request.url);
	const key = u.searchParams.get("k") ?? "";
	const expires = Number(u.searchParams.get("e"));
	const sig = u.searchParams.get("s") ?? "";
	if (!/^(files|html|content)\//.test(key) || key.includes("..") || !Number.isFinite(expires)) return new Response("Bad link", { status: 400 });
	if (expires * 1000 < now) return new Response("Link expired", { status: 410 });
	if (!sameHex(sig, await signature(env, key, expires))) return new Response("Bad signature", { status: 403 });
	const o = await env.FILES.get(key);
	if (!o) return new Response("Not found", { status: 404 });
	const name = o.customMetadata?.name ?? key.split("/").pop() ?? "file";
	const headers = new Headers({
		"Content-Type": o.httpMetadata?.contentType ?? "application/octet-stream",
		"Content-Length": String(o.size),
		"Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
		"Cache-Control": "private, no-store",
	});
	return new Response(request.method === "HEAD" ? null : o.body, { headers });
}
