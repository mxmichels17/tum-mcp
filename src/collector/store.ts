// Collector store. D1 "tum-mcp" (binding DB) keeps the last state of every item and the delta log.
// R2 "tum-files" (binding FILES) keeps web page HTML, files and contents too large for one D1 row.
// Tables are created on first use. Free plan: D1 allows 100,000 written rows per day, so unchanged items
// are only rewritten when they were read again in rotation.

import { type Change, type Content, computeChanges, type Entry, hash64, type Item, itemHash, type Json, type ScopeResult } from "./model";

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS items (
		key TEXT PRIMARY KEY, source TEXT NOT NULL, scope TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
		sig TEXT, hash TEXT NOT NULL, win TEXT, content TEXT NOT NULL, html_key TEXT,
		first_seen TEXT NOT NULL, changed_at TEXT NOT NULL, read_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'present')`,
	"CREATE INDEX IF NOT EXISTS items_scope ON items(scope)",
	`CREATE TABLE IF NOT EXISTS deltas (
		id INTEGER PRIMARY KEY AUTOINCREMENT, item_key TEXT NOT NULL, source TEXT NOT NULL, scope TEXT NOT NULL, type TEXT NOT NULL,
		title TEXT NOT NULL, url TEXT NOT NULL, content TEXT NOT NULL, changes TEXT, html_key TEXT, detected_at TEXT NOT NULL)`,
	"CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)",
	`CREATE TABLE IF NOT EXISTS unit_runs (
		unit TEXT PRIMARY KEY, state TEXT NOT NULL, detail TEXT, last_run TEXT NOT NULL, last_ok TEXT, duration_ms INTEGER,
		entries INTEGER, loaded INTEGER, deltas INTEGER, pending INTEGER, subrequests INTEGER)`,
];

/** Per D1 binding, so tests with several databases in one isolate work. */
const schemaReady = new WeakSet<object>();

/** Creates the collector tables when they are missing. It never drops or deletes anything. */
export async function ensureSchema(db: D1Database): Promise<void> {
	if (schemaReady.has(db)) return;
	await db.batch(SCHEMA.map((q) => db.prepare(q)));
	schemaReady.add(db);
}

// ---------- small state ----------

export async function getState<T>(db: D1Database, key: string): Promise<T | undefined> {
	const r = await db.prepare("SELECT value FROM state WHERE key = ?").bind(key).first<{ value: string }>();
	return r ? (JSON.parse(r.value) as T) : undefined;
}

export function setStateStmt(db: D1Database, key: string, value: unknown): D1PreparedStatement {
	return db
		.prepare("INSERT INTO state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
		.bind(key, JSON.stringify(value), new Date().toISOString());
}

export async function setState(db: D1Database, key: string, value: unknown): Promise<void> {
	await setStateStmt(db, key, value).run();
}

/** Runs statements in batches and counts the rows D1 wrote (for the daily write budget). */
export async function runBatches(db: D1Database, stmts: D1PreparedStatement[], size = 50): Promise<number> {
	let written = 0;
	for (let i = 0; i < stmts.length; i += size) {
		const res = await db.batch(stmts.slice(i, i + size));
		for (const r of res) written += Number(r.meta?.rows_written ?? 0);
	}
	return written;
}

// ---------- budgets ----------

/** D1 Free plan: 100,000 written rows per day (UTC). The collector stops loading at this mark. */
export const DAILY_WRITE_BUDGET = 80_000;

export const today = () => new Date().toISOString().slice(0, 10);

export async function writesToday(db: D1Database): Promise<number> {
	return (await getState<number>(db, `writes:${today()}`)) ?? 0;
}

export async function addWrites(db: D1Database, n: number): Promise<void> {
	if (!n) return;
	await db
		.prepare("INSERT INTO state (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(state.value AS INTEGER) + ?2 AS TEXT), updated_at = ?3")
		.bind(`writes:${today()}`, String(n), new Date().toISOString())
		.run();
}

/** Limits of one unit invocation: loads (each costs one or more requests), external requests and time. */
export interface Budget {
	canLoad(): boolean;
	loaded(): void;
	/** External fetch() calls so far in this invocation. */
	used(): number;
}

// ---------- content packing ----------

/** Contents above this size go to R2; D1 keeps a pointer. D1 rows are limited to 2 MB. */
const MAX_INLINE = 400_000;

async function pack(env: Env, key: string, content: Content, hash: string): Promise<string> {
	const s = JSON.stringify(content);
	if (s.length <= MAX_INLINE) return s;
	const r2 = `content/${hash64(key)}/${hash}.json`;
	await env.FILES.put(r2, s, { httpMetadata: { contentType: "application/json" } });
	return JSON.stringify({ $r2: r2, size: s.length });
}

export async function unpack(env: Env, stored: string): Promise<Content> {
	const v = JSON.parse(stored) as Content;
	if (typeof v.$r2 === "string" && Object.keys(v).length <= 2) {
		const o = await env.FILES.get(v.$r2);
		if (!o) return { $missing: `R2 object ${v.$r2} not found` };
		return JSON.parse(await o.text()) as Content;
	}
	return v;
}

async function putHtml(env: Env, key: string, html: string): Promise<string> {
	const r2 = `html/${hash64(key)}/${hash64(html)}.html`;
	await env.FILES.put(r2, html, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
	return r2;
}

// ---------- scope ----------

/**
 * Deletes items that are outside the collection scope, and their deltas that collector_run has not
 * returned yet. They never appear in the output, neither as new nor as removed.
 */
export async function forget(env: Env, keys: string[]): Promise<number> {
	if (!keys.length) return 0;
	const delivered = (await getState<number>(env.DB, "delivered")) ?? 0;
	const stmts: D1PreparedStatement[] = [];
	for (let i = 0; i < keys.length; i += 90) {
		const part = keys.slice(i, i + 90);
		const q = part.map(() => "?").join(",");
		stmts.push(env.DB.prepare(`DELETE FROM deltas WHERE id > ? AND item_key IN (${q})`).bind(delivered, ...part));
		stmts.push(env.DB.prepare(`DELETE FROM items WHERE key IN (${q})`).bind(...part));
	}
	return runBatches(env.DB, stmts);
}

/** Keys of stored items that match a SQL condition on the items table (used for scope clean-up). */
export async function storedKeys(db: D1Database, where: string, ...params: unknown[]): Promise<string[]> {
	return (await db.prepare(`SELECT key FROM items WHERE ${where}`).bind(...params).all<{ key: string }>()).results.map((r) => r.key);
}

/**
 * Forgets everything stored for courses outside the scope: items in the listings named by `scopes(id)`
 * and items of `source` whose content has that course_id. Returns the number of forgotten items.
 */
export async function forgetCourses(env: Env, source: string, ids: (string | number)[], scopes: (id: string | number) => string[]): Promise<number> {
	let n = 0;
	for (let i = 0; i < ids.length; i += 20) {
		const part = ids.slice(i, i + 20);
		const names = part.flatMap(scopes);
		const keys = await storedKeys(
			env.DB,
			`scope IN (${names.map(() => "?").join(",")}) OR (source = ? AND json_valid(content) AND CAST(json_extract(content, '$.course_id') AS TEXT) IN (${part.map(() => "?").join(",")}))`,
			...names,
			source,
			...part.map(String),
		);
		await forget(env, keys);
		n += keys.length;
	}
	return n;
}

/**
 * Removes the bookkeeping of courses outside the scope, so `collector_run` lists only work inside it:
 * the pending markers of the course listings (`pending:<prefix><id>`), of the folder and forum listings
 * found on its pages (from `<subPrefix><id>`, Moodle only) and its row in unit_runs. Folder and forum
 * markers that no course in scope names are removed too. Returns the number of removed rows.
 */
export async function dropStaleCourseState(
	env: Env,
	o: { keep: (string | number)[]; listingPrefixes: string[]; unitPrefix: string; subPrefix?: string; subListingPrefixes?: string[] },
): Promise<number> {
	const keep = new Set(o.keep.map(String));
	const stmts: D1PreparedStatement[] = [];
	const del = (key: string) => stmts.push(env.DB.prepare("DELETE FROM state WHERE key = ?").bind(key));
	const tail = (key: string, prefix: string) => key.slice(prefix.length);
	const like = async (prefix: string) =>
		(await env.DB.prepare("SELECT key, value FROM state WHERE substr(key, 1, ?) = ?").bind(prefix.length, prefix).all<{ key: string; value: string }>()).results;
	for (const lp of o.listingPrefixes) for (const r of await like(`pending:${lp}`)) if (!keep.has(tail(r.key, `pending:${lp}`))) del(r.key);
	if (o.subPrefix && o.subListingPrefixes?.length) {
		const live = new Set<string>();
		for (const r of await like(o.subPrefix)) {
			const sub = JSON.parse(r.value) as { folders?: Record<string, unknown>; forums?: Record<string, unknown> };
			const cmids = [...Object.keys(sub.folders ?? {}), ...Object.keys(sub.forums ?? {})];
			if (keep.has(tail(r.key, o.subPrefix))) for (const c of cmids) live.add(c);
			else del(r.key);
		}
		for (const lp of o.subListingPrefixes) for (const r of await like(`pending:${lp}`)) if (!live.has(tail(r.key, `pending:${lp}`))) del(r.key);
	}
	const units = (await env.DB.prepare("SELECT unit FROM unit_runs WHERE substr(unit, 1, ?) = ?").bind(o.unitPrefix.length, o.unitPrefix).all<{ unit: string }>()).results;
	for (const u of units) if (!keep.has(tail(u.unit, o.unitPrefix))) stmts.push(env.DB.prepare("DELETE FROM unit_runs WHERE unit = ?").bind(u.unit));
	await runBatches(env.DB, stmts);
	return stmts.length;
}

// ---------- applying one listing ----------

interface StoredRow {
	key: string;
	scope: string;
	sig: string | null;
	hash: string;
	win: string | null;
	read_at: string;
	status: string;
}

export interface Stored {
	key: string;
	title: string;
	url: string;
	content: Content;
	html_key: string | null;
}

export interface ApplyResult {
	scope: string;
	entries: number;
	loaded: number;
	unchanged: number;
	pending: number;
	new: number;
	changed: number;
	removed: number;
	errors: string[];
	written: number;
}

/** Thrown by a load that ran out of budget halfway. The entry stays pending. */
export class Deferred extends Error {}

async function loadStored(env: Env, keys: string[]): Promise<Map<string, Stored>> {
	const out = new Map<string, Stored>();
	for (let i = 0; i < keys.length; i += 90) {
		const part = keys.slice(i, i + 90);
		const rows = await env.DB.prepare(`SELECT key, title, url, content, html_key FROM items WHERE key IN (${part.map(() => "?").join(",")})`)
			.bind(...part)
			.all<{ key: string; title: string; url: string; content: string; html_key: string | null }>();
		for (const r of rows.results) out.set(r.key, { key: r.key, title: r.title, url: r.url, content: await unpack(env, r.content), html_key: r.html_key });
	}
	return out;
}

/** Stored item of a key (for loads that reuse a stored file). */
export async function storedItem(env: Env, key: string): Promise<Stored | undefined> {
	return (await loadStored(env, [key])).get(key);
}

function deltaStmt(env: Env, d: { key: string; source: string; scope: string; type: "new" | "changed" | "removed"; title: string; url: string; content: string; changes?: Change[]; html_key: string | null; at: string }) {
	return env.DB.prepare("INSERT INTO deltas (item_key, source, scope, type, title, url, content, changes, html_key, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(
		d.key,
		d.source,
		d.scope,
		d.type,
		d.title,
		d.url,
		d.content,
		d.changes ? JSON.stringify(d.changes) : null,
		d.html_key,
		d.at,
	);
}

/**
 * Compares one listing with the stored state, loads new and due entries within the budget, writes the
 * items and one delta row per new, changed or removed item.
 */
export async function applyScope(env: Env, budget: Budget, r: ScopeResult): Promise<ApplyResult> {
	const db = env.DB;
	const now = new Date().toISOString();
	const res: ApplyResult = { scope: r.scope, entries: 0, loaded: 0, unchanged: 0, pending: 0, new: 0, changed: 0, removed: 0, errors: [], written: 0 };
	const seen = new Set<string>();
	const entries: Entry[] = [];
	for (const e of r.entries) {
		if (seen.has(e.key)) continue;
		seen.add(e.key);
		entries.push(e);
	}
	res.entries = entries.length;
	// Keys are unique per scope (a mail key holds its folder), so an item that moves shows up as removed
	// in the old scope and new in the new one.
	const stored = new Map((await db.prepare("SELECT key, scope, sig, hash, win, read_at, status FROM items WHERE scope = ?").bind(r.scope).all<StoredRow>()).results.map((x) => [x.key, x]));
	if (r.outOfScope?.length) {
		const out = new Set(r.outOfScope);
		const drop = [...stored.keys()].filter((k) => out.has(k));
		res.written += await forget(env, drop);
		for (const k of drop) stored.delete(k);
	}
	// Work order: complete items, then new entries, then entries with a new sig, then the rotation (oldest read first).
	const isNew = (e: Entry) => !stored.has(e.key) || stored.get(e.key)?.status !== "present";
	const inline = entries.filter((e) => e.item);
	const fresh = entries.filter((e) => !e.item && isNew(e));
	const resig = entries.filter((e) => !e.item && !isNew(e) && e.sig !== undefined && e.sig !== stored.get(e.key)?.sig);
	const rotation = entries
		.filter((e) => !e.item && !isNew(e) && e.sig === undefined)
		.sort((a, b) => (stored.get(a.key)?.read_at ?? "").localeCompare(stored.get(b.key)?.read_at ?? ""));
	res.unchanged = entries.filter((e) => !e.item && !isNew(e) && e.sig !== undefined && e.sig === stored.get(e.key)?.sig).length;

	const loadedItems: { e: Entry; item: Item }[] = [];
	for (const e of inline) loadedItems.push({ e, item: e.item as Item });
	for (const e of [...fresh, ...resig, ...rotation]) {
		if (!budget.canLoad()) {
			res.pending++;
			continue;
		}
		budget.loaded();
		try {
			loadedItems.push({ e, item: await (e.load as () => Promise<Item>)() });
			res.loaded++;
		} catch (err) {
			if (err instanceof Deferred) res.pending++;
			else res.errors.push(`${e.key}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	// Rotation entries that were not reached are not pending work: they are only due for a re-read.
	res.pending = Math.min(res.pending, fresh.length + resig.length);

	// An item read here can be stored under another scope (for example a forum discussion first found through
	// a notification). It is looked up by key, so it is not reported as new again.
	const foreign = loadedItems.map(({ item }) => item.key).filter((k) => !stored.has(k));
	for (let i = 0; i < foreign.length; i += 90) {
		const part = foreign.slice(i, i + 90);
		const rows = await db.prepare(`SELECT key, scope, sig, hash, win, read_at, status FROM items WHERE key IN (${part.map(() => "?").join(",")})`).bind(...part).all<StoredRow>();
		for (const x of rows.results) stored.set(x.key, x);
	}

	// Old contents for change rows.
	const hashes = new Map(loadedItems.map(({ item }) => [item.key, itemHash(item)]));
	const changedKeys = loadedItems.filter(({ item }) => {
		const s = stored.get(item.key);
		return s && s.status === "present" && s.hash !== hashes.get(item.key);
	});
	const before = await loadStored(
		env,
		changedKeys.map(({ item }) => item.key),
	);

	const stmts: D1PreparedStatement[] = [];
	for (const { e, item } of loadedItems) {
		const s = stored.get(item.key);
		const hash = hashes.get(item.key) as string;
		const present = s?.status === "present";
		if (present && s.hash === hash) {
			// Unchanged. Inline items are not rewritten; loaded ones store the read time (rotation) and the sig.
			if (e.item && s.sig === (e.sig ?? null) && s.win === (e.window ?? null) && s.scope === r.scope) continue;
			stmts.push(db.prepare("UPDATE items SET read_at = ?, sig = ?, win = ?, scope = ? WHERE key = ?").bind(now, e.sig ?? null, e.window ?? null, r.scope, item.key));
			continue;
		}
		const packed = await pack(env, item.key, item.content, hash);
		const htmlKey = item.html ? await putHtml(env, item.key, item.html) : null;
		stmts.push(
			db
				.prepare(
					`INSERT INTO items (key, source, scope, title, url, sig, hash, win, content, html_key, first_seen, changed_at, read_at, status)
					 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, ?11, 'present')
					 ON CONFLICT(key) DO UPDATE SET source = ?2, scope = ?3, title = ?4, url = ?5, sig = ?6, hash = ?7, win = ?8, content = ?9,
					 html_key = COALESCE(?10, items.html_key), changed_at = ?11, read_at = ?11, status = 'present'`,
				)
				.bind(item.key, item.source, r.scope, item.title, item.url, e.sig ?? null, hash, e.window ?? null, packed, htmlKey, now),
		);
		if (present) {
			const old = before.get(item.key);
			const changes = old ? computeChanges(old, item) : [];
			stmts.push(deltaStmt(env, { key: item.key, source: item.source, scope: r.scope, type: "changed", title: item.title, url: item.url, content: packed, changes, html_key: htmlKey ?? old?.html_key ?? null, at: now }));
			res.changed++;
		} else {
			stmts.push(deltaStmt(env, { key: item.key, source: item.source, scope: r.scope, type: "new", title: item.title, url: item.url, content: packed, html_key: htmlKey, at: now }));
			res.new++;
		}
	}

	if (r.complete) {
		const gone = [...stored.values()].filter((s) => s.status === "present" && !seen.has(s.key) && (r.windowFrom === undefined || s.win === null || s.win >= r.windowFrom));
		// Only rows of this scope can be removed by it.
		const own = new Set((await db.prepare("SELECT key FROM items WHERE scope = ? AND status = 'present'").bind(r.scope).all<{ key: string }>()).results.map((x) => x.key));
		const removed = gone.filter((g) => own.has(g.key));
		for (let i = 0; i < removed.length; i += 90) {
			const part = removed.slice(i, i + 90).map((g) => g.key);
			const rows = await db
				.prepare(`SELECT key, source, title, url, content, html_key FROM items WHERE key IN (${part.map(() => "?").join(",")})`)
				.bind(...part)
				.all<{ key: string; source: string; title: string; url: string; content: string; html_key: string | null }>();
			const outside: string[] = [];
			for (const x of rows.results) {
				if (r.outOfScopeContent?.(await unpack(env, x.content))) {
					outside.push(x.key);
					continue;
				}
				stmts.push(db.prepare("UPDATE items SET status = 'removed', changed_at = ? WHERE key = ?").bind(now, x.key));
				stmts.push(deltaStmt(env, { key: x.key, source: x.source, scope: r.scope, type: "removed", title: x.title, url: x.url, content: x.content, html_key: x.html_key, at: now }));
				res.removed++;
			}
			res.written += await forget(env, outside);
		}
	}
	if (res.pending || ((await getState<number>(db, `pending:${r.scope}`)) ?? 0) > 0) stmts.push(setStateStmt(db, `pending:${r.scope}`, res.pending));
	res.written += await runBatches(db, stmts);
	return res;
}

