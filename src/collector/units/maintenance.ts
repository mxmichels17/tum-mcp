// Unit "maintenance": removes the PDF texts that 0.7.0 to 0.7.5 made with Workers AI (0.7.6). The collector
// gives only files, links and R2 keys; the watcher reads every PDF itself. The unit deletes the `.txt`
// objects in R2 and the fields `text` and `text_error` of stored file entries in items and in deltas that
// collector_run has not returned yet. The hash of each item is computed again, so no delta is created.
// It works in steps (cursors in state) and is idle once all three steps are done. Running it again is harmless.

import { type Change, type Content, itemHash, type Json } from "../model";
import { getState, runBatches, setState } from "../store";
import type { UnitCtx } from "../unit";

export const MAINTENANCE_DONE = "maintenance:pdftext:done";
const CURSORS = "maintenance:pdftext:cursors";
const BATCH = 150;

interface Cursors {
	r2?: string | "done";
	items?: string | "done";
	deltas?: number | "done";
}

/** A file entry: an object with r2_key and mime_type. */
const isFile = (o: Record<string, Json>) => "r2_key" in o && "mime_type" in o;

/** Removes `text` and `text_error` from every file entry in a content tree. Returns the new tree and whether it changed. */
export function stripFileTexts(v: Json): { value: Json; changed: boolean } {
	if (Array.isArray(v)) {
		let changed = false;
		const value = v.map((x) => {
			const r = stripFileTexts(x);
			changed ||= r.changed;
			return r.value;
		});
		return { value, changed };
	}
	if (v === null || typeof v !== "object") return { value: v, changed: false };
	let changed = false;
	const out: Record<string, Json> = {};
	const file = isFile(v);
	for (const [k, x] of Object.entries(v)) {
		if (file && (k === "text" || k === "text_error")) {
			changed = true;
			continue;
		}
		const r = stripFileTexts(x);
		changed ||= r.changed;
		out[k] = r.value;
	}
	return { value: out, changed };
}

/** Change entries that only describe a PDF text of a file entry. */
export const isFileTextChange = (c: Change) => /(?:attachments\[\d+\]|\.file|files\[\d+\])\.(?:text|text_error)$/.test(c.field);

/** Contents over 400 kB live in R2 (store.pack); D1 holds {"$r2": key}. Reads and writes either form. */
async function readContent(env: Env, raw: string): Promise<{ value: Json; r2?: string }> {
	const v = JSON.parse(raw) as Json;
	if (v && typeof v === "object" && !Array.isArray(v) && typeof v.$r2 === "string") {
		const o = await env.FILES.get(v.$r2);
		return o ? { value: JSON.parse(await o.text()) as Json, r2: v.$r2 } : { value: null };
	}
	return { value: v };
}

/** The D1 value after the change: the same pointer for contents in R2 (the object is rewritten), else the JSON. */
async function writeContent(env: Env, raw: string, c: { r2?: string }, value: Json): Promise<string> {
	if (!c.r2) return JSON.stringify(value);
	await env.FILES.put(c.r2, JSON.stringify(value), { httpMetadata: { contentType: "application/json" } });
	return raw;
}

const TIME_MS = 20_000;

export async function unitMaintenance(ctx: UnitCtx): Promise<void> {
	const { env } = ctx;
	if (await getState<boolean>(env.DB, MAINTENANCE_DONE)) return;
	const started = Date.now();
	const cur = (await getState<Cursors>(env.DB, CURSORS)) ?? {};
	let r2Deleted = 0;
	let itemsFixed = 0;
	let deltasFixed = 0;

	// 1. R2: the .txt objects next to the files.
	while (cur.r2 !== "done" && Date.now() - started < TIME_MS) {
		const l = await env.FILES.list({ prefix: "files/", cursor: cur.r2 || undefined, limit: 1000 });
		const txt = l.objects.map((o) => o.key).filter((k) => k.endsWith(".txt"));
		if (txt.length) await env.FILES.delete(txt);
		r2Deleted += txt.length;
		cur.r2 = l.truncated ? l.cursor : "done";
	}

	// 2. Items with file entries: content without the texts and a new hash, no delta.
	while (cur.items !== "done" && Date.now() - started < TIME_MS) {
		const rows = (
			await env.DB.prepare("SELECT key, title, url, content FROM items WHERE key > ? AND (content LIKE '%\"r2_key\"%' OR content LIKE '{\"$r2\"%') ORDER BY key LIMIT ?")
				.bind(cur.items ?? "", BATCH)
				.all<{ key: string; title: string; url: string; content: string }>()
		).results;
		const stmts: D1PreparedStatement[] = [];
		for (const r of rows) {
			const c = await readContent(env, r.content);
			const s = stripFileTexts(c.value);
			if (!s.changed) continue;
			const content = s.value as Content;
			stmts.push(env.DB.prepare("UPDATE items SET content = ?, hash = ? WHERE key = ?").bind(await writeContent(env, r.content, c, content), itemHash({ title: r.title, url: r.url, content }), r.key));
		}
		await runBatches(env.DB, stmts);
		itemsFixed += stmts.length;
		cur.items = rows.length < BATCH ? "done" : rows[rows.length - 1].key;
	}

	// 3. Deltas not returned yet: the same in their content and their change list.
	const delivered = (await getState<number>(env.DB, "delivered")) ?? 0;
	while (cur.deltas !== "done" && Date.now() - started < TIME_MS) {
		const from = Math.max(typeof cur.deltas === "number" ? cur.deltas : 0, delivered);
		const rows = (
			await env.DB.prepare("SELECT id, content, changes FROM deltas WHERE id > ? AND (content LIKE '%\"r2_key\"%' OR content LIKE '{\"$r2\"%') ORDER BY id LIMIT ?")
				.bind(from, BATCH)
				.all<{ id: number; content: string; changes: string | null }>()
		).results;
		const stmts: D1PreparedStatement[] = [];
		for (const r of rows) {
			const c = await readContent(env, r.content);
			const s = stripFileTexts(c.value);
			const changes = r.changes ? (JSON.parse(r.changes) as Change[]) : null;
			const kept = changes?.filter((x) => !isFileTextChange(x)).map((x) => ({ ...x, old: stripFileTexts(x.old).value, new: stripFileTexts(x.new).value }));
			const changesChanged = !!changes && JSON.stringify(kept) !== JSON.stringify(changes);
			if (!s.changed && !changesChanged) continue;
			stmts.push(env.DB.prepare("UPDATE deltas SET content = ?, changes = ? WHERE id = ?").bind(await writeContent(env, r.content, c, s.value), kept ? JSON.stringify(kept) : null, r.id));
		}
		await runBatches(env.DB, stmts);
		deltasFixed += stmts.length;
		cur.deltas = rows.length < BATCH ? "done" : rows[rows.length - 1].id;
	}

	await setState(env.DB, CURSORS, cur);
	const done = cur.r2 === "done" && cur.items === "done" && cur.deltas === "done";
	if (done) await setState(env.DB, MAINTENANCE_DONE, true);
	ctx.note(`PDF text clean-up: ${r2Deleted} .txt objects deleted, ${itemsFixed} items and ${deltasFixed} deltas cleaned${done ? ", done" : ", goes on next run"}`);
}
