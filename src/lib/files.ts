// Turns downloaded bytes into an MCP tool result: images as image, text as text, others as base64 resource.

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toBase64 } from "./bytes";
import { truncate } from "./tools";

export const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;

export function fileResult(filename: string, mimeType: string, bytes: Uint8Array, uri: string): CallToolResult {
	if (bytes.byteLength > MAX_DOWNLOAD_BYTES) {
		throw new Error(`File is too large (${bytes.byteLength} bytes, limit ${MAX_DOWNLOAD_BYTES})`);
	}
	const meta = { type: "text" as const, text: JSON.stringify({ filename, mime_type: mimeType, size: bytes.byteLength }) };
	if (/^image\/(png|jpeg|gif|webp)$/.test(mimeType)) {
		return { content: [meta, { type: "image", data: toBase64(bytes), mimeType }] };
	}
	if (/^text\/|^application\/(json|xml|csv)|\+xml$|\+json$/.test(mimeType)) {
		const t = truncate(new TextDecoder().decode(bytes), 200_000);
		return { content: [meta, { type: "text", text: t.text + (t.truncated ? "\n[truncated]" : "") }] };
	}
	return { content: [meta, { type: "resource", resource: { uri, mimeType, blob: toBase64(bytes) } }] };
}
