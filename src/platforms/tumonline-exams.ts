// Public TUMonline exam list, no login: GET ee/rest/slc.xm.exd/exExamOffer (the page "Prüfungstermine").
// Checked 2026-10-20: $filter exExamDateFrom-gte and exExamDateTo-lte work; course filters (courseId-eq,
// displayCourseNumber-eq, searchText) are ignored, so the list is paged ($top=200) and filtered here.
// One page is about 1 MB of pretty-printed JSON (about 5 ms CPU for JSON.parse). To stay inside the Workers Free
// CPU limit, pages are scanned as text and only matching entries are parsed.
// Keys: entry id = pv_term_nr of the token function pruefungenEigene, courseId = its stp_sp_nr.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { json, run, withTimeout } from "../lib/tools";

const URL_BASE = "https://campus.tum.de/tumonline/ee/rest/slc.xm.exd/exExamOffer";
const PAGE = 200;
const MAX_PAGES = 40;
const PARALLEL = 6;
const TIMEOUT_MS = 40_000;

// TUMonline DTOs are large and untyped.
export type ExamOffer = Record<string, any>;

export interface ExamKey {
	courseId: string;
	number: string;
	/** Course name of the entry in every language it has (value and translations). Parsed only when called. */
	names: () => string[];
}

/** Strings of a TUMonline langdata object: its value and all translations. */
export function langStrings(v: unknown): string[] {
	if (v == null) return [];
	if (typeof v === "string") return [v];
	const o = v as { value?: unknown; translations?: { translation?: { value?: unknown }[] } };
	const out = [o.value, ...(o.translations?.translation ?? []).map((t) => t.value)].filter((x): x is string => typeof x === "string" && x.trim() !== "");
	return [...new Set(out)];
}

function namesIn(chunk: string): string[] {
	const at = chunk.search(/"courseName"\s*:\s*\{/);
	if (at < 0) {
		const plain = /"courseName"\s*:\s*"([^"]*)"/.exec(chunk)?.[1];
		return plain ? [plain] : [];
	}
	const start = chunk.indexOf("{", at);
	const end = objectEnd(chunk, start);
	if (end < 0) return [];
	try {
		return langStrings(JSON.parse(chunk.slice(start, end)));
	} catch {
		return [];
	}
}

