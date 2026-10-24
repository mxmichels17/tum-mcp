// TUMonline public course data (no login), via the REST API behind the TUMonline web app:
// https://campus.tum.de/tumonline/ee/rest/slc.tm.cp/student/...
// These endpoints are not officially documented. Paths were taken from the TUMonline web app.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { json, type PlatformStatus, run, withTimeout } from "../lib/tools";

const BASE = "https://campus.tum.de/tumonline/ee/rest";
const UI_COURSE = "https://campus.tum.de/tumonline/ee/ui/ca2/app/desktop/#/slc.tm.cp/student/courses";
const TIMEOUT_MS = 30_000;

type Lang = "de" | "en";

// TUMonline DTOs are large and untyped.
type Dto = any;

async function get(path: string): Promise<Dto> {
	const res = await withTimeout(
		fetch(`${BASE}${path}`, { headers: { Accept: "application/json", "Accept-Language": "de" } }),
		TIMEOUT_MS,
		"TUMonline",
	);
	const text = await res.text();
	if (!res.ok) throw new Error(`TUMonline HTTP ${res.status} for ${path}: ${text.slice(0, 200)}`);
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`TUMonline returned no JSON for ${path}`);
	}
}

/** Picks a translation from a TUMonline langdata object, falling back to its default value. */
export function lang(v: Dto, l: Lang): string | undefined {
	if (v == null) return undefined;
	if (typeof v === "string") return v;
	const tr = v.translations?.translation?.find((t: Dto) => t.lang === l)?.value;
	return tr ?? v.value ?? undefined;
}

function persons(lectureships: Dto[] | undefined) {
	return (lectureships ?? []).map((l: Dto) => ({
		name: [l.identityLibDto?.firstName, l.identityLibDto?.lastName].filter(Boolean).join(" "),
		function: l.teachingFunction?.name,
	}));
}

interface Semester {
	id: number;
	key: string;
	name: string;
	start?: string;
	end?: string;
	selected: boolean;
}

async function semesters(l: Lang = "en"): Promise<Semester[]> {
	const r = await get("/slc.lib.tm/semesters/student");
	return (r.semesters ?? []).map((s: Dto) => ({
		id: s.id,
		key: s.key,
		name: lang(s.semesterDesignation, l) ?? s.key,
		start: s.startOfAcademicSemester?.value,
		end: s.endOfAcademicSemester?.value,
		selected: !!s.isSelected,
	}));
}

/** Id of the semester TUMonline marks as selected (the current one). */
export async function currentSemesterId(): Promise<number | undefined> {
	return (await semesters()).find((s) => s.selected)?.id;
}

export async function resolveSemester(input: string | undefined): Promise<number | undefined> {
	if (!input) return undefined;
	if (/^\d+$/.test(input)) return Number(input);
	const hit = (await semesters()).find((s) => s.key.toUpperCase() === input.toUpperCase());
	if (!hit) throw new Error(`Unknown semester "${input}". Use a key like 26W or 27S, see tumonline_semesters.`);
	return hit.id;
}

function courseSummary(c: Dto, l: Lang) {
	return {
		id: c.id,
		number: c.courseNumber?.courseNumber,
		title: lang(c.courseTitle, l),
		type: lang(c.courseTypeDto?.courseTypeName, l),
		semester: c.semesterDto?.key,
		sws: c.courseNormConfigs?.find((n: Dto) => n.key === "SST")?.value,
		lecturers: persons(c.lectureships).map((p: { name: string }) => p.name),
		registration: lang(c.registrationInfo, l),
		url: `${UI_COURSE}/${c.id}`,
	};
}

function appointments(group: Dto, l: Lang) {
	return (group.appointmentDtos ?? []).map((a: Dto) => ({
		start: a.timestampFrom?.value,
		end: a.timestampTo?.value,
		weekday: a.weekday?.key,
		room: a.resourceName,
		type: a.appointmentEventTypeDto?.key,
		status: a.appointmentStatusType,
		group: group.name,
		group_id: group.id,
		note: lang(a.appointmentDescription, l),
	}));
}

async function courseGroups(courseId: number): Promise<Dto[]> {
	const [first, remaining] = await Promise.all([
		get(`/slc.tm.cp/student/courseGroups/firstGroups/${courseId}`),
		get(`/slc.tm.cp/student/courseGroups/remainingGroups/${courseId}`).catch(() => ({ courseGroupDtos: [] })),
	]);
	const seen = new Set<number>();
	const out: Dto[] = [];
	for (const g of [...(first.courseGroupDtos ?? []), ...(remaining.courseGroupDtos ?? [])]) {
		if (seen.has(g.id)) continue;
		seen.add(g.id);
		out.push(g);
	}
	return out;
}

const langArg = z.enum(["de", "en"]).default("en").describe("Language for titles and texts (falls back to German)");
const courseIdArg = z.number().int().positive().describe("TUMonline course ID, e.g. 950940057");

