// D1 and R2 stand-ins for the collector tests: D1 over node:sqlite, R2 over a Map.

import { DatabaseSync } from "node:sqlite";

class Stmt {
	constructor(
		private db: DatabaseSync,
		private sql: string,
		private params: unknown[] = [],
	) {}
	bind(...p: unknown[]) {
		return new Stmt(this.db, this.sql, p);
	}
	async all<T>() {
		return { results: this.db.prepare(this.sql).all(...(this.params as never[])) as T[] };
	}
	async first<T>() {
		return (this.db.prepare(this.sql).get(...(this.params as never[])) as T) ?? null;
	}
	async run() {
		return this.exec();
	}
	exec() {
		const r = this.db.prepare(this.sql).run(...(this.params as never[]));
		return { meta: { rows_written: Number(r.changes), changes: Number(r.changes) } };
	}
}

export function fakeEnv() {
	const sql = new DatabaseSync(":memory:");
	const DB = {
		prepare: (q: string) => new Stmt(sql, q),
		batch: async (stmts: Stmt[]) => stmts.map((s) => s.exec()),
	};
	type Obj = { body: string; bytes: Uint8Array; uploaded: Date; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> };
	const objects = new Map<string, Obj>();
	const toBytes = (v: unknown): Uint8Array => (typeof v === "string" ? new TextEncoder().encode(v) : v instanceof Uint8Array ? v.slice() : new Uint8Array(v as ArrayBuffer));
	const view = (o: Obj) => ({ size: o.bytes.byteLength, uploaded: o.uploaded, httpMetadata: o.httpMetadata, customMetadata: o.customMetadata });
	/** Multipart uploads like R2: all parts except the last must have the same size. */
	const uploads: { parts: number[]; aborted: boolean }[] = [];
	const FILES = {
		put: async (k: string, v: unknown, opts?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }) => {
			const bytes = toBytes(v);
			objects.set(k, { body: typeof v === "string" ? v : "bin", bytes, uploaded: new Date(), ...opts });
		},
		get: async (k: string, opts?: { range?: { offset?: number; length?: number } }) => {
			const o = objects.get(k);
			if (!o) return null;
			const from = opts?.range?.offset ?? 0;
			const part = o.bytes.subarray(from, opts?.range?.length === undefined ? undefined : from + opts.range.length);
			return { ...view(o), text: async () => (o.body === "bin" ? new TextDecoder().decode(part) : o.body), body: new Response(part).body };
		},
		head: async (k: string) => {
			const o = objects.get(k);
			return o ? view(o) : null;
		},
		list: async () => ({ objects: [...objects.keys()].map((key) => ({ key })), truncated: false }),
		delete: async (keys: string[]) => {
			for (const k of keys) objects.delete(k);
		},
		createMultipartUpload: async (k: string, opts?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }) => {
			const chunks = new Map<number, Uint8Array>();
			const up = { parts: [] as number[], aborted: false };
			uploads.push(up);
			return {
				uploadPart: async (n: number, v: Uint8Array) => {
					chunks.set(n, toBytes(v));
					up.parts.push(v.byteLength);
					return { partNumber: n, etag: `p${n}` };
				},
				complete: async (parts: { partNumber: number }[]) => {
					const list = parts.map((p) => chunks.get(p.partNumber) as Uint8Array);
					if (list.slice(0, -1).some((c) => c.byteLength !== list[0].byteLength)) throw new Error("parts must have equal size");
					const bytes = new Uint8Array(list.reduce((a, c) => a + c.byteLength, 0));
					let at = 0;
					for (const c of list) {
						bytes.set(c, at);
						at += c.byteLength;
					}
					objects.set(k, { body: "bin", bytes, uploaded: new Date(), ...opts });
				},
				abort: async () => {
					up.aborted = true;
				},
			};
		},
	};
	return { env: { DB, FILES } as unknown as Env, sql, objects, uploads };
}
