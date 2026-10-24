// MCP tools of the collector: collector_run (run and return the delta), collector_ack (confirm the delta)
// and collector_item (full stored item). Delivery is at least once: collector_run never moves the delivered
// pointer, only collector_ack does, after the caller has processed the deltas.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fileResult } from "../lib/files";
import { json, run } from "../lib/tools";
import { signedDownloadUrl } from "./download";
import { runAll, SOURCES, type UnitRun } from "./runner";
import { deltaOut, deltaRow, deltaRows, ensureSchema, getState, unpack } from "./store";

/** Larger stored files come as a signed download link (base64 in a tool result grows by a third). */
const INLINE_FILE_BYTES = 4 * 1024 * 1024;

/** collector_run waits this long for units to start; units still running finish in the background. */
const RUN_START_MS = 30_000;
const RUN_WAIT_MS = 50_000;

async function deltaPage(env: Env, after: number, maxChars: number) {
	const out: unknown[] = [];
	let used = 0;
	let last = after;
	let more = false;
	outer: for (;;) {
		const rows = await deltaRows(env.DB, last, 50);
		if (!rows.length) break;
		for (const r of rows) {
			const d = await deltaOut(env, r);
			let s = JSON.stringify(d);
			if (s.length > maxChars) {
				// One delta larger than the page: content and changes come with collector_item.
				const get_with = `collector_item with delta_id ${r.id}`;
				d.content = { $truncated: true, size: JSON.stringify(d.content).length, get_with };
				if (d.changes) d.changes = { $truncated: true, size: JSON.stringify(d.changes).length, get_with };
				s = JSON.stringify(d);
			}
			if (out.length && used + s.length > maxChars) {
				more = true;
				break outer;
			}
			out.push(d);
			used += s.length;
			last = r.id;
		}
		if (rows.length < 50) break;
	}
	if (!more) more = (await deltaRows(env.DB, last, 1)).length > 0;
	return { deltas: out, last, more };
}

/**
 * Moves the delivered pointer to `next`. `next` must be the current pointer or an existing delta id above it.
 * The update only applies while the stored pointer is not above `next`, so it never moves backwards, also
 * when two calls race.
 */
export async function ackDeltas(db: D1Database, next: number): Promise<{ old_pointer: number; new_pointer: number; moved: boolean }> {
	const old = (await getState<number>(db, "delivered")) ?? 0;
	if (next < old) throw new Error(`next ${next} is below the delivered pointer ${old}; the pointer never moves backwards`);
	if (next === old) return { old_pointer: old, new_pointer: old, moved: false };
	if (!(await deltaRow(db, next))) throw new Error(`No delta with id ${next}. Use the next_after of collector_run`);
	const now = new Date().toISOString();
	await db.prepare("INSERT OR IGNORE INTO state (key, value, updated_at) VALUES ('delivered', '0', ?)").bind(now).run();
	const r = await db.prepare("UPDATE state SET value = ?, updated_at = ? WHERE key = 'delivered' AND CAST(value AS INTEGER) <= ?").bind(JSON.stringify(next), now, next).run();
	if (!r.meta?.changes) {
		const cur = (await getState<number>(db, "delivered")) ?? 0;
		throw new Error(`The delivered pointer moved to ${cur} meanwhile; ${next} would move it backwards`);
	}
	return { old_pointer: old, new_pointer: next, moved: true };
}