export function registerTumonlineTools(server: McpServer, _env: Env) {
	server.registerTool(
		"tumonline_semesters",
		{
			description: "List TUMonline semesters with their IDs and keys (e.g. 26W). The selected one is the current default.",
			inputSchema: { language: langArg },
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ language }) => run(async () => json({ semesters: await semesters(language) })),
	);

	server.registerTool(
		"tumonline_course_search",
		{
			description:
				"Search the public TUMonline course catalogue by title or course number. Returns course IDs for tumonline_course_details, tumonline_course_groups and tumonline_course_dates.",
			inputSchema: {
				query: z.string().min(2),
				semester: z.string().optional().describe("Semester key like 26W or 27S, or a semester ID. Default: current semester"),
				limit: z.number().int().min(1).max(100).default(20),
				offset: z.number().int().min(0).default(0),
				language: langArg,
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ query, semester, limit, offset, language }) =>
			run(async () => {
				const termId = await resolveSemester(semester);
				const filter = [
					"courseNormKey-eq=LVEAB",
					"orgId-eq=1",
					termId ? `termId-eq=${termId}` : undefined,
					`filterTerm-like=${query.replace(/[;&]/g, " ")}`,
				]
					.filter(Boolean)
					.join(";");
				const qs = new URLSearchParams({ $filter: filter, $orderBy: "title=ascnf", $skip: String(offset), $top: String(limit) });
				const r = await get(`/slc.tm.cp/student/courses?${qs.toString()}`);
				return json({
					total: r.totalCount,
					offset,
					courses: (r.courses ?? []).map((c: Dto) => courseSummary(c, language)),
				});
			}),
	);

	server.registerTool(
		"tumonline_course_details",
		{
			description: "Get public details of a TUMonline course: title, type, SWS, lecturers, language, organisation, description, links, registration info.",
			inputSchema: { course_id: courseIdArg, language: langArg },
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ course_id, language: l }) =>
			run(async () => {
				const r = await get(`/slc.tm.cp/student/courses/${course_id}`);
				const d = r.resource?.[0]?.content?.cpCourseDetailDto;
				if (!d) throw new Error(`Course ${course_id} not found`);
				const c = d.cpCourseDto;
				const desc = d.cpCourseDescriptionDto ?? {};
				const info = desc.additionalInformation ?? {};
				return json({
					...courseSummary(c, l),
					lecturers: persons(c.lectureships),
					semester_name: lang(c.semesterDto?.semesterDesignation, l),
					organisation: lang(c.organisationResponsibleDto?.name, l),
					languages: (c.courseLanguageDtos ?? []).map((x: Dto) => lang(x.languageDto?.name, l)),
					examination_method: lang(c.examinationMethodName, l),
					content: lang(desc.courseContent, l),
					objectives: lang(desc.courseObjective, l),
					prerequisites: lang(desc.previousKnowledge, l),
					teaching_method: lang(desc.teachingMethod, l),
					assessment: lang(desc.assessmentScheme, l),
					literature: lang(info.recommendedLiterature, l),
					comments: lang(info.comments, l),
					links: (info.cpCourseUrlGroupDtos ?? []).flatMap((g: Dto) =>
						(g.courseUrlDtoList ?? []).map((u: Dto) => ({ group: lang(g.groupName, l), name: lang(u.name, l), url: u.url })),
					),
					registration_status: c.registrationInfoStatus,
				});
			}),
	);

	server.registerTool(
		"tumonline_course_groups",
		{
			description: "List the groups of a TUMonline course (lecture group, tutorial groups) with lecturers, places and weekly time series.",
			inputSchema: { course_id: courseIdArg, language: langArg },
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ course_id, language: l }) =>
			run(async () => {
				const groups = await courseGroups(course_id);
				return json({
					course_id,
					groups: groups.map((g: Dto) => ({
						id: g.id,
						name: g.name,
						standard_group: g.standardgroupFlag === "J",
						confirmed_places: g.confirmedPlaces,
						limited_participation: g.limitedParticipationFlag === "J",
						lecturers: persons(g.lectureshipDtos),
						series: (g.appointmentSeriesDtos ?? []).map((s: Dto) => ({
							weekdays: (s.weekday ?? []).map((w: Dto) => w.key ?? lang(w.name, l)),
							time: `${s.seriesBeginTime}-${s.seriesEndTime}`,
							from: s.seriesBegin?.value,
							until: s.seriesEnd?.value,
							room: s.resourceName,
						})),
						appointment_count: (g.appointmentDtos ?? []).length,
					})),
				});
			}),
	);

	server.registerTool(
		"tumonline_course_dates",
		{
			description: "List the single dates (appointments) of a TUMonline course with time, room and group, sorted by start time.",
			inputSchema: {
				course_id: courseIdArg,
				group_id: z.number().int().optional().describe("Only this group (ID from tumonline_course_groups)"),
				include_past: z.boolean().default(false),
				limit: z.number().int().min(1).max(500).default(100),
				language: langArg,
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ course_id, group_id, include_past, limit, language: l }) =>
			run(async () => {
				const groups = (await courseGroups(course_id)).filter((g: Dto) => group_id === undefined || g.id === group_id);
				// TUMonline times are local Munich time without an offset. Compare as local strings.
				const now = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Berlin" }).replace(" ", "T");
				const dates = groups
					.flatMap((g: Dto) => appointments(g, l))
					.filter((a: { end?: string }) => include_past || !a.end || a.end >= now)
					.sort((a: { start?: string }, b: { start?: string }) => (a.start ?? "").localeCompare(b.start ?? ""));
				return json({ course_id, timezone: "Europe/Berlin", total: dates.length, dates: dates.slice(0, limit) });
			}),
	);
}

export async function tumonlineStatus(): Promise<PlatformStatus> {
	try {
		const s = await semesters();
		return { platform: "tumonline (public)", state: "OK", detail: `current semester ${s.find((x) => x.selected)?.key ?? "?"}` };
	} catch (e) {
		return { platform: "tumonline (public)", state: "error", detail: e instanceof Error ? e.message : String(e) };
	}
}
