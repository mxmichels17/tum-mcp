// Artemis units.
// "artemis": the course list of the dashboard.
// "artemis-course:<id>": exercises (overview and details with problem statement), exams, lectures with
//   their units and attachment files (R2, PDF text), notifications. Channel messages are not read,
//   because reading a channel marks it as read in Artemis.

import { get, request } from "../../platforms/artemis";
import { fileByStableKey, linkOnly, storeResponse } from "../files";
import { type Entry, type FileRef, hash64, isVideo, type Json, stableStringify, toJson } from "../model";
import { sameSemester, semesterOf, startsInSemester } from "../scope";
import { Deferred, dropStaleCourseState, forgetCourses, getState, setState } from "../store";
import { item, type UnitCtx } from "../unit";

const SITE = "https://artemis.tum.de";
const SOURCE = "artemis";

// Artemis DTOs are large and untyped.
type Any = any;

export interface ArtemisCourseRef {
	id: number;
	title: string;
}

export async function unitArtemis(ctx: UnitCtx): Promise<void> {
	const d = await get(ctx.env, "api/course/courses/for-dashboard");
	// Scope: only courses of the current semester (scope.ts): by the Artemis semester field, else by the start date.
	const sem = semesterOf();
	const all: Any[] = (d.courses ?? []).filter((c: Any) => c.course?.id);
	const current = (c: Any) => (c.course.semester ? sameSemester(String(c.course.semester), sem.code) : startsInSemester(c.course.startDate, sem));
	const list = all.filter(current);
	const others = all.filter((c) => !current(c)).map((c) => c.course.id);
	const forgotten = await forgetCourses(ctx.env, SOURCE, others, (id) => [`artemis:course:${id}`, `artemis:notifications:${id}`]);
	if (forgotten) ctx.note(`${forgotten} stored items of ${others.length} courses outside the current semester forgotten`);
	const dropped = await dropStaleCourseState(ctx.env, { keep: list.map((c) => c.course.id), listingPrefixes: ["artemis:course:", "artemis:notifications:"], unitPrefix: "artemis-course:" });
	if (dropped) ctx.note(`${dropped} pending markers and unit rows of courses outside the scope removed`);
	const refs: ArtemisCourseRef[] = list.filter((c) => c.course?.id).map((c) => ({ id: c.course.id, title: c.course.title }));
	await setState(ctx.env.DB, "artemis:courses", refs);
	await ctx.apply({
		scope: "artemis:courses",
		complete: true,
		outOfScope: others.map((id) => `artemis:course:${id}`),
		entries: list
			.filter((c) => c.course?.id)
			.map((c) => {
				const { exercises: _e, lectures: _l, exams: _x, competencies: _c, prerequisites: _p, tutorialGroups: _t, ...course } = c.course;
				const key = `artemis:course:${c.course.id}`;
				return { key, item: item(SOURCE, key, c.course.title, `${SITE}/courses/${c.course.id}`, { course: toJson(course), dashboard: toJson({ ...c, course: undefined }) }) };
			}),
	});
}

/** Download path of an attachment unit (as artemis_lecture_details). */
export function attachmentPath(u: Any): string | undefined {
	if (!u.attachment) return undefined;
	if (u.type === "attachment" || u.type === "attachment-video") {
		return `api/core/files/attachments/attachment-video-units/${u.id}/student/${encodeURIComponent((u.attachment.link ?? "file.pdf").split("/").pop())}`;
	}
	return u.attachment.link ? `api/core/files/${String(u.attachment.link).replace(/^\/?(api\/core\/files\/)?/, "")}` : undefined;
}

export async function unitArtemisCourse(ctx: UnitCtx, arg?: string): Promise<void> {
	const { env, budget } = ctx;
	const id = Number(arg);
	if (!id) throw new Error("artemis-course needs a course id");
	const title = ((await getState<ArtemisCourseRef[]>(env.DB, "artemis:courses")) ?? []).find((c) => c.id === id)?.title ?? String(id);
	const courseUrl = `${SITE}/courses/${id}`;

	const ov = await get(env, `api/course/courses/${id}/exercises-for-overview`);
	const exercises: Any[] = ov.exercises ?? [];
	const entries: Entry[] = exercises.map((e) => {
		const key = `artemis:exercise:${e.id}`;
		return {
			key,
			// The overview object is the version mark: details are read again only when it changes.
			sig: hash64(stableStringify(e)),
			load: async () => {
				const details = await get(env, `api/exercise/exercises/${e.id}/details`);
				return item(SOURCE, key, e.title, `${courseUrl}/exercises/${e.id}`, { course_id: id, course: title, overview: toJson(e), details: toJson(details) });
			},
		};
	});
	try {
		const exams: Any[] = (await get(env, `api/exam/courses/${id}/exams-for-overview`)) ?? [];
		for (const x of exams) {
			const key = `artemis:exam:${x.id}`;
			entries.push({ key, item: item(SOURCE, key, x.title, `${courseUrl}/exams/${x.id}`, { course_id: id, course: title, exam: toJson(x) }) });
		}
	} catch (e) {
		ctx.note(`exams: ${e instanceof Error ? e.message : String(e)}`);
	}
	const lectures: Any[] = (await get(env, `api/lecture/courses/${id}/lectures-for-overview`)) ?? [];
	for (const l of lectures) {
		const key = `artemis:lecture:${l.id}`;
		entries.push({
			key,
			load: async () => {
				const det = await get(env, `api/lecture/lectures/${l.id}/details`);
				const files: FileRef[] = [];
				for (const u of det.lectureUnits ?? []) {
					const path = attachmentPath(u);
					if (!path) continue;
					const name = String(u.attachment?.name ?? u.name ?? `unit-${u.id}`);
					const url = `${SITE}/${path}`;
					if (u.type === "video" || isVideo(String(u.attachment?.link ?? name))) {
						files.push({ ...linkOnly(name, url, "video (only the link is kept)"), unit_id: u.id } as FileRef);
						continue;
					}
					const stableKey = `artemis:${u.id}:${u.attachment?.version ?? ""}:${u.attachment?.uploadDate ?? ""}`;
					let ref = await fileByStableKey(env, stableKey, url);
					if (!ref) {
						if (!budget.canLoad()) throw new Deferred();
						budget.loaded();
						ref = await storeResponse(env, { name, url, open: () => request(env, path), stableKey });
					}
					files.push({ ...ref, unit_id: u.id } as FileRef);
				}
				return item(SOURCE, key, l.title, `${courseUrl}/lectures/${l.id}`, { course_id: id, course: title, overview: toJson(l), details: toJson(det), files: files as unknown as Json });
			},
		});
	}
	await ctx.apply({ scope: `artemis:course:${id}`, complete: true, entries });

	const page = await get(env, `api/notification/courses/${id}`, { page: 0, size: 50 });
	await ctx.apply({
		scope: `artemis:notifications:${id}`,
		complete: false,
		entries: ((page?.content ?? []) as Any[]).map((n) => {
			const key = `artemis:notification:${n.notificationId ?? n.id}`;
			const p = n.payload ?? {};
			return { key, item: item(SOURCE, key, String(p.postTitle ?? p.exerciseTitle ?? p.title ?? n.notificationType ?? "notification"), n.relativeWebAppUrl ? `${SITE}${n.relativeWebAppUrl}` : courseUrl, { course_id: id, course: title, notification: toJson(n) }) };
		}),
	});
}