// ---------- reading ----------

export interface DeltaRow {
	id: number;
	item_key: string;
	source: string;
	scope: string;
	type: string;
	title: string;
	url: string;
	content: string;
	changes: string | null;
	html_key: string | null;
	detected_at: string;
}

export async function deltaRows(db: D1Database, after: number, limit: number): Promise<DeltaRow[]> {
	return (await db.prepare("SELECT * FROM deltas WHERE id > ? ORDER BY id LIMIT ?").bind(after, limit).all<DeltaRow>()).results;
}

export async function deltaRow(db: D1Database, id: number): Promise<DeltaRow | undefined> {
	return (await db.prepare("SELECT * FROM deltas WHERE id = ?").bind(id).first<DeltaRow>()) ?? undefined;
}

export interface DeltaOut {
	id: number;
	type: string;
	source: string;
	key: string;
	title: string;
	url: string;
	detected_at: string;
	content: Content | { $truncated: true; size: number; get_with: string };
	changes?: Change[] | { $truncated: true; size: number; get_with: string };
	html_stored: boolean;
}

export async function deltaOut(env: Env, d: DeltaRow): Promise<DeltaOut> {
	return {
		id: d.id,
		type: d.type,
		source: d.source,
		key: d.item_key,
		title: d.title,
		url: d.url,
		detected_at: d.detected_at,
		content: await unpack(env, d.content),
		...(d.changes ? { changes: JSON.parse(d.changes) as Change[] } : {}),
		html_stored: !!d.html_key,
	};
}

export type { Json };
