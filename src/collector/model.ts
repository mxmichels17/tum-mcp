// Collector data model and the pure change computation. The collector stores what a source shows and
// reports what changed since the last run. It never names, rates, plans or decides anything.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Content = { [k: string]: Json };

/** A file stored in R2 (bucket tum-files), or only linked when it is a video or larger than 100 MB. */
export interface FileRef {
	name: string;
	mime_type: string | null;
	size: number | null;
	/** Where the file is on the platform. */
	url: string;
	/** R2 key of the stored copy. Null when the file was not stored (see `not_stored`). */
	r2_key: string | null;
	not_stored?: string;
}

/** One collected item: everything the source shows for it, with a link to the original. */
export interface Item {
	key: string;
	source: string;
	url: string;
	title: string;
	content: Content;
	/** Web pages: the raw HTML, stored in R2 and returned by collector_item. Not part of the change check. */
	html?: string;
}

/**
 * One entry of a listing. `item` is complete at once; `load` reads it (one or more requests).
 * `sig` is a version mark from the listing (revision, timestamp, edit count). An entry with an unchanged
 * sig is not loaded again. Entries without sig are loaded again in rotation (oldest read first).
 */
export interface Entry {
	key: string;
	sig?: string;
	/** Sort key of the read window (date or padded id). See ScopeResult.windowFrom. */
	window?: string;
	item?: Item;
	load?: () => Promise<Item>;
}

export interface ScopeResult {
	/** Unique name of the listing, for example "moodle:course:123" or "mail:INBOX". */
	scope: string;
	/** True when the listing shows every current entry: stored entries that are missing are reported as removed. */
	complete: boolean;
	/** Only stored entries with window >= windowFrom count as removed (the read covered only that range). */
	windowFrom?: string;
	entries: Entry[];
	/** Keys outside the collection scope (for example mails before the date limit). Stored ones are forgotten, never reported. */
	outOfScope?: string[];
	/** A stored item that is gone from the listing is forgotten instead of reported as removed when this is true for its content. */
	outOfScopeContent?: (content: Content) => boolean;
}

/** Stable JSON with sorted keys, for hashes. */
export function stableStringify(v: unknown): string {
	if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
	if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
	const o = v as Record<string, unknown>;
	return `{${Object.keys(o)
		.filter((k) => o[k] !== undefined)
		.sort()
		.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
		.join(",")}}`;
}

/** 64-bit FNV-1a as 16 hex characters. Not cryptographic, only for change checks and keys. */
export function hash64(s: string): string {
	let h1 = 0x811c9dc5;
	let h2 = 0x01000193;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 0x01000193);
		h2 = Math.imul(h2 ^ c, 0x5bd1e995) ^ (h2 >>> 15);
	}
	return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

export function itemHash(it: Pick<Item, "title" | "url" | "content">): string {
	return hash64(stableStringify({ title: it.title, url: it.url, content: it.content }));
}

/** Path to scalar value. Arrays use the index, objects the key: "files[0].name". */
export function flatten(v: Json | undefined, prefix = "", out = new Map<string, Json>()): Map<string, Json> {
	if (v === null || v === undefined || typeof v !== "object") {
		out.set(prefix, v ?? null);
		return out;
	}
	if (Array.isArray(v)) {
		if (!v.length) out.set(prefix, []);
		v.forEach((x, i) => flatten(x, `${prefix}[${i}]`, out));
		return out;
	}
	const keys = Object.keys(v);
	if (!keys.length) out.set(prefix, {});
	for (const k of keys) flatten(v[k], prefix ? `${prefix}.${k}` : k, out);
	return out;
}

export interface Change {
	field: string;
	old: Json;
	new: Json;
	/** Long texts: only the changed lines, with their line numbers (1-based) in the old and the new text. */
	old_lines?: string;
	new_lines?: string;
}

const LONG_TEXT = 400;

/** The lines between the common start and the common end of two texts. */
export function changedLines(a: string, b: string): { old: string; new: string; old_lines: string; new_lines: string } {
	const x = a.split("\n");
	const y = b.split("\n");
	let s = 0;
	while (s < x.length && s < y.length && x[s] === y[s]) s++;
	let e = 0;
	while (e < x.length - s && e < y.length - s && x[x.length - 1 - e] === y[y.length - 1 - e]) e++;
	const range = (n: number) => (n - e > s ? `${s + 1}-${n - e}` : `${s + 1} (none)`);
	return { old: x.slice(s, x.length - e).join("\n"), new: y.slice(s, y.length - e).join("\n"), old_lines: range(x.length), new_lines: range(y.length) };
}

/** Every changed field with its old and new value. Long texts show only the changed lines. */
export function computeChanges(before: { title: string; url: string; content: Content }, after: { title: string; url: string; content: Content }): Change[] {
	const a = flatten({ title: before.title, url: before.url, content: before.content });
	const b = flatten({ title: after.title, url: after.url, content: after.content });
	const out: Change[] = [];
	for (const field of new Set([...a.keys(), ...b.keys()])) {
		const o = a.has(field) ? (a.get(field) as Json) : null;
		const n = b.has(field) ? (b.get(field) as Json) : null;
		if (stableStringify(o) === stableStringify(n)) continue;
		if (typeof o === "string" && typeof n === "string" && (o.length > LONG_TEXT || n.length > LONG_TEXT) && (o.includes("\n") || n.includes("\n"))) {
			const d = changedLines(o, n);
			out.push({ field, old: d.old, new: d.new, old_lines: d.old_lines, new_lines: d.new_lines });
		} else {
			out.push({ field, old: o, new: n });
		}
	}
	return out;
}

/** Plain JSON copy (drops undefined, turns Dates into strings). */
export function toJson(v: unknown): Json {
	return v === undefined ? null : (JSON.parse(JSON.stringify(v)) as Json);
}

/** Videos are never downloaded, only linked. */
export function isVideo(nameOrMime: string): boolean {
	return /^video\//i.test(nameOrMime) || /\.(mp4|m4v|mov|mkv|webm|avi|wmv|flv|mpe?g|3gp)(\?|$)/i.test(nameOrMime);
}

export const MAX_FILE_BYTES = 100 * 1024 * 1024;
