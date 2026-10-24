// Artemis exercise work through the same REST API as the web app (ls1intum/Artemis main 7fbd8ec).
// Text and modeling: save = submit before the due date (the server sets submitted=true on every save).
// Programming: online code editor repository API, commit triggers a build.
// Quizzes: course quizzes only (live and practice). Exams: no tools here (exam rules), only artemis_exams.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CONFIRM, json, run } from "../lib/tools";
import { get, request } from "./artemis";

// Artemis DTOs are large and differ per exercise type.
type Any = any;

const exerciseIdArg = z.number().int().positive().describe("Artemis exercise ID from artemis_exercises");
const participationIdArg = z.number().int().positive().describe("Participation ID from artemis_exercise_details or artemis_start_participation");

async function details(env: Env, exerciseId: number): Promise<Any> {
	const d = await get(env, `api/exercise/exercises/${exerciseId}/details`);
	return d.exercise ?? d;
}

/** The graded participation (not practice) of an exercise, else the first one. */
function participationOf(ex: Any): Any | undefined {
	const list: Any[] = ex.studentParticipations ?? [];
	return list.find((p) => !p.testRun && !/practice/i.test(String(p.type ?? ""))) ?? list[0];
}

function latestSubmission(p: Any): Any | undefined {
	return [...(p?.submissions ?? [])].sort((a, b) => String(b.submissionDate ?? "").localeCompare(String(a.submissionDate ?? "")) || (b.id ?? 0) - (a.id ?? 0))[0];
}

async function requireParticipation(env: Env, exerciseId: number): Promise<{ ex: Any; p: Any }> {
	const ex = await details(env, exerciseId);
	const p = participationOf(ex);
	if (!p) throw new Error(`No participation for exercise ${exerciseId}. Start it with artemis_start_participation first.`);
	return { ex, p };
}

const repoPath = (participationId: number, rest: string) => `api/programming/participations/${participationId}/repository${rest}`;

function checkPath(path: string) {
	if (!path || path.startsWith("/") || path.split("/").includes("..")) throw new Error(`Invalid repository path: ${path}`);
}

