// Artemis (artemis.tum.de). Login with TUM_USER/TUM_PASSWORD through LDAP:
// POST api/core/public/authenticate (ls1intum/Artemis core/web/open/PublicUserJwtResource.java, checked 2026-10-17).
// TUM runs Artemis with the "ldap" module and without SAML2/OIDC (from /management/info), so password login works.
// The JWT (rememberMe: 7 days) is cached in KV, because every password login sends a "new login" email.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fileResult } from "../lib/files";
import { storeDelete, storeGet, storePut } from "../lib/store";
import { CONFIRM, json, LoginError, NotConfiguredError, type PlatformStatus, requireSecrets, run, withTimeout } from "../lib/tools";

const SITE = "https://artemis.tum.de";
const UA = "tum-mcp/0.2 (Cloudflare Worker)";
const STORE_KEY = "artemis-jwt";
const TIMEOUT_MS = 30_000;

// Artemis DTOs are large and vary per exercise type.
type Any = any;

export class ArtemisError extends Error {
	constructor(
		message: string,
		public status: number,
	) {
		super(message);
	}
}

async function login(env: Env): Promise<string> {
	const { TUM_USER, TUM_PASSWORD } = requireSecrets(env, "artemis", ["TUM_USER", "TUM_PASSWORD"]);
	const res = await withTimeout(
		fetch(`${SITE}/api/core/public/authenticate`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA },
			body: JSON.stringify({ username: TUM_USER.trim(), password: TUM_PASSWORD, rememberMe: true }),
		}),
		TIMEOUT_MS,
		"Artemis login",
	);
	if (res.status === 401) throw new LoginError("Artemis login failed (401): TUM ID or password rejected, or the account is not activated in Artemis");
	if (res.status === 429) throw new ArtemisError("Artemis login is rate limited (429). Try again in a minute.", 429);
	if (!res.ok) throw new ArtemisError(`Artemis login failed: HTTP ${res.status}`, res.status);
	const data = (await res.json()) as { access_token?: string };
	if (!data.access_token) throw new LoginError("Artemis login returned no token");
	await storePut(env, STORE_KEY, { token: data.access_token, at: new Date().toISOString() }, 6 * 86400);
	return data.access_token;
}

async function jwt(env: Env, force = false): Promise<string> {
	if (!force) {
		const s = await storeGet<{ token: string }>(env, STORE_KEY);
		if (s?.token) return s.token;
	}
	return login(env);
}

