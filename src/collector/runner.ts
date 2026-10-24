// Collector runner. Every unit (one source, or one course of Moodle or Artemis) runs in its own invocation
// through the service binding COLLECTOR, so each unit has its own Free plan budget (50 external
// subrequests, 10 ms CPU). The cron runs all units every 30 minutes; collector_run runs them on request.
// Units that do not finish their first read (large mailboxes, Zulip history, big courses) go on in the
// next runs; the delta then grows run by run.

import { AsyncLocalStorage } from "node:async_hooks";
import { socketHooks } from "../lib/net";
import { LoginError, NotConfiguredError, withTimeout } from "../lib/tools";
import { TokenNotConfirmedError } from "../platforms/tumonline-personal";
import type { ScopeResult } from "./model";
import { type ApplyResult, addWrites, applyScope, type Budget, DAILY_WRITE_BUDGET, ensureSchema, getState, writesToday } from "./store";
import type { Unit, UnitCtx } from "./unit";
import { type ArtemisCourseRef, unitArtemis, unitArtemisCourse } from "./units/artemis";
import { LARGE_QUEUE, type LargeMailJob, unitMail } from "./units/mail";
import { unitMailLarge } from "./units/mail-large";
import { MAINTENANCE_DONE, unitMaintenance } from "./units/maintenance";
import { type MoodleCourseRef, unitMoodle, unitMoodleCourse } from "./units/moodle";
import { unitTumlive } from "./units/other";
import { unitScoreboard } from "./units/scoreboard";
import { forgetRemovedSites, SITES, unitSite } from "./units/sites";
import { unitTumonline, unitTumonlineCourses, unitTumonlineExams } from "./units/tumonline";
import { unitZulip } from "./units/zulip";

export type UnitState = "OK" | "login needed" | "not configured" | "error" | "not started (time limit of this call)";

export interface UnitRun {
	unit: string;
	state: UnitState;
	detail?: string;
	entries: number;
	loaded: number;
	new: number;
	changed: number;
	removed: number;
	pending: number;
	subrequests: number;
	duration_ms: number;
}

/** maxLoads: entries read per invocation (each one or more requests, and CPU for parsing). */
const UNITS: Record<string, { run: Unit; maxLoads: number }> = {
	maintenance: { run: unitMaintenance, maxLoads: 0 },
	mail: { run: unitMail, maxLoads: 15 },
	"mail-large": { run: unitMailLarge, maxLoads: 0 },
	zulip: { run: unitZulip, maxLoads: 0 },
	tumonline: { run: unitTumonline, maxLoads: 0 },
	"tumonline-courses": { run: unitTumonlineCourses, maxLoads: 40 },
	"tumonline-exams": { run: unitTumonlineExams, maxLoads: 0 },
	artemis: { run: unitArtemis, maxLoads: 0 },
	"artemis-course": { run: unitArtemisCourse, maxLoads: 12 },
	moodle: { run: unitMoodle, maxLoads: 10 },
	"moodle-course": { run: unitMoodleCourse, maxLoads: 10 },
	tumlive: { run: unitTumlive, maxLoads: 0 },
	its_scoreboard: { run: unitScoreboard, maxLoads: 20 },
	site: { run: unitSite, maxLoads: 15 },
};

/** Sources a caller can name in collector_run. */
export const SOURCES = ["mail", "zulip", "tumonline", "artemis", "moodle", "tumlive", "its_scoreboard", "sites"] as const;
export type Source = (typeof SOURCES)[number];

const MAX_EXTERNAL = 42;
/** No new load starts after this time, so one slow download still ends before UNIT_TIMEOUT_MS. */
const UNIT_TIME_MS = 25_000;
const UNIT_TIMEOUT_MS = 90_000;
/** A request may make at most 32 Worker invocations (service binding calls). */
const MAX_INVOCATIONS = 30;

// ---------- subrequest counting per invocation ----------

interface Counter {
	fetch: number;
}

const counter = new AsyncLocalStorage<Counter>();
let patched = false;

function patchCounters() {
	if (patched) return;
	patched = true;
	const original = globalThis.fetch;
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		const c = counter.getStore();
		if (c) c.fetch++;
		return original(input, init);
	}) as typeof fetch;
	socketHooks.onConnect = () => {
		const c = counter.getStore();
		if (c) c.fetch++;
	};
}

function classify(e: unknown): { state: UnitState; detail: string } {
	const detail = e instanceof Error ? e.message : String(e);
	if (e instanceof NotConfiguredError) return { state: "not configured", detail };
	if (e instanceof LoginError || e instanceof TokenNotConfirmedError) return { state: "login needed", detail };
	if (/exceeded|cpu|subrequest/i.test(detail)) return { state: "error", detail: `${detail} (Workers Free plan limit)` };
	return { state: "error", detail };
}