const ENTRY_START = /\{\s*"courseId"\s*:\s*(\d+)/g;

/** End index (exclusive) of the JSON object that starts at `start`, with strings respected. */
function objectEnd(text: string, start: number): number {
	let depth = 0;
	let inString = false;
	for (let i = start; i < text.length; i++) {
		const c = text[i];
		if (inString) {
			if (c === "\\") i++;
			else if (c === '"') inString = false;
		} else if (c === '"') inString = true;
		else if (c === "{") depth++;
		else if (c === "}" && --depth === 0) return i + 1;
	}
	return -1;
}

/**
 * Scans one page as text. Returns the total count, the number of entries on the page and the parsed entries
 * for which `pick` is true. Falls back to JSON.parse of the whole page when the layout is unknown.
 */
export function scanPage(text: string, pick: (k: ExamKey) => boolean): { total?: number; count: number; picked: ExamOffer[] } {
	const total = Number(/"totalCount"\s*:\s*(\d+)/.exec(text)?.[1] ?? Number.NaN);
	const starts = [...text.matchAll(ENTRY_START)].map((m) => ({ at: m.index ?? 0, courseId: m[1] }));
	if (!starts.length && /"examOffers"\s*:\s*\[\s*\{/.test(text)) {
		const d = JSON.parse(text) as { examOffers?: ExamOffer[]; totalCount?: number };
		const all = d.examOffers ?? [];
		return {
			total: d.totalCount,
			count: all.length,
			picked: all.filter((e) => pick({ courseId: String(e.courseId), number: String(e.displayCourseNumber ?? ""), names: () => langStrings(e.courseName) })),
		};
	}
	const picked: ExamOffer[] = [];
	for (let i = 0; i < starts.length; i++) {
		const chunk = text.slice(starts[i].at, starts[i + 1]?.at ?? text.length);
		const number = /"displayCourseNumber"\s*:\s*"([^"]*)"/.exec(chunk)?.[1] ?? "";
		if (!pick({ courseId: starts[i].courseId, number, names: () => namesIn(chunk) })) continue;
		const end = objectEnd(text, starts[i].at);
		if (end > 0) picked.push(JSON.parse(text.slice(starts[i].at, end)) as ExamOffer);
	}
	return { total: Number.isFinite(total) ? total : undefined, count: starts.length, picked };
}

function pageUrl(from: string, to: string | undefined, skip: number): string {
	// $-names stay literal: the server ignores %24top.
	const filter = [`exExamDateFrom-gte=${from}`, to ? `exExamDateTo-lte=${to}` : ""].filter(Boolean).join(";");
	return `${URL_BASE}?$filter=${encodeURIComponent(filter).replace(/%3D/g, "=").replace(/%3B/g, ";")}&$orderBy=exExamDate=ascnl&$skip=${skip}&$top=${PAGE}&orgId=-1`;
}

async function page(from: string, to: string | undefined, skip: number): Promise<string> {
	const res = await withTimeout(fetch(pageUrl(from, to, skip), { headers: { Accept: "application/json", "Accept-Language": "de" } }), TIMEOUT_MS, "TUMonline exams");
	const text = await res.text();
	if (!res.ok) throw new Error(`TUMonline exam list HTTP ${res.status} at $skip=${skip}: ${text.slice(0, 200)}`);
	return text;
}

/** All exam offers from `from` (YYYY-MM-DD) on, optionally up to `to`, that `pick` selects. */
export async function publicExams(opts: { from: string; to?: string; pick: (k: ExamKey) => boolean }): Promise<{ total: number; scanned: number; pages: number; entries: ExamOffer[] }> {
	const first = scanPage(await page(opts.from, opts.to, 0), opts.pick);
	const total = first.total ?? first.count;
	const pages = Math.min(MAX_PAGES, Math.ceil(total / PAGE));
	const entries = [...first.picked];
	let scanned = first.count;
	const rest = Array.from({ length: Math.max(0, pages - 1) }, (_, i) => (i + 1) * PAGE);
	for (let i = 0; i < rest.length; i += PARALLEL) {
		const texts = await Promise.all(rest.slice(i, i + PARALLEL).map((skip) => page(opts.from, opts.to, skip)));
		for (const t of texts) {
			const r = scanPage(t, opts.pick);
			scanned += r.count;
			entries.push(...r.picked);
		}
	}
	if (scanned < total && pages < MAX_PAGES) throw new Error(`TUMonline exam list: ${scanned} of ${total} entries read`);
	return { total, scanned, pages, entries };
}

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

export function registerTumonlineExamTools(server: McpServer, _env: Env) {
	server.registerTool(
		"tumonline_public_exams",
		{
			description:
				"Public TUMonline exam dates (no login): every exam from from_date on with exam date and time, registration start and end, deregistration end, type, participants and examiners, raw entries unchanged. Filter with course_numbers (module numbers such as WI001141, or the 9-digit TUMonline course id). The server cannot filter by course, so all pages are read (about 17 pages, 10 to 20 s). Read only.",
			inputSchema: {
				course_numbers: z.array(z.string().min(2).max(20)).max(50).optional().describe("Module numbers (displayCourseNumber) or TUMonline course ids"),
				from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD, default today"),
				to_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD, optional"),
				limit: z.number().int().min(1).max(500).default(100).describe("Most entries returned without course_numbers"),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ course_numbers, from_date, to_date, limit }) =>
			run(async () => {
				const wanted = new Set((course_numbers ?? []).map((c) => c.trim().toUpperCase()));
				let taken = 0;
				const pick = (k: ExamKey) => (wanted.size ? wanted.has(k.number.toUpperCase()) || wanted.has(k.courseId) : taken++ < limit);
				const r = await publicExams({ from: from_date ?? today(), to: to_date, pick });
				return json({
					source: "GET ee/rest/slc.xm.exd/exExamOffer (public)",
					from: from_date ?? today(),
					to: to_date ?? null,
					total_exams: r.total,
					scanned: r.scanned,
					count: r.entries.length,
					filter: wanted.size ? [...wanted] : `none (first ${limit})`,
					exams: r.entries,
				});
			}),
	);
}