/** Authenticated request. Logs in again once on 401. */
export async function request(
	env: Env,
	path: string,
	init: { method?: string; body?: unknown; rawBody?: string; query?: Record<string, string | number | undefined> } = {},
): Promise<Response> {
	const url = new URL(path.replace(/^\//, ""), `${SITE}/`);
	for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
	for (let attempt = 0; attempt < 2; attempt++) {
		const token = await jwt(env, attempt > 0);
		const res = await withTimeout(
			fetch(url, {
				method: init.method ?? "GET",
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/json",
					"User-Agent": UA,
					...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
					...(init.rawBody !== undefined ? { "Content-Type": "text/plain" } : {}),
				},
				body: init.rawBody !== undefined ? init.rawBody : init.body !== undefined ? JSON.stringify(init.body) : undefined,
			}),
			TIMEOUT_MS,
			"Artemis",
		);
		if (res.status === 401 && attempt === 0) {
			await res.body?.cancel();
			await storeDelete(env, STORE_KEY);
			continue;
		}
		if (res.status === 401) throw new LoginError("Artemis rejected the new login token (401)");
		if (!res.ok) {
			const text = await res.text();
			let msg = text.slice(0, 300);
			try {
				const j = JSON.parse(text);
				msg = j.detail ?? j.title ?? j.message ?? msg;
			} catch {
				// not JSON
			}
			const alert = res.headers.get("X-artemisApp-error") ?? res.headers.get("X-artemisApp-message");
			if (alert) msg = `${alert}${msg ? ` (${msg})` : ""}`;
			if (res.status === 403) throw new ArtemisError(`Artemis: no access (403). ${msg}`, 403);
			throw new ArtemisError(`Artemis HTTP ${res.status} for ${url.pathname}: ${msg}`, res.status);
		}
		return res;
	}
	throw new LoginError("Artemis login failed");
}

export async function get(env: Env, path: string, query?: Record<string, string | number | undefined>): Promise<Any> {
	const res = await request(env, path, { query });
	if (res.status === 204) return null;
	return res.json();
}

const courseIdArg = z.number().int().positive().describe("Artemis course ID from artemis_courses");

function latestResult(p: Any) {
	const subs = [...(p?.submissions ?? [])].sort((a: Any, b: Any) => (b.submissionDate ?? "").localeCompare(a.submissionDate ?? ""));
	for (const s of subs) {
		const r = [...(s.results ?? [])].sort((a: Any, b: Any) => (b.completionDate ?? "").localeCompare(a.completionDate ?? ""))[0];
		if (r) return { submission: s, result: r };
	}
	return { submission: subs[0], result: undefined };
}

function exerciseSummary(e: Any) {
	const p = e.studentParticipations?.[0];
	const { submission, result } = latestResult(p);
	return {
		id: e.id,
		title: e.title,
		type: e.type ?? e.exerciseType,
		max_points: e.maxPoints,
		bonus_points: e.bonusPoints,
		release: e.releaseDate,
		start: e.startDate,
		due: p?.individualDueDate ?? e.dueDate,
		assessment_due: e.assessmentDueDate,
		mode: e.mode,
		difficulty: e.difficulty,
		participation_id: p?.id,
		submitted: submission ? Boolean(submission.submitted) : false,
		last_submission: submission?.submissionDate,
		result: result
			? {
					id: result.id,
					score_percent: result.score,
					points: e.maxPoints != null && result.score != null ? Math.round(result.score * e.maxPoints) / 100 : undefined,
					rated: result.rated,
					successful: result.successful,
					tests: result.testCaseCount ? `${result.passedTestCaseCount}/${result.testCaseCount}` : undefined,
					completed: result.completionDate,
				}
			: undefined,
		repository: p?.repositoryUri,
	};
}

export function registerArtemisTools(server: McpServer, env: Env) {
	const ro = { readOnlyHint: true, openWorldHint: true };
	const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

	server.registerTool(
		"artemis_courses",
		{ description: "My Artemis courses with my total score and active exams.", inputSchema: {}, annotations: ro },
		async () =>
			run(async () => {
				const d = await get(env, "api/course/courses/for-dashboard");
				return json({
					courses: (d.courses ?? []).map((c: Any) => ({
						id: c.course?.id,
						title: c.course?.title,
						short_name: c.course?.shortName,
						semester: c.course?.semester,
						start: c.course?.startDate,
						end: c.course?.endDate,
						exercises: c.course?.exercises?.length,
						lectures: c.course?.lectures?.length,
						exams: c.course?.exams?.length,
						score: c.totalScores
							? {
									points: c.totalScores.studentScores?.absoluteScore,
									percent: c.totalScores.studentScores?.relativeScore,
									current_percent: c.totalScores.studentScores?.currentRelativeScore,
									max_points: c.totalScores.maxPoints,
									reachable_points: c.totalScores.reachablePoints,
								}
							: undefined,
						unread_notifications: c.courseNotificationCount,
					})),
					active_exams: (d.activeExams ?? []).map((x: Any) => ({ id: x.id, title: x.title, start: x.startDate, end: x.endDate, course: x.course?.title, test_exam: x.testExam })),
				});
			}),
	);

	server.registerTool(
		"artemis_exercises",
		{
			description: "Exercises of an Artemis course with release and due dates, my submission and my latest result.",
			inputSchema: { course_id: courseIdArg, only_open: z.boolean().default(false).describe("Only exercises with a due date in the future or none") },
			annotations: ro,
		},
		async ({ course_id, only_open }) =>
			run(async () => {
				const d = await get(env, `api/course/courses/${course_id}/exercises-for-overview`);
				const now = new Date().toISOString();
				const list = (d.exercises ?? [])
					.map(exerciseSummary)
					.filter((e: Any) => !only_open || !e.due || e.due > now)
					.sort((a: Any, b: Any) => (a.due ?? "9").localeCompare(b.due ?? "9"));
				return json({
					course_id,
					total_score: d.totalScores?.studentScores,
					count: list.length,
					exercises: list,
				});
			}),
	);

	server.registerTool(
		"artemis_exercise_details",
		{
			description: "Details of one Artemis exercise: problem statement (Markdown), dates, my participations and results.",
			inputSchema: { exercise_id: z.number().int().positive() },
			annotations: ro,
		},
		async ({ exercise_id }) =>
			run(async () => {
				const d = await get(env, `api/exercise/exercises/${exercise_id}/details`);
				const e = d.exercise ?? d;
				const statement = String(e.problemStatement ?? "");
				return json({
					...exerciseSummary(e),
					problem_statement: statement.length > 30_000 ? `${statement.slice(0, 30_000)} [truncated]` : statement,
					programming_language: e.programmingLanguage,
					example_solution_published: e.exampleSolutionPublicationDate,
					participations: (e.studentParticipations ?? []).map((p: Any) => ({
						id: p.id,
						state: p.initializationState,
						repository: p.repositoryUri,
						results: (p.submissions ?? []).flatMap((s: Any) =>
							(s.results ?? []).map((r: Any) => ({ id: r.id, score_percent: r.score, rated: r.rated, completed: r.completionDate, submission_date: s.submissionDate })),
						),
					})),
					plagiarism_case: d.plagiarismCaseInfo ?? undefined,
				});
			}),
	);

	server.registerTool(
		"artemis_result_feedback",
		{
			description: "Feedback of one Artemis result: test cases, manual feedback, credits. IDs from artemis_exercises or artemis_exercise_details.",
			inputSchema: { participation_id: z.number().int().positive(), result_id: z.number().int().positive() },
			annotations: ro,
		},
		async ({ participation_id, result_id }) =>
			run(async () => {
				const list: Any[] = await get(env, `api/assessment/participations/${participation_id}/results/${result_id}/details`);
				const feedback = [];
				for (const f of list ?? []) {
					let detail = f.detailText;
					if (f.hasLongFeedbackText && f.id) {
						try {
							detail = await (await request(env, `api/assessment/feedbacks/${f.id}/long-feedback`)).text();
						} catch {
							// keep the short text
						}
					}
					feedback.push({
						test: f.testCase?.testName,
						text: f.text,
						detail: detail && detail.length > 5000 ? `${detail.slice(0, 5000)} [truncated]` : detail,
						credits: f.credits,
						positive: f.positive,
						type: f.type,
						reference: f.reference,
					});
				}
				return json({ participation_id, result_id, count: feedback.length, feedback });
			}),
	);

	server.registerTool(
		"artemis_lectures",
		{ description: "Lectures of an Artemis course.", inputSchema: { course_id: courseIdArg }, annotations: ro },
		async ({ course_id }) =>
			run(async () => {
				const list: Any[] = await get(env, `api/lecture/courses/${course_id}/lectures-for-overview`);
				return json({
					lectures: (list ?? [])
						.map((l) => ({ id: l.id, title: l.title, start: l.startDate, end: l.endDate, tutorial: l.isTutorialLecture }))
						.sort((a, b) => (a.start ?? "").localeCompare(b.start ?? "")),
				});
			}),
	);

	server.registerTool(
		"artemis_lecture_details",
		{
			description: "Units of an Artemis lecture (attachments, exercises, text, video). Attachment units have a download_path for artemis_download_attachment.",
			inputSchema: { lecture_id: z.number().int().positive() },
			annotations: ro,
		},
		async ({ lecture_id }) =>
			run(async () => {
				const d = await get(env, `api/lecture/lectures/${lecture_id}/details`);
				return json({
					id: d.id,
					title: d.title,
					description: d.description,
					start: d.startDate,
					units: (d.lectureUnits ?? []).map((u: Any) => ({
						id: u.id,
						type: u.type,
						name: u.name ?? u.attachment?.name,
						release: u.releaseDate,
						completed: u.completed,
						description: u.description,
						video: u.videoSource,
						source: u.source,
						content: u.content,
						attachment: u.attachment
							? {
									name: u.attachment.name,
									type: u.attachment.attachmentType,
									uploaded: u.attachment.uploadDate,
									download_path:
										u.type === "attachment" || u.type === "attachment-video"
											? `api/core/files/attachments/attachment-video-units/${u.id}/student/${encodeURIComponent((u.attachment.link ?? "file.pdf").split("/").pop())}`
											: u.attachment.link
												? `api/core/files/${u.attachment.link.replace(/^\/?(api\/core\/files\/)?/, "")}`
												: undefined,
								}
							: undefined,
					})),
					merged_pdf_path: `api/core/files/attachments/lectures/${lecture_id}/merge-pdf`,
				});
			}),
	);

	server.registerTool(
		"artemis_download_attachment",
		{
			description: "Download an Artemis lecture file by its download_path (from artemis_lecture_details) or merged_pdf_path.",
			inputSchema: { path: z.string().describe("Path starting with api/core/files/") },
			annotations: ro,
		},
		async ({ path }) =>
			run(async () => {
				const clean = path.replace(/^https:\/\/artemis\.tum\.de\//, "").replace(/^\//, "");
				if (!clean.startsWith("api/core/files/") || clean.includes("..")) throw new Error("Only paths under api/core/files/ are allowed");
				const res = await request(env, clean);
				const mimeType = (res.headers.get("Content-Type") ?? "application/octet-stream").split(";")[0].trim();
				const filename = decodeURIComponent(clean.split("/").pop() ?? "file").replace(/^merge-pdf$/, "lecture.pdf");
				return fileResult(filename, mimeType, new Uint8Array(await res.arrayBuffer()), `artemis://${clean}`);
			}),
	);

	server.registerTool(
		"artemis_exams",
		{ description: "Exams of an Artemis course with dates and working time.", inputSchema: { course_id: courseIdArg }, annotations: ro },
		async ({ course_id }) =>
			run(async () => {
				const list: Any[] = await get(env, `api/exam/courses/${course_id}/exams-for-overview`);
				return json({
					exams: (list ?? []).map((x) => ({
						id: x.id,
						title: x.title,
						module: x.moduleNumber,
						visible: x.visibleDate,
						start: x.startDate,
						end: x.endDate,
						working_time_minutes: x.workingTime ? Math.round(x.workingTime / 60) : undefined,
						max_points: x.examMaxPoints,
						test_exam: x.testExam,
					})),
				});
			}),
	);

	server.registerTool(
		"artemis_channels",
		{ description: "Communication channels of an Artemis course with unread counts.", inputSchema: { course_id: courseIdArg }, annotations: ro },
		async ({ course_id }) =>
			run(async () => {
				const list: Any[] = await get(env, `api/communication/courses/${course_id}/channels/overview`);
				return json({
					channels: (list ?? []).map((c) => ({
						id: c.id,
						name: c.name,
						topic: c.topic,
						kind: c.subType,
						announcements: c.isAnnouncementChannel,
						member: c.isMember,
						course_wide: c.isCourseWide,
						archived: c.isArchived,
						unread: c.unreadMessagesCount,
						last_message: c.lastMessageDate,
					})),
				});
			}),
	);

	server.registerTool(
		"artemis_messages",
		{
			description: "Read messages of an Artemis channel, newest first, with thread answers. Reading a channel marks it as read in Artemis.",
			inputSchema: {
				course_id: courseIdArg,
				channel_id: z.number().int().positive(),
				search: z.string().optional(),
				page: z.number().int().min(0).default(0),
				size: z.number().int().min(1).max(100).default(20),
			},
			annotations: ro,
		},
		async ({ course_id, channel_id, search, page, size }) =>
			run(async () => {
				const list: Any[] = await get(env, `api/communication/courses/${course_id}/messages`, {
					conversationIds: channel_id,
					searchText: search,
					postSortCriterion: "CREATION_DATE",
					sortingOrder: "DESCENDING",
					page,
					size,
				});
				return json({
					channel_id,
					messages: (list ?? []).map((p) => ({
						id: p.id,
						author: p.author?.name,
						role: p.authorRole,
						created: p.creationDate,
						title: p.title,
						content: p.content,
						resolved: p.resolved,
						reactions: (p.reactions ?? []).length || undefined,
						answers: (p.answers ?? []).map((a: Any) => ({ id: a.id, author: a.author?.name, created: a.creationDate, content: a.content })),
					})),
				});
			}),
	);

	server.registerTool(
		"artemis_post_message",
		{
			description: `Post a new message to an Artemis channel. ${CONFIRM}`,
			inputSchema: {
				course_id: courseIdArg,
				channel_id: z.number().int().positive(),
				content: z.string().min(1).max(5000).describe("Markdown"),
				title: z.string().max(200).optional(),
			},
			annotations: write,
		},
		async ({ course_id, channel_id, content, title }) =>
			run(async () => {
				const res = await request(env, `api/communication/courses/${course_id}/messages`, {
					method: "POST",
					body: { content, title, hasForwardedMessages: false, conversation: { id: channel_id } },
				});
				const p = (await res.json()) as Any;
				return json({ posted: true, message_id: p.id });
			}),
	);

	server.registerTool(
		"artemis_reply_message",
		{
			description: `Reply in the thread of an Artemis message. ${CONFIRM}`,
			inputSchema: { course_id: courseIdArg, message_id: z.number().int().positive(), content: z.string().min(1).max(5000) },
			annotations: write,
		},
		async ({ course_id, message_id, content }) =>
			run(async () => {
				const res = await request(env, `api/communication/courses/${course_id}/answer-messages`, {
					method: "POST",
					body: { content, post: { id: message_id } },
				});
				const a = (await res.json()) as Any;
				return json({ posted: true, answer_id: a.id });
			}),
	);

	server.registerTool(
		"artemis_notifications",
		{
			description: "My Artemis course notifications (new exercises, results, posts), newest first. Without course_id: all my courses.",
			inputSchema: { course_id: courseIdArg.optional(), size: z.number().int().min(1).max(50).default(20) },
			annotations: ro,
		},
		async ({ course_id, size }) =>
			run(async () => {
				let ids: number[] = course_id ? [course_id] : [];
				if (!course_id) {
					const d = await get(env, "api/course/courses/for-dashboard");
					ids = (d.courses ?? []).map((c: Any) => c.course?.id).filter(Boolean);
				}
				const all = [];
				for (const id of ids.slice(0, 15)) {
					const page = await get(env, `api/notification/courses/${id}`, { page: 0, size });
					for (const n of page?.content ?? []) {
						all.push({
							id: n.notificationId,
							course: n.courseTitle,
							course_id: n.courseId,
							type: n.notificationType,
							category: n.category,
							time: n.creationDate,
							status: n.status,
							payload: n.payload,
							url: n.relativeWebAppUrl ? `${SITE}${n.relativeWebAppUrl}` : undefined,
						});
					}
				}
				all.sort((a, b) => String(b.time ?? "").localeCompare(String(a.time ?? "")));
				return json({ count: all.length, notifications: all.slice(0, size * (course_id ? 1 : 3)) });
			}),
	);
}

export async function artemisStatus(env: Env): Promise<PlatformStatus> {
	const platform = "artemis";
	try {
		// This endpoint is public: an expired token gives 204 instead of 401, so log in again once.
		let me = await get(env, "api/core/public/account");
		if (!me) {
			await storeDelete(env, STORE_KEY);
			me = await get(env, "api/core/public/account");
		}
		if (!me) return { platform, state: "login error", detail: "Artemis accepted the login but returned no account" };
		return { platform, state: "OK", detail: `logged in as ${me.name ?? me.login}` };
	} catch (e) {
		const detail = e instanceof Error ? e.message : String(e);
		if (e instanceof NotConfiguredError) return { platform, state: "not configured", detail };
		if (e instanceof LoginError) return { platform, state: "login error", detail };
		return { platform, state: "error", detail };
	}
}