export function registerCollectorTools(server: McpServer, env: Env) {
	server.registerTool(
		"collector_run",
		{
			description:
				"Collector: reads all TUM sources (mail, Zulip, TUMonline, Artemis, Moodle, TUM-Live, ITS scoreboard), stores the last state per item, and returns the deltas after the delivered pointer: new items with their complete content, changed items with the complete new content and every changed field (old and new value), removed items with their last known content. Every item has its source and a link to the original. No interpretation. " +
				"Flow: 1) call collector_run; while more is true, call it again with after = next_after (run: false is enough for the further pages). 2) Process all deltas and save your results. 3) Then call collector_ack with next = the last next_after. collector_run never moves the delivered pointer, so a call that breaks off loses nothing: the next collector_run returns the same deltas again until collector_ack confirms them. " +
				"A unit that does not finish within this call goes on in the background and in the cron (every 30 minutes); its deltas come with a later call. Read only on all platforms.",
			inputSchema: {
				sources: z.array(z.enum(SOURCES)).optional().describe("Only these sources. Default: all"),
				run: z.boolean().default(true).describe("false: do not read the sources, only return stored deltas"),
				after: z.number().int().min(0).optional().describe("Return deltas with id > after. Default: the delivered pointer (moved only by collector_ack). For the next page use the next_after of the page before"),
				max_chars: z.number().int().min(20_000).max(800_000).default(200_000).describe("Size limit of this page"),
			},
			annotations: { readOnlyHint: false, openWorldHint: true },
		},
		async ({ sources, run: doRun, after, max_chars }) =>
			run(async () => {
				await ensureSchema(env.DB);
				let runs: UnitRun[] | string | undefined;
				if (doRun) {
					const started = Date.now();
					runs = await Promise.race([
						runAll(env, "collector_run", sources, started + RUN_START_MS),
						new Promise<string>((r) => setTimeout(() => r("some units still run in the background; their deltas come with the next call"), RUN_WAIT_MS)),
					]);
				}
				const delivered = (await getState<number>(env.DB, "delivered")) ?? 0;
				const from = after ?? delivered;
				const page = await deltaPage(env, from, max_chars);
				// Confirmed deltas (up to the pointer) stay 30 days for a second read (after = an older id).
				await env.DB.prepare("DELETE FROM deltas WHERE id <= ? AND detected_at < ?").bind(delivered, new Date(Date.now() - 30 * 86400_000).toISOString()).run();
				const units = (await env.DB.prepare("SELECT unit, state, detail, last_run, last_ok, pending FROM unit_runs ORDER BY unit").all()).results;
				const backlog = (await env.DB.prepare("SELECT key, value FROM state WHERE (key LIKE 'pending:%' AND value != '0') OR (key LIKE 'backlog:%' AND value != 'null')").all<{ key: string; value: string }>()).results.map((r) => ({
					what: r.key.replace(/^(pending|backlog):/, ""),
					open: JSON.parse(r.value),
				}));
				return json({
					delivered_pointer: delivered,
					after: from,
					count: page.deltas.length,
					next_after: page.last,
					more: page.more,
					deltas: page.deltas,
					not_read_yet: backlog.length ? backlog : undefined,
					this_call: typeof runs === "string" ? runs : runs?.map((r) => ({ unit: r.unit, state: r.state, detail: r.detail, new: r.new, changed: r.changed, removed: r.removed, pending: r.pending })),
					units,
				});
			}),
	);

	server.registerTool(
		"collector_ack",
		{
			description:
				"Collector: confirms the deltas up to `next` after you processed them and saved your results. Moves the delivered pointer to `next`, so the next collector_run starts after it. Call it once at the end with the last next_after of collector_run. `next` must be the current pointer or the id of an existing delta above it; the pointer never moves backwards. Returns the old and the new pointer.",
			inputSchema: { next: z.number().int().min(0).describe("The last next_after of collector_run") },
			annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
		},
		async ({ next }) =>
			run(async () => {
				await ensureSchema(env.DB);
				return json(await ackDeltas(env.DB, next));
			}),
	);

	server.registerTool(
		"collector_item",
		{
			description:
				"Collector: the full stored content of one item (by key) or of one delta (by delta_id), optionally with the stored HTML of a web page. With r2_key, returns one stored file (attachment, Moodle, Artemis, scoreboard or course website file) or HTML page: up to 4 MB in the result, larger files (up to 100 MB) as a signed download link valid for one hour, text files in pages. Long results come in pages: call again with offset = next_offset.",
			inputSchema: {
				key: z.string().optional().describe("Item key from collector_run"),
				delta_id: z.number().int().positive().optional().describe("Delta id from collector_run (the content as it was at that delta)"),
				include_html: z.boolean().default(false).describe("Add the stored HTML of a web page"),
				r2_key: z.string().optional().describe("A stored file or page: r2_key of a file entry, or html/... "),
				download_link: z.boolean().default(false).describe("With r2_key: return a download link instead of the file (files over 4 MB always come as a link)"),
				offset: z.number().int().min(0).default(0),
				max_chars: z.number().int().min(10_000).max(800_000).default(400_000),
			},
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async ({ key, delta_id, include_html, r2_key, download_link, offset, max_chars }) =>
			run(async () => {
				await ensureSchema(env.DB);
				if (r2_key) {
					if (!/^(files|html|content)\//.test(r2_key) || r2_key.includes("..")) throw new Error("r2_key must start with files/, html/ or content/");
					const head = await env.FILES.head(r2_key);
					if (!head) throw new Error(`No stored object ${r2_key}`);
					const mime = head.httpMetadata?.contentType?.split(";")[0] ?? "application/octet-stream";
					const name = head.customMetadata?.name ?? r2_key.split("/").pop() ?? "file";
					const text = /^text\/|json/.test(mime);
					if (download_link || (!text && head.size > INLINE_FILE_BYTES)) {
						// Large files do not fit a tool result: a signed link streams the file from R2 (valid one hour).
						const link = await signedDownloadUrl(env, r2_key);
						return json({ r2_key, name, mime_type: mime, size: head.size, download_url: link.url, link_expires: link.expires });
					}
					if (text) {
						// Text in pages of max_chars bytes, read from R2 by range.
						const o = offset < head.size ? await env.FILES.get(r2_key, { range: { offset, length: max_chars } }) : null;
						const t = o ? new TextDecoder().decode(await o.arrayBuffer()) : "";
						return json({ r2_key, name, mime_type: mime, size: head.size, offset, next_offset: offset + max_chars < head.size ? offset + max_chars : null, text: t });
					}
					const o = await env.FILES.get(r2_key);
					if (!o) throw new Error(`No stored object ${r2_key}`);
					return fileResult(name, mime, new Uint8Array(await o.arrayBuffer()), `r2://tum-files/${r2_key}`);
				}
				let out: Record<string, unknown>;
				let htmlKey: string | null = null;
				if (delta_id) {
					const d = await deltaRow(env.DB, delta_id);
					if (!d) throw new Error(`No delta ${delta_id} (deltas are kept 30 days after delivery)`);
					out = { ...(await deltaOut(env, d)) };
					htmlKey = d.html_key;
				} else if (key) {
					const r = await env.DB.prepare("SELECT * FROM items WHERE key = ?").bind(key).first<Record<string, string>>();
					if (!r) throw new Error(`No item ${key}`);
					const { content, hash: _h, ...meta } = r;
					out = { ...meta, content: await unpack(env, content) };
					htmlKey = r.html_key;
				} else throw new Error("Give key, delta_id or r2_key");
				if (include_html && htmlKey) out.html = (await (await env.FILES.get(htmlKey))?.text()) ?? null;
				const s = JSON.stringify(out, null, 1);
				if (s.length <= max_chars && offset === 0) return { content: [{ type: "text", text: s }] };
				const next = offset + max_chars < s.length ? offset + max_chars : null;
				return { content: [{ type: "text", text: JSON.stringify({ part_of_json: true, offset, next_offset: next, total_chars: s.length }) }, { type: "text", text: s.slice(offset, offset + max_chars) }] };
			}),
	);
}
