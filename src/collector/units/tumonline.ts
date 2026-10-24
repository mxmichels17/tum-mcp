// TUMonline units. All values are the raw fields of TUMonline, unchanged.
// "tumonline": token web service: my courses (veranstaltungenEigene), my exams (pruefungenEigene),
//   my calendar with rooms (kalender).
// "tumonline-courses": public REST courses/{id}/registrationProcedures for my course ids
//   (veranstaltungenEigene, plus course numbers found in calendar events).
// "tumonline-exams": the public exam list (ee/rest/slc.xm.exd/exExamOffer, no login), entries of my courses.

import { withTimeout } from "../../lib/tools";
import { child, childrenNamed, textOf, xmlToJson } from "../../lib/xml";
import { langStrings, publicExams } from "../../platforms/tumonline-exams";
import { call, rows } from "../../platforms/tumonline-personal";
import { type Content, hash64, stableStringify, toJson } from "../model";
import { getState, setState } from "../store";
import { errText, item, type UnitCtx } from "../unit";

const UI = "https://campus.tum.de/tumonline/ee/ui/ca2/app/desktop/#";
const REST = "https://campus.tum.de/tumonline/ee/rest";
const SOURCE = "tumonline";

export interface CourseRef {
	id: string;
	title: string;
	from: "veranstaltungenEigene" | "kalender";
}

export interface ExamKeys {
	courseIds: string[];
	numbers: string[];
	/** Course titles as pruefungenEigene and veranstaltungenEigene write them. */
	names?: string[];
}

/** Names and numbers of one course from its public course data, in every language TUMonline gives. */
export interface CourseNames {
	id: string;
	names: string[];
	numbers: string[];
}

/** Names compare after trimming, joining white space and ignoring case. Nothing else is changed. */
export const sameName = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();

/** The exam list filter: an entry is mine when its course id, its course number or one of its course names is mine. */
export function examPicker(mine: { ids: Iterable<string>; numbers: Iterable<string>; names: Iterable<string> }) {
	const ids = new Set(mine.ids);
	const numbers = new Set([...mine.numbers].map((n) => n.trim().toUpperCase()).filter(Boolean));
	const names = new Set([...mine.names].map(sameName).filter(Boolean));
	return (k: { courseId: string; number: string; names: () => string[] }) =>
		ids.has(k.courseId) || numbers.has(k.number.trim().toUpperCase()) || (names.size > 0 && k.names().some((n) => names.has(sameName(n))));
}

const str = (v: unknown) => (v == null ? "" : String(v));

/** Course numbers in a calendar event: TUMonline course links and 9-digit course ids. */
export function courseIdsInEvent(e: Record<string, unknown>): string[] {
	const text = `${str(e.url)} ${str(e.description)} ${str(e.link)}`;
	const out = new Set<string>();
	for (const m of text.matchAll(/(?:pS_LV_ID|pLVNr|LvNr|pStpSpNr|courses\/)=?(\d{6,})/gi)) out.add(m[1]);
	for (const m of text.matchAll(/\b(9\d{8})\b/g)) out.add(m[1]);
	return [...out];
}

function berlinDay(d: Date): string {
	return d.toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
}

export async function unitTumonline(ctx: UnitCtx): Promise<void> {
	const { env } = ctx;
	const courses = new Map<string, CourseRef>();
	const keys: ExamKeys = { courseIds: [], numbers: [], names: [] };

	try {
		const list = rows(await call(env, "veranstaltungenEigene"));
		await ctx.apply({
			scope: "tumonline:mycourses",
			complete: true,
			entries: list.map((r) => {
				const id = str(r.stp_lv_nr) || str(r.stp_sp_nr) || hash64(stableStringify(r));
				if (r.stp_lv_nr) courses.set(str(r.stp_lv_nr), { id: str(r.stp_lv_nr), title: str(r.stp_sp_titel), from: "veranstaltungenEigene" });
				if (r.stp_sp_titel) keys.names?.push(str(r.stp_sp_titel));
				return { key: `tumonline:mycourse:${id}`, item: item(SOURCE, `tumonline:mycourse:${id}`, str(r.stp_sp_titel), `${UI}/slc.tm.cp/student/courses/${id}`, { function: "veranstaltungenEigene", row: toJson(r) }) };
			}),
		});
	} catch (e) {
		ctx.note(`veranstaltungenEigene: ${errText(e)}`);
	}

	try {
		const list = rows(await call(env, "pruefungenEigene"));
		for (const r of list) {
			if (r.stp_sp_nr) keys.courseIds.push(str(r.stp_sp_nr));
			if (r.lv_nummer) keys.numbers.push(str(r.lv_nummer).toUpperCase());
			for (const t of [r.lv_titel, r.titel]) if (t) keys.names?.push(str(t));
		}
		await ctx.apply({
			scope: "tumonline:myexams",
			complete: true,
			entries: list.map((r) => {
				const id = str(r.pv_term_nr) || hash64(stableStringify(r));
				return {
					key: `tumonline:myexam:${id}`,
					item: item(SOURCE, `tumonline:myexam:${id}`, str(r.lv_titel) || str(r.titel), `${UI}/slc.xm.exm/myExams`, { function: "pruefungenEigene", row: toJson(r) }),
				};
			}),
		});
	} catch (e) {
		ctx.note(`pruefungenEigene: ${errText(e)}`);
	}

	try {
		// Read window: 2 months back, 12 months ahead. Events before the start of the window are never
		// reported as removed, because they are outside the read.
		const cal = await call(env, "kalender", { pMonateVor: 2, pMonateNach: 12 });
		const windowFrom = berlinDay(new Date(Date.now() - 31 * 86400_000));
		const events = childrenNamed(child(cal, "events"), "event");
		await ctx.apply({
			scope: "tumonline:calendar",
			complete: true,
			windowFrom,
			entries: events.map((ev) => {
				const raw = xmlToJson(ev) as Record<string, unknown>;
				for (const id of courseIdsInEvent(raw)) if (!courses.has(id)) courses.set(id, { id, title: textOf(ev, "title") ?? "", from: "kalender" });
				const nr = textOf(ev, "nr") ?? hash64(`${textOf(ev, "title")}|${textOf(ev, "dtstart")}|${textOf(ev, "location")}`);
				const key = `tumonline:cal:${nr}`;
				return {
					key,
					window: (textOf(ev, "dtstart") ?? "").slice(0, 10),
					item: item(SOURCE, key, textOf(ev, "title") ?? "", textOf(ev, "url") ?? `${UI}/slc.tm.cp/student/calendar`, { function: "kalender", event: toJson(raw) }),
				};
			}),
		});
	} catch (e) {
		ctx.note(`kalender: ${errText(e)}`);
	}

	// The course units read these lists. A failed call keeps the lists of the last good run.
	if (courses.size) await setState(env.DB, "tumonline:courses", [...courses.values()]);
	if (keys.courseIds.length || keys.numbers.length) await setState(env.DB, "tumonline:examkeys", keys);
}