async function recordRun(db: D1Database, r: UnitRun): Promise<void> {
	const now = new Date().toISOString();
	await db
		.prepare(
			`INSERT INTO unit_runs (unit, state, detail, last_run, last_ok, duration_ms, entries, loaded, deltas, pending, subrequests)
			 VALUES (?1, ?2, ?3, ?4, CASE WHEN ?2 = 'OK' THEN ?4 END, ?5, ?6, ?7, ?8, ?9, ?10)
			 ON CONFLICT(unit) DO UPDATE SET state = ?2, detail = ?3, last_run = ?4,
			 last_ok = CASE WHEN ?2 = 'OK' THEN ?4 ELSE unit_runs.last_ok END, duration_ms = ?5, entries = ?6, loaded = ?7,
			 deltas = ?8, pending = ?9, subrequests = ?10`,
		)
		.bind(r.unit, r.state, r.detail ?? null, now, r.duration_ms, r.entries, r.loaded, r.new + r.changed + r.removed, r.pending, r.subrequests)
		.run();
}

/** Runs one unit in this invocation: read, compare, store. Never logs secrets (only counts and messages). */
export async function runUnit(env: Env, unit: string): Promise<UnitRun> {
	patchCounters();
	const [name, ...rest] = unit.split(":");
	const def = UNITS[name];
	if (!def) throw new Error(`Unknown collector unit ${unit}`);
	const c: Counter = { fetch: 0 };
	return counter.run(c, async () => {
		const started = Date.now();
		const run: UnitRun = { unit, state: "OK", entries: 0, loaded: 0, new: 0, changed: 0, removed: 0, pending: 0, subrequests: 0, duration_ms: 0 };
		await ensureSchema(env.DB);
		const deadline = started + UNIT_TIME_MS;
		let written = await writesToday(env.DB);
		let loads = 0;
		const budget: Budget = {
			canLoad: () => loads < def.maxLoads && c.fetch < MAX_EXTERNAL && Date.now() < deadline && written < DAILY_WRITE_BUDGET,
			loaded: () => {
				loads++;
			},
			used: () => c.fetch,
		};
		const notes: string[] = [];
		const results: ApplyResult[] = [];
		const ctx: UnitCtx = {
			env,
			budget,
			note: (s) => notes.push(s),
			writesLeft: () => DAILY_WRITE_BUDGET - written,
			apply: async (r: ScopeResult, b?: Budget) => {
				const a = await applyScope(env, b ?? budget, r);
				written += a.written;
				await addWrites(env.DB, a.written);
				results.push(a);
				for (const e of a.errors.slice(0, 5)) notes.push(e);
				if (a.errors.length > 5) notes.push(`${a.scope}: ${a.errors.length - 5} more errors`);
				return a;
			},
		};
		try {
			await withTimeout(def.run(ctx, rest.join(":") || undefined), UNIT_TIMEOUT_MS, unit);
		} catch (e) {
			const k = classify(e);
			run.state = k.state;
			notes.unshift(k.detail);
		}
		if (written >= DAILY_WRITE_BUDGET) notes.push("D1 daily write budget reached: reading goes on tomorrow (UTC)");
		for (const a of results) {
			run.entries += a.entries;
			run.loaded += a.loaded;
			run.new += a.new;
			run.changed += a.changed;
			run.removed += a.removed;
			run.pending += a.pending;
		}
		run.detail = notes.length ? notes.join("; ").slice(0, 2000) : undefined;
		run.subrequests = c.fetch;
		run.duration_ms = Date.now() - started;
		await recordRun(env.DB, run);
		return run;
	});
}

async function lastRuns(db: D1Database): Promise<Map<string, { last_run: string; pending: number }>> {
	const r = await db.prepare("SELECT unit, last_run, pending FROM unit_runs").all<{ unit: string; last_run: string; pending: number }>();
	return new Map(r.results.map((x) => [x.unit, x]));
}

/**
 * Runs the units. Units without TUM SSO run in parallel to the SSO chain. The SSO units (Moodle,
 * TUM-Live, scoreboard) run one after the other, because parallel SSO logins fail. Course units of
 * Moodle and Artemis share the rest of the invocation limit, the least recently run first.
 */