export function registerArtemisSubmitTools(server: McpServer, env: Env) {
	const ro = { readOnlyHint: true, openWorldHint: true };
	const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

	server.registerTool(
		"artemis_start_participation",
		{
			description: `Start working on an Artemis course exercise (creates my participation; for programming exercises also my repository). Needed before the first submission. practice=true starts practice mode after the due date. ${CONFIRM}`,
			inputSchema: { exercise_id: exerciseIdArg, practice: z.boolean().default(false) },
			annotations: write,
		},
		async ({ exercise_id, practice }) =>
			run(async () => {
				const path = practice
					? `api/exercise/exercises/${exercise_id}/participations/practice?useGradedParticipation=false`
					: `api/exercise/exercises/${exercise_id}/participations`;
				const p: Any = await (await request(env, path, { method: "POST" })).json();
				return json({ started: true, participation_id: p.id, state: p.initializationState, repository: p.repositoryUri, practice });
			}),
	);

	// ---------- text ----------

	server.registerTool(
		"artemis_text_get",
		{
			description: "My current text submission of an Artemis text exercise, with problem statement, submitted state and results.",
			inputSchema: { exercise_id: exerciseIdArg },
			annotations: ro,
		},
		async ({ exercise_id }) =>
			run(async () => {
				const { ex, p } = await requireParticipation(env, exercise_id);
				const d: Any = await get(env, `api/text/participations/${p.id}/text-editor`);
				const sub = latestSubmission(d) ?? latestSubmission(p);
				return json({
					exercise_id,
					title: ex.title,
					due: p.individualDueDate ?? ex.dueDate,
					problem_statement: ex.problemStatement,
					participation_id: p.id,
					submission_id: sub?.id,
					submitted: sub?.submitted,
					submission_date: sub?.submissionDate,
					language: sub?.language,
					text: sub?.text ?? "",
					results: (sub?.results ?? []).map((r: Any) => ({ id: r.id, score: r.score, completed: r.completionDate })),
				});
			}),
	);

	server.registerTool(
		"artemis_text_submit",
		{
			description: `Save my text for an Artemis text exercise. Before the due date every save counts as submitted (Artemis has no separate submit step). Replaces the current text. ${CONFIRM}`,
			inputSchema: { exercise_id: exerciseIdArg, text: z.string().min(1), language: z.enum(["ENGLISH", "GERMAN"]).optional() },
			annotations: { ...write, destructiveHint: true },
		},
		async ({ exercise_id, text, language }) =>
			run(async () => {
				const { p } = await requireParticipation(env, exercise_id);
				const d: Any = await get(env, `api/text/participations/${p.id}/text-editor`);
				const sub = latestSubmission(d);
				const r: Any = await (
					await request(env, `api/text/exercises/${exercise_id}/text-submissions`, {
						method: "PUT",
						body: { id: sub?.id ?? null, text, language: language ?? sub?.language ?? null, submitted: true },
					})
				).json();
				return json({ saved: true, submission_id: r.id, submitted: r.submitted, submission_date: r.submissionDate });
			}),
	);

	// ---------- modeling ----------

	server.registerTool(
		"artemis_modeling_get",
		{
			description: "My current model of an Artemis modeling exercise: diagram type, model JSON (Apollon format), explanation, results.",
			inputSchema: { exercise_id: exerciseIdArg },
			annotations: ro,
		},
		async ({ exercise_id }) =>
			run(async () => {
				const { ex, p } = await requireParticipation(env, exercise_id);
				const s: Any = await get(env, `api/modeling/participations/${p.id}/latest-modeling-submission`);
				return json({
					exercise_id,
					title: ex.title,
					diagram_type: s?.participation?.exercise?.diagramType ?? ex.diagramType,
					due: p.individualDueDate ?? ex.dueDate,
					problem_statement: ex.problemStatement,
					participation_id: p.id,
					submission_id: s?.id,
					submitted: s?.submitted,
					submission_date: s?.submissionDate,
					model: s?.model ?? null,
					explanation: s?.explanationText ?? "",
					results: (s?.results ?? []).map((r: Any) => ({ id: r.id, score: r.score, completed: r.completionDate })),
				});
			}),
	);

	server.registerTool(
		"artemis_modeling_submit",
		{
			description: `Save my model for an Artemis modeling exercise. model is the Apollon JSON as string (same structure as artemis_modeling_get returns). Before the due date every save counts as submitted. ${CONFIRM}`,
			inputSchema: { exercise_id: exerciseIdArg, model: z.string().min(2).describe("Apollon model JSON as a string"), explanation: z.string().optional() },
			annotations: { ...write, destructiveHint: true },
		},
		async ({ exercise_id, model, explanation }) =>
			run(async () => {
				try {
					JSON.parse(model);
				} catch {
					throw new Error("model must be valid JSON");
				}
				const { p } = await requireParticipation(env, exercise_id);
				const s: Any = await get(env, `api/modeling/participations/${p.id}/latest-modeling-submission`).catch(() => null);
				const r: Any = await (
					await request(env, `api/modeling/exercises/${exercise_id}/modeling-submissions`, {
						method: "PUT",
						body: { id: s?.id ?? null, model, explanationText: explanation ?? s?.explanationText ?? "", submitted: true },
					})
				).json();
				return json({ saved: true, submission_id: r.id, submitted: r.submitted, submission_date: r.submissionDate });
			}),
	);

	// ---------- programming ----------

	server.registerTool(
		"artemis_repo_files",
		{
			description: "Files and folders of my repository for an Artemis programming exercise (online code editor API), plus repository status (CLEAN / UNCOMMITTED_CHANGES / CONFLICT).",
			inputSchema: { participation_id: participationIdArg },
			annotations: ro,
		},
		async ({ participation_id }) =>
			run(async () => {
				const files: Record<string, string> = await get(env, repoPath(participation_id, "/files"));
				const status: Any = await get(env, repoPath(participation_id, "")).catch(() => undefined);
				const entries = Object.entries(files ?? {}).sort(([a], [b]) => a.localeCompare(b));
				return json({
					participation_id,
					status: status?.repositoryStatus,
					files: entries.filter(([, t]) => t === "FILE").map(([p]) => p),
					folders: entries.filter(([, t]) => t === "FOLDER").map(([p]) => p),
				});
			}),
	);

	server.registerTool(
		"artemis_repo_read_file",
		{
			description: "Read one file of my Artemis programming repository.",
			inputSchema: { participation_id: participationIdArg, path: z.string().min(1) },
			annotations: ro,
		},
		async ({ participation_id, path }) =>
			run(async () => {
				checkPath(path);
				const res = await request(env, repoPath(participation_id, `/file?file=${encodeURIComponent(path)}`));
				const text = await res.text();
				return json({ path, size: text.length, content: text.length > 200_000 ? `${text.slice(0, 200_000)}\n[truncated]` : text });
			}),
	);

	server.registerTool(
		"artemis_repo_write_files",
		{
			description: `Write files in my Artemis programming repository through the online code editor API. New files are created first. commit=true also commits, which starts a build and counts as a submission. ${CONFIRM}`,
			inputSchema: {
				participation_id: participationIdArg,
				files: z.array(z.object({ path: z.string().min(1), content: z.string() })).min(1).max(50),
				commit: z.boolean().default(false),
			},
			annotations: { ...write, destructiveHint: true },
		},
		async ({ participation_id, files, commit }) =>
			run(async () => {
				for (const f of files) checkPath(f.path);
				const existing: Record<string, string> = await get(env, repoPath(participation_id, "/files"));
				const created: string[] = [];
				for (const f of files) {
					if (existing?.[f.path] === "FOLDER") throw new Error(`${f.path} is a folder`);
					if (!existing?.[f.path]) {
						await request(env, repoPath(participation_id, `/file?file=${encodeURIComponent(f.path)}`), { method: "POST", rawBody: "" });
						created.push(f.path);
					}
				}
				const res: Record<string, string | null> = await (
					await request(env, repoPath(participation_id, `/files?commit=${commit}`), {
						method: "PUT",
						body: files.map((f) => ({ fileName: f.path, fileContent: f.content })),
					})
				).json();
				const errors = Object.entries(res ?? {}).filter(([, e]) => e);
				return json({ written: files.length - errors.length, created, errors: errors.length ? Object.fromEntries(errors) : undefined, committed: commit && !errors.length });
			}),
	);

	server.registerTool(
		"artemis_repo_commit",
		{
			description: `Commit the current changes of my Artemis programming repository. This starts a build and counts as a submission. ${CONFIRM}`,
			inputSchema: { participation_id: participationIdArg },
			annotations: write,
		},
		async ({ participation_id }) =>
			run(async () => {
				await request(env, repoPath(participation_id, "/commit"), { method: "POST", body: {} });
				return json({ committed: true, note: "The build runs now. Check it with artemis_build_result." });
			}),
	);

	server.registerTool(
		"artemis_build_result",
		{
			description: "Latest build and test result of my Artemis programming participation: score, passed tests, feedback per test, build logs if the build failed, and whether a build is still running.",
			inputSchema: { participation_id: participationIdArg },
			annotations: ro,
		},
		async ({ participation_id }) =>
			run(async () => {
				const base = `api/programming/programming-exercise-participations/${participation_id}`;
				const [result, pending]: Any[] = await Promise.all([
					get(env, `${base}/latest-result-with-feedbacks?withSubmission=true`).catch(() => null),
					get(env, `${base}/latest-pending-submission`).catch(() => null),
				]);
				let logs: Any[] = [];
				if (result?.submission?.buildFailed) logs = (await get(env, `api/programming/participations/${participation_id}/buildlogs`).catch(() => [])) ?? [];
				return json({
					participation_id,
					build_running: Boolean(pending?.id),
					pending_commit: pending?.commitHash,
					result: result
						? {
								id: result.id,
								completed: result.completionDate,
								score_percent: result.score,
								successful: result.successful,
								tests: result.testCaseCount ? `${result.passedTestCaseCount}/${result.testCaseCount}` : undefined,
								code_issues: result.codeIssueCount || undefined,
								commit: result.submission?.commitHash,
								build_failed: result.submission?.buildFailed,
								feedback: (result.feedbacks ?? []).map((f: Any) => ({
									test: f.testCase?.testName,
									passed: f.positive,
									text: f.text,
									detail: f.detailText ? String(f.detailText).slice(0, 3000) : undefined,
									credits: f.credits,
								})),
							}
						: null,
					build_logs: logs.length ? logs.slice(-200).map((l: Any) => l.log).join("\n") : undefined,
				});
			}),
	);

	server.registerTool(
		"artemis_trigger_build",
		{
			description: `Build the last commit of my Artemis programming repository again (for example after a failed build). ${CONFIRM}`,
			inputSchema: { participation_id: participationIdArg },
			annotations: write,
		},
		async ({ participation_id }) =>
			run(async () => {
				await request(env, `api/programming/participations/${participation_id}/trigger-build?submissionType=MANUAL`, { method: "POST" });
				return json({ triggered: true });
			}),
	);

	// ---------- quizzes ----------

	server.registerTool(
		"artemis_quiz_get",
		{
			description: "A course quiz for students: mode, batches, state, and the questions with answer options when the quiz is running or has ended (with solutions after the end). Does not start the quiz.",
			inputSchema: { exercise_id: exerciseIdArg },
			annotations: ro,
		},
		async ({ exercise_id }) =>
			run(async () => {
				const q: Any = await get(env, `api/quiz/quiz-exercises/${exercise_id}/for-student`);
				return json({
					id: q.id,
					title: q.title,
					mode: q.quizMode,
					duration_seconds: q.duration,
					started: q.quizStarted,
					ended: q.quizEnded,
					remaining_attempts: q.remainingNumberOfAttempts,
					batches: (q.quizBatches ?? []).map((b: Any) => ({ id: b.id, start: b.startTime, started: b.started, ended: b.ended })),
					questions: (q.quizQuestions ?? []).map((x: Any) => ({
						id: x.id,
						type: x.type,
						title: x.title,
						text: x.text,
						points: x.points,
						single_choice: x.singleChoice,
						options: x.answerOptions?.map((o: Any) => ({ id: o.id, text: o.text, correct: o.isCorrect })),
						drag_items: x.dragItems?.map((d: Any) => ({ id: d.id, text: d.text })),
						drop_locations: x.dropLocations?.map((d: Any) => ({ id: d.id })),
						spots: x.spots?.map((s: Any) => ({ id: s.id, number: s.spotNr })),
					})),
				});
			}),
	);

	const answerSchema = z.object({
		question_id: z.number().int().positive(),
		type: z.enum(["multiple-choice", "drag-and-drop", "short-answer"]),
		selected_option_ids: z.array(z.number().int()).optional(),
		mappings: z.array(z.object({ drag_item_id: z.number().int(), drop_location_id: z.number().int() })).optional(),
		texts: z.array(z.object({ spot_id: z.number().int(), text: z.string() })).optional(),
	});

	server.registerTool(
		"artemis_quiz_submit",
		{
			description: `Submit answers for a course quiz (not exams). mode "live": while the quiz runs (joins an individual quiz if needed, then submits for grading). mode "practice": after the quiz ended, returns the evaluated result. ${CONFIRM}`,
			inputSchema: { exercise_id: exerciseIdArg, mode: z.enum(["live", "practice"]), answers: z.array(answerSchema).min(1) },
			annotations: { ...write, destructiveHint: true },
		},
		async ({ exercise_id, mode, answers }) =>
			run(async () => {
				const q: Any = await get(env, `api/quiz/quiz-exercises/${exercise_id}/for-student`);
				if (q.exam || q.exerciseGroup) throw new Error("Exam quizzes are not supported");
				if (mode === "practice") {
					if (!q.quizEnded) throw new Error("Practice mode is only possible after the quiz ended");
					const body = {
						submittedAnswers: answers.map((a) => ({
							type: a.type,
							questionId: a.question_id,
							...(a.type === "multiple-choice" ? { selectedOptions: a.selected_option_ids ?? [] } : {}),
							...(a.type === "drag-and-drop" ? { mappings: (a.mappings ?? []).map((m) => ({ dragItemId: m.drag_item_id, dropLocationId: m.drop_location_id })) } : {}),
							...(a.type === "short-answer" ? { submittedTexts: (a.texts ?? []).map((t) => ({ text: t.text, spotId: t.spot_id })) } : {}),
						})),
					};
					const r: Any = await (await request(env, `api/quiz/exercises/${exercise_id}/submissions/practice`, { method: "POST", body })).json();
					return json({ mode, score: r.score ?? r.result?.score, result: r });
				}
				if (q.quizEnded) throw new Error("The quiz has ended. Use mode practice.");
				await request(env, `api/quiz/quiz-exercises/${exercise_id}/start-participation`, { method: "POST" });
				if (q.quizMode === "INDIVIDUAL") {
					try {
						await request(env, `api/quiz/quiz-exercises/${exercise_id}/join`, { method: "POST", body: {} });
					} catch {
						// already joined
					}
				} else if (q.quizMode === "BATCHED") {
					throw new Error("This quiz uses batches with a password. Join it in the Artemis web app.");
				}
				const body = {
					submittedAnswers: answers.map((a) => ({
						type: a.type,
						quizQuestion: { id: a.question_id },
						...(a.type === "multiple-choice" ? { selectedOptions: (a.selected_option_ids ?? []).map((id) => ({ id })) } : {}),
						...(a.type === "drag-and-drop" ? { mappings: (a.mappings ?? []).map((m) => ({ dragItem: { id: m.drag_item_id }, dropLocation: { id: m.drop_location_id } })) } : {}),
						...(a.type === "short-answer" ? { submittedTexts: (a.texts ?? []).map((t) => ({ text: t.text, spot: { id: t.spot_id } })) } : {}),
					})),
				};
				const r: Any = await (await request(env, `api/quiz/exercises/${exercise_id}/submissions/live?submit=true`, { method: "POST", body })).json();
				return json({ mode, submitted: r.submitted, submission_id: r.id, submission_date: r.submissionDate });
			}),
	);
}
