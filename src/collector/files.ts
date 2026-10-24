// Files for the collector: stored in R2 (bucket tum-files) when they are not videos and not larger than
// 100 MB. The collector gives only the file, its link and its R2 key. It makes no text from files: the
// watcher reads every PDF itself, because machine-made text can contain invented content (0.7.6).

import { guessMimeType } from "../lib/mime-types";
import { type FileRef, hash64, isVideo, MAX_FILE_BYTES } from "./model";

/** Files up to this size are read into memory (content hash). Larger ones, and files of unknown size, stream into R2. */
const MAX_MEMORY_BYTES = 8 * 1024 * 1024;
/** Part size of streamed uploads. R2 needs equal parts (except the last) of at least 5 MiB. */
const STREAM_PART = 8 * 1024 * 1024;

class TooLarge extends Error {}

/**
 * Streams a body into R2 without holding the file in memory: a multipart upload with parts of exactly
 * STREAM_PART bytes (at most one part in memory). Stops above MAX_FILE_BYTES. Returns the stored size.
 */
export async function streamToR2(env: Env, key: string, body: ReadableStream<Uint8Array>, meta: R2PutOptions): Promise<number> {
	const up = await env.FILES.createMultipartUpload(key, { httpMetadata: meta.httpMetadata, customMetadata: meta.customMetadata });
	const parts: R2UploadedPart[] = [];
	const reader = body.getReader();
	let buf = new Uint8Array(STREAM_PART);
	let fill = 0;
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_FILE_BYTES) throw new TooLarge();
			let off = 0;
			while (off < value.byteLength) {
				const n = Math.min(STREAM_PART - fill, value.byteLength - off);
				buf.set(value.subarray(off, off + n), fill);
				fill += n;
				off += n;
				if (fill === STREAM_PART) {
					parts.push(await up.uploadPart(parts.length + 1, buf));
					buf = new Uint8Array(STREAM_PART);
					fill = 0;
				}
			}
		}
		if (fill || !parts.length) parts.push(await up.uploadPart(parts.length + 1, buf.subarray(0, fill)));
		await up.complete(parts);
		return total;
	} catch (e) {
		await reader.cancel().catch(() => {});
		await up.abort().catch(() => {});
		throw e;
	}
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeName(name: string): string {
	return (name || "file").replace(/[\\/\x00-\x1f]/g, "_").slice(0, 180);
}

/** Stores bytes that are already in memory (mail attachments). */
export async function storeBytes(env: Env, opts: { name: string; mime: string | null; url: string; bytes: Uint8Array }): Promise<FileRef> {
	const name = safeName(opts.name);
	const mime = opts.mime || guessMimeType(name);
	const base: FileRef = { name: opts.name, mime_type: mime, size: opts.bytes.byteLength, url: opts.url, r2_key: null };
	if (isVideo(name) || isVideo(mime)) return { ...base, not_stored: "video (only the link is kept)" };
	if (opts.bytes.byteLength > MAX_FILE_BYTES) return { ...base, not_stored: "larger than 100 MB (only the link is kept)" };
	const key = `files/${(await sha256Hex(opts.bytes)).slice(0, 40)}`;
	if (!(await env.FILES.head(key))) await env.FILES.put(key, opts.bytes, { httpMetadata: { contentType: mime }, customMetadata: { name: opts.name } });
	return { ...base, r2_key: key };
}

/** A copy stored before under a platform revision key, without any request to the platform. */
export async function fileByStableKey(env: Env, stableKey: string, url: string): Promise<FileRef | undefined> {
	const key = `files/${hash64(stableKey)}`;
	const head = await env.FILES.head(key);
	if (!head) return undefined;
	const name = head.customMetadata?.name ?? "file";
	const mime = head.httpMetadata?.contentType ?? null;
	return { name, mime_type: mime, size: head.size, url, r2_key: key };
}

/**
 * Downloads a file and stores it. `open` requests the file from the platform. With `stableKey` (a platform
 * revision or version), a copy stored under that key is reused and the platform is not asked again.
 */
export async function storeResponse(env: Env, opts: { name: string; url: string; open: () => Promise<Response>; stableKey?: string }): Promise<FileRef> {
	if (opts.stableKey) {
		const stored = await fileByStableKey(env, opts.stableKey, opts.url);
		if (stored) return stored;
	}
	const res = await opts.open();
	const disposition = res.headers.get("Content-Disposition") ?? "";
	const fromHeader = decodeURIComponent(/filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1] ?? "") || /filename="([^"]+)"/i.exec(disposition)?.[1] || "";
	const shown = fromHeader || opts.name;
	const name = safeName(shown);
	const mime = (res.headers.get("Content-Type") ?? "").split(";")[0].trim() || guessMimeType(name);
	const length = Number(res.headers.get("Content-Length") ?? NaN);
	const size = Number.isFinite(length) ? length : null;
	const base: FileRef = { name: shown, mime_type: mime, size, url: opts.url, r2_key: null };
	if (!res.ok) {
		await res.body?.cancel();
		throw new Error(`download HTTP ${res.status}`);
	}
	if (isVideo(name) || isVideo(mime)) {
		await res.body?.cancel();
		return { ...base, not_stored: "video (only the link is kept)" };
	}
	if (size !== null && size > MAX_FILE_BYTES) {
		await res.body?.cancel();
		return { ...base, not_stored: "larger than 100 MB (only the link is kept)" };
	}
	const meta = { httpMetadata: { contentType: mime }, customMetadata: { name: shown, url: opts.url } };
	if ((size === null || size > MAX_MEMORY_BYTES) && res.body) {
		// Large file or unknown size: streamed into R2 (multipart), never held in memory as a whole.
		const key = opts.stableKey ? `files/${hash64(opts.stableKey)}` : `files/${hash64(`${opts.url}|${size ?? ""}|${res.headers.get("ETag") ?? ""}|${res.headers.get("Last-Modified") ?? ""}`)}`;
		try {
			const stored = await streamToR2(env, key, res.body, meta);
			return { ...base, size: stored, r2_key: key };
		} catch (e) {
			if (e instanceof TooLarge) return { ...base, not_stored: "larger than 100 MB (only the link is kept)" };
			throw e;
		}
	}
	const bytes = new Uint8Array(await res.arrayBuffer());
	if (bytes.byteLength > MAX_FILE_BYTES) return { ...base, size: bytes.byteLength, not_stored: "larger than 100 MB (only the link is kept)" };
	const key = opts.stableKey ? `files/${hash64(opts.stableKey)}` : `files/${(await sha256Hex(bytes)).slice(0, 40)}`;
	if (!(await env.FILES.head(key))) await env.FILES.put(key, bytes, meta);
	return { ...base, size: bytes.byteLength, r2_key: key };
}

/** A file that is only linked (video, or known to be larger than 100 MB). */
export function linkOnly(name: string, url: string, reason: string, size: number | null = null, mime: string | null = null): FileRef {
	return { name, mime_type: mime, size, url, r2_key: null, not_stored: reason };
}