export async function runAll(env: Env, trigger: string, only?: Source[], deadline = Number.POSITIVE_INFINITY): Promise<UnitRun[]> {
	await ensureSchema(env.DB);
	const want = new Set<Source>(only?.length ? only : SOURCES);
	let invocations = 0;
	const one = async (unit: string): Promise<UnitRun> => {
		if (Date.now() > deadline) return { unit, state: "not started (time limit of this call)", entries: 0, loaded: 0, new: 0, changed: 0, removed: 0, pending: 0, subrequests: 0, duration_ms: 0 };
		invocations++;
		try {
			if (env.COLLECTOR) return await env.COLLECTOR.runUnit(unit);
			return await runUnit(env, unit);
		} catch (e) {
			// The whole invocation failed, for example "exceeded CPU" on the Free plan.
			const k = classify(e);
			const run: UnitRun = { unit, state: k.state, detail: `invocation failed: ${k.detail}`, entries: 0, loaded: 0, new: 0, changed: 0, removed: 0, pending: 0, subrequests: 0, duration_ms: 0 };
			await recordRun(env.DB, run);
			return run;
		}
	};
	const repeat = async (unit: string, times: number, more: (r: UnitRun) => Promise<boolean>): Promise<UnitRun[]> => {
		const out: UnitRun[] = [];
		for (let i = 0; i < times; i++) {
			const r = await one(unit);
			out.push(r);
			if (r.state !== "OK" || !(await more(r))) break;
		}
		return out;
	};

	const fixed = 1 + (want.has("mail") ? 6 : 0) + (want.has("zulip") ? 2 : 0) + (want.has("tumonline") ? 3 : 0) + (want.has("artemis") ? 1 : 0) + (want.has("moodle") ? 1 : 0) + (want.has("tumlive") ? 1 : 0) + (want.has("its_scoreboard") ? 1 : 0) + (want.has("sites") ? SITES.length : 0);
	const runsBefore = await lastRuns(env.DB);
	const courseUnits = async (): Promise<string[]> => {
		const moodle = want.has("moodle") ? ((await getState<MoodleCourseRef[]>(env.DB, "moodle:courses")) ?? []).map((c) => `moodle-course:${c.id}`) : [];
		const artemis = want.has("artemis") ? ((await getState<ArtemisCourseRef[]>(env.DB, "artemis:courses")) ?? []).map((c) => `artemis-course:${c.id}`) : [];
		// Least recently run first. On a tie Artemis goes first: it has few courses and would wait behind all Moodle courses.
		return [...artemis, ...moodle].sort((a, b) => (runsBefore.get(a)?.last_run ?? "").localeCompare(runsBefore.get(b)?.last_run ?? ""));
	};

	const direct = async (): Promise<UnitRun[]> => {
		const parts = await Promise.all([
			want.has("tumonline")
				? (async () => {
						const a = await one("tumonline");
						return [a, await one("tumonline-courses"), await one("tumonline-exams")];
					})()
				: [],
			want.has("mail")
				? (async () => {
						const runs = await repeat("mail", 3, async (r) => r.pending > 0);
						// Mails over 25 MB, part by part.
						const queued = async () => ((await getState<LargeMailJob[]>(env.DB, LARGE_QUEUE)) ?? []).length > 0;
						if (await queued()) runs.push(...(await repeat("mail-large", 3, queued)));
						return runs;
					})()
				: [],
			want.has("zulip") ? repeat("zulip", 2, async () => !!(await getState<string | null>(env.DB, "backlog:zulip:history"))) : [],
			want.has("artemis") ? one("artemis").then((r) => [r]) : [],
			// External course websites (config/external-sites.json), one invocation each.
			want.has("sites") ? forgetRemovedSites(env).then(() => Promise.all(SITES.map((site) => one(`site:${site.id}`)))) : [],
		]);
		return parts.flat();
	};
	const sso = async (): Promise<UnitRun[]> => {
		const out: UnitRun[] = [];
		if (want.has("moodle")) out.push(await one("moodle"));
		for (const u of ["tumlive", "its_scoreboard"] as const) if (want.has(u)) out.push(await one(u));
		return out;
	};
	// One-time clean-up (0.7.6) before any unit reads items, so no re-read sees an item half cleaned.
	const pre: UnitRun[] = [];
	if (!(await getState<boolean>(env.DB, MAINTENANCE_DONE))) pre.push(await one("maintenance"));
	const [a, b] = await Promise.all([direct(), sso()]);
	const runs = [...pre, ...a, ...b];
	// Course lists are fresh now. Moodle course units use SSO and run one after the other; Artemis ones too.
	const courses = (await courseUnits()).slice(0, Math.max(0, MAX_INVOCATIONS - Math.max(fixed, invocations)));
	const [mc, ac] = await Promise.all([
		(async () => {
			const out: UnitRun[] = [];
			for (const u of courses.filter((x) => x.startsWith("moodle-course:"))) out.push(await one(u));
			return out;
		})(),
		(async () => {
			const out: UnitRun[] = [];
			for (const u of courses.filter((x) => x.startsWith("artemis-course:"))) out.push(await one(u));
			return out;
		})(),
	]);
	runs.push(...mc, ...ac);
	await env.DB.prepare("INSERT INTO state (key, value, updated_at) VALUES ('last_run', ?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?1, updated_at = ?2")
		.bind(JSON.stringify({ trigger, finished: new Date().toISOString(), units: runs.length }), new Date().toISOString())
		.run();
	return runs;
}