async function rest(path: string): Promise<unknown> {
	const res = await withTimeout(fetch(`${REST}${path}`, { headers: { Accept: "application/json", "Accept-Language": "de" } }), 25_000, "TUMonline");
	const text = await res.text();
	if (!res.ok) throw new Error(`TUMonline HTTP ${res.status} for ${path}: ${text.slice(0, 200)}`);
	return JSON.parse(text);
}

export async function unitTumonlineCourses(ctx: UnitCtx): Promise<void> {
	const courses = (await getState<CourseRef[]>(ctx.env.DB, "tumonline:courses")) ?? [];
	if (!courses.length) {
		ctx.note("no course list yet (the unit tumonline runs first)");
		return;
	}
	const names = new Map(((await getState<CourseNames[]>(ctx.env.DB, "tumonline:coursenames")) ?? []).map((n) => [n.id, n]));
	await ctx.apply({
		scope: "tumonline:registration",
		complete: true,
		entries: courses.map((c) => {
			const key = `tumonline:regproc:${c.id}`;
			return {
				key,
				load: async () => {
					const [details, data] = await Promise.all([rest(`/slc.tm.cp/student/courses/${c.id}`), rest(`/slc.tm.cp/student/courses/${c.id}/registrationProcedures`)]);
					const dto = (details as { resource?: { content?: { cpCourseDetailDto?: { cpCourseDto?: Record<string, unknown> } } }[] }).resource?.[0]?.content?.cpCourseDetailDto?.cpCourseDto ?? {};
					names.set(c.id, {
						id: c.id,
						names: langStrings(dto.courseTitle),
						numbers: ["courseNumber", "courseCode", "displayCourseNumber", "number"].map((f) => dto[f]).filter((x): x is string => typeof x === "string" && x.trim() !== ""),
					});
					return item(SOURCE, key, c.title, `${UI}/slc.tm.cp/student/courses/${c.id}`, {
						course_id: c.id,
						course_id_from: c.from,
						endpoint: `GET ee/rest/slc.tm.cp/student/courses/${c.id}/registrationProcedures`,
						response: toJson(data),
						course_endpoint: `GET ee/rest/slc.tm.cp/student/courses/${c.id}`,
						course: toJson(details),
					});
				},
			};
		}),
	});
	// The exam unit matches exam entries by these names and numbers.
	await setState(ctx.env.DB, "tumonline:coursenames", [...names.values()].filter((n) => courses.some((c) => c.id === n.id)));
}

export async function unitTumonlineExams(ctx: UnitCtx): Promise<void> {
	const courses = (await getState<CourseRef[]>(ctx.env.DB, "tumonline:courses")) ?? [];
	const keys = (await getState<ExamKeys>(ctx.env.DB, "tumonline:examkeys")) ?? { courseIds: [], numbers: [] };
	const names = (await getState<CourseNames[]>(ctx.env.DB, "tumonline:coursenames")) ?? [];
	const ids = [...courses.map((c) => c.id), ...keys.courseIds];
	const numbers = [...keys.numbers, ...names.flatMap((n) => n.numbers)];
	const titles = [...(keys.names ?? []), ...names.flatMap((n) => n.names)];
	if (!ids.length && !numbers.length && !titles.length) {
		ctx.note("no course ids yet (the unit tumonline runs first)");
		return;
	}
	const from = berlinDay(new Date());
	const r = await publicExams({ from, pick: examPicker({ ids, numbers, names: titles }) });
	ctx.note(`${r.entries.length} entries of my courses in ${r.total} public exams from ${from}`);
	await ctx.apply({
		scope: "tumonline:public_exams",
		complete: true,
		// Exams before today drop out of the list on their own; they are not reported as removed.
		windowFrom: from,
		entries: r.entries.map((e) => {
			const key = `tumonline:exam:${e.id}`;
			const day = str(e.examDate?.value ?? e.examDate);
			const title = str(e.courseName?.value ?? e.courseName?.translations?.translation?.[0]?.value ?? e.displayCourseNumber);
			return {
				key,
				window: day.slice(0, 10),
				item: item(SOURCE, key, title, e.courseId ? `${UI}/slc.tm.cp/student/courses/${e.courseId}` : `${UI}/slc.xm.exd/exExamOffer`, {
					endpoint: "GET ee/rest/slc.xm.exd/exExamOffer (public)",
					entry: toJson(e),
				}),
			};
		}),
	});
}
