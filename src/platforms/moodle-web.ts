// Moodle tools that TUM blocks for AJAX (live probe 2026-10-17). Each tool tries the web service
// function first and falls back to the Moodle web pages through the SSO session:
// course/view.php, mod/forum/view.php, mod/forum/post.php, mod/assign/view.php, mod/quiz/view.php,
// mod/quiz/review.php, grade/report/overview/index.php, grade/report/user/index.php, pluginfile.php.
// Write actions use the normal Moodle web forms.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { fromBase64 } from "../lib/bytes";
import { fileResult } from "../lib/files";
import { decodeEntities, htmlToText } from "../lib/html";
import { cellText, type HtmlForm, keyValueRows, parseForms, parseLinks, parseTables } from "../lib/html-table";
import { guessMimeType } from "../lib/mime-types";
import { CONFIRM, json, run } from "../lib/tools";
import {
	type Any,
	courseIdArg,
	FunctionNotAllowedError,
	iso,
	MoodleClient,
	MoodleError,
	moduleSummary,
	myCourseIds,
	post,
	text,
	withClient,
} from "./moodle";
import { fetchIcsEvents } from "./moodle-feeds";

const SITE = "https://www.moodle.tum.de";

// ---------- page parsers (exported for tests) ----------

export interface WebModule {
	cmid: number;
	type: string;
	name: string;
	url?: string;
	dates: string[];
	description?: string;
}

export interface WebSection {
	number: number;
	name: string;
	summary?: string;
	modules: WebModule[];
}

function instanceName(html: string): string {
	const m = /<span[^>]*class="[^"]*\binstancename\b[^"]*"[^>]*>([\s\S]*?)<\/span>\s*(?:<\/a>|<\/div>|<span)/i.exec(html);
	const raw = m ? m[1].replace(/<span[^>]*class="[^"]*accesshide[^"]*"[^>]*>[\s\S]*?<\/span>/gi, "") : "";
	const name = cellText(raw);
	if (name) return name;
	const dataName = /data-activityname="([^"]*)"/.exec(html)?.[1];
	return dataName ? decodeEntities(dataName) : "";
}

function activityDates(html: string): string[] {
	const start = html.search(/data-region="activity-dates"/);
	if (start < 0) return [];
	// The region is a few nested divs. Take a bounded slice and turn every div into one line.
	const slice = html.slice(start, start + 3000).replace(/^[^>]*>/, "");
	const end = slice.search(/<\/div>\s*<\/div>\s*<\/div>|<div[^>]*class="(?:[^"]*\s)?(?:activity-completion|activity-altcontent)[\s"]/);
	const region = end >= 0 ? slice.slice(0, end) : slice;
	return region
		.split(/<\/?div\b[^>]*>/i)
		.map((part) => cellText(part))
		.filter((t) => t.length > 3);
}

/** Sections and activities of a Moodle 4 course page (course/view.php). */
export function parseCoursePage(html: string): WebSection[] {
	const sections: WebSection[] = [];
	const parts = html.split(/<li\b(?=[^>]*\bid="section-\d+")/i).slice(1);
	for (const part of parts) {
		const number = Number(/^[^>]*\bid="section-(\d+)"/.exec(part)?.[1] ?? sections.length);
		const name =
			decodeEntities(/data-sectionname="([^"]*)"/.exec(part.slice(0, 600))?.[1] ?? "") ||
			cellText(/<h3[^>]*class="[^"]*sectionname[^"]*"[^>]*>([\s\S]*?)<\/h3>/i.exec(part)?.[1] ?? "") ||
			`Section ${number}`;
		const summaryHtml = /<div[^>]*class="[^"]*\bsummarytext\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(part)?.[1];
		const modules: WebModule[] = [];
		const mparts = part.split(/<li\b(?=[^>]*\bid="module-\d+")/i).slice(1);
		for (const mp of mparts) {
			const head = /^[^>]*>/.exec(mp)?.[0] ?? "";
			const cmid = Number(/id="module-(\d+)"/.exec(head)?.[1]);
			const type = /modtype_(\w+)/.exec(head)?.[1] ?? /\/mod\/(\w+)\/view\.php/.exec(mp)?.[1] ?? "unknown";
			const url = /href="([^"]*\/mod\/\w+\/view\.php\?id=\d+[^"]*)"/.exec(mp)?.[1];
			const desc = /<div[^>]*class="[^"]*\b(?:contentafterlink|activity-altcontent|description)\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(mp)?.[1];
			modules.push({
				cmid,
				type,
				name: instanceName(mp),
				url: url ? decodeEntities(url) : undefined,
				dates: activityDates(mp),
				description: desc ? text(desc, 500) : undefined,
			});
		}
		sections.push({ number, name, summary: summaryHtml ? text(summaryHtml, 500) : undefined, modules });
	}
	return sections;
}

export interface WebDiscussion {
	discussion_id: number;
	subject: string;
	author?: string;
	last_post?: string;
	replies?: string;
}

const DATE_TAIL = /\s+(?:\d{1,2}\.\s*[A-Za-zäöüÄÖÜ]{3,}\.?\s+\d{4}|\d{1,2}\.\d{1,2}\.\d{2,4}|[A-Z][a-z]{2}\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[A-Z][a-z]{2,}\s+\d{4}).*$/;

/** Author cell of a discussion row: the first text block, without the date Moodle puts next to it. */
export function authorName(cellHtml: string): string {
	const blocks = cellHtml
		.split(/<\/?(?:div|br|time|small)\b[^>]*>/i)
		.map((b) => cellText(b))
		.filter(Boolean);
	return (blocks[0] ?? "").replace(DATE_TAIL, "").trim();
}

/** Discussion list of a forum page (mod/forum/view.php). */
export function parseForumPage(html: string): { discussions: WebDiscussion[]; forum_id?: number } {
	const discussions: WebDiscussion[] = [];
	const seen = new Set<number>();
	for (const row of html.matchAll(/<tr\b[^>]*data-discussionid="(\d+)"[^>]*>([\s\S]*?)<\/tr>/gi)) {
		const id = Number(row[1]);
		if (seen.has(id)) continue;
		seen.add(id);
		const cells = [...row[2].matchAll(/<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi)];
		const subjectLink = /<a[^>]*href="[^"]*discuss\.php\?d=\d+[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(row[2]);
		const authorCell = cells.find((c) => /author/i.test(c[2]));
		const lastCell = cells.find((c) => /lastpost|modified|last-post/i.test(c[2]));
		const repliesCell = cells.find((c) => /replies/i.test(c[2]));
		discussions.push({
			discussion_id: id,
			subject: cellText(subjectLink?.[1] ?? "") || cellText(cells[0]?.[3] ?? ""),
			author: authorCell ? authorName(authorCell[3]) : undefined,
			last_post: lastCell ? cellText(lastCell[3]) : undefined,
			replies: repliesCell ? cellText(repliesCell[3]) : undefined,
		});
	}
	if (!discussions.length) {
		for (const a of html.matchAll(/<a\b[^>]*href="[^"]*\/mod\/forum\/discuss\.php\?d=(\d+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)) {
			const id = Number(a[1]);
			const subject = cellText(a[2]);
			if (seen.has(id) || !subject) continue;
			seen.add(id);
			discussions.push({ discussion_id: id, subject });
		}
	}
	const forumId = Number(/post\.php\?forum=(\d+)/.exec(html)?.[1] ?? /name="forum" value="(\d+)"/.exec(html)?.[1] ?? /data-forumid="(\d+)"/.exec(html)?.[1] ?? NaN);
	return { discussions, forum_id: Number.isFinite(forumId) ? forumId : undefined };
}

/** Main content region of a Moodle page, as text. */
export function mainText(html: string, max = 6000): string {
	const region = /<div[^>]*role="main"[^>]*>([\s\S]*)$/i.exec(html)?.[1] ?? /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ?? html;
	const cut = region.split(/<footer\b|<div[^>]*id="page-footer"/i)[0];
	const t = htmlToText(cut).replace(/\n{3,}/g, "\n\n").trim();
	return t.length > max ? `${t.slice(0, max)} [truncated]` : t;
}

/** Error or notice text on a Moodle page after a form submission. */
function pageError(html: string): string | undefined {
	const m =
		/<div[^>]*class="[^"]*\b(?:alert-danger|error|errorbox|form-control-feedback invalid-feedback)\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(html) ??
		/<span[^>]*class="[^"]*\berror\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(html);
	const t = m ? cellText(m[1]) : "";
	return t || undefined;
}

function formWith(forms: HtmlForm[], test: (f: HtmlForm) => boolean, what: string): HtmlForm {
	const f = forms.find(test);
	if (!f) throw new MoodleError(`Moodle page has no ${what} form. Check the link with moodle_page.`);
	return f;
}

async function submitForm(m: MoodleClient, form: HtmlForm, fields: Record<string, string>, button: string) {
	const body = new URLSearchParams({ ...form.fields, ...fields });
	body.set(button, form.buttons[button] ?? "1");
	return m.web(form.action, { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
}

const ANNOUNCEMENT_RE = /ankündigung|announcement|news|neuigkeit|nachrichten|aktuelles/i;

/** Course structure from core_courseformat_get_state (AJAX, used by the Moodle 4 course index). */
export function parseCourseState(state: Any): WebSection[] {
	const st = typeof state === "string" ? JSON.parse(state) : state;
	const cms = new Map<number, Any>((st.cm ?? []).map((c: Any) => [Number(c.id), c]));
	return (st.section ?? []).map((sec: Any) => ({
		number: Number(sec.number ?? sec.section ?? 0),
		name: decodeEntities(String(sec.title ?? sec.name ?? "")),
		modules: (sec.cmlist ?? [])
			.map((id: Any) => cms.get(Number(id)))
			.filter((c: Any) => c && c.uservisible !== false)
			.map((c: Any) => ({
				cmid: Number(c.id),
				type: String(c.module ?? c.modname ?? /\/mod\/(\w+)\//.exec(c.url ?? "")?.[1] ?? "unknown"),
				name: decodeEntities(String(c.name ?? "")),
				url: c.url ? String(c.url) : undefined,
				dates: [],
			})),
	}));
}

/**
 * Sections and activities of a course. First the course index state (AJAX), then the course page.
 * Activity dates come from the course page when it shows them.
 */
async function coursePage(m: MoodleClient, courseId: number): Promise<WebSection[]> {
	let fromState: WebSection[] | undefined;
	try {
		fromState = parseCourseState(await m.call("core_courseformat_get_state", { courseid: courseId }));
	} catch (e) {
		if (!(e instanceof FunctionNotAllowedError) && !(e instanceof MoodleError)) throw e;
	}
	const html = await m.page(`/course/view.php?id=${courseId}`);
	const fromHtml = parseCoursePage(html);
	if (!fromState?.some((s) => s.modules.length)) {
		if (fromHtml.some((s) => s.modules.length)) return fromHtml;
		// Fallback: every activity link on the page.
		const seen = new Set<number>();
		const modules: WebModule[] = [];
		for (const l of parseLinks(html, new URL(SITE))) {
			const mm = /\/mod\/(\w+)\/view\.php\?id=(\d+)/.exec(l.url);
			if (!mm || seen.has(Number(mm[2]))) continue;
			seen.add(Number(mm[2]));
			modules.push({ cmid: Number(mm[2]), type: mm[1], name: l.text, url: l.url, dates: [] });
		}
		return [{ number: 0, name: "all activities on the course page", modules }];
	}
	const dates = new Map(fromHtml.flatMap((s) => s.modules.map((x) => [x.cmid, x] as const)));
	return fromState.map((s) => ({
		...s,
		modules: s.modules.map((x) => ({ ...x, dates: dates.get(x.cmid)?.dates ?? [], description: dates.get(x.cmid)?.description })),
	}));
}

function modulesOf(sections: WebSection[], type: string) {
	return sections.flatMap((s) => s.modules.filter((x) => x.type === type).map((x) => ({ ...x, section: s.name, sectionNumber: s.number })));
}

async function webCourseIds(m: MoodleClient, courseId?: number): Promise<{ id: number; name: string }[]> {
	if (courseId) {
		const r = await m.call("core_course_get_enrolled_courses_by_timeline_classification", { classification: "all", limit: 0 }).catch(() => undefined);
		const hit = (r?.courses ?? []).find((c: Any) => c.id === courseId);
		return [{ id: courseId, name: hit ? decodeEntities(hit.fullname) : String(courseId) }];
	}
	const r = await m.call("core_course_get_enrolled_courses_by_timeline_classification", { classification: "inprogress", limit: 0 });
	return (r.courses ?? []).map((c: Any) => ({ id: c.id, name: decodeEntities(c.fullname ?? "") }));
}

/** Runs the AJAX path; when TUM blocks the function, runs the web path instead. */
async function ajaxOrWeb(ajax: () => Promise<CallToolResult>, web: () => Promise<CallToolResult>): Promise<CallToolResult> {
	try {
		return await ajax();
	} catch (e) {
		if (e instanceof FunctionNotAllowedError) return web();
		throw e;
	}
}

const MAX_COURSES = 12;

export function registerMoodleWebTools(server: McpServer, env: Env) {
	const ro = { readOnlyHint: true, openWorldHint: true };
	const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

	server.registerTool(
		"moodle_page",
		{
			description:
				"Read any Moodle page (path or URL on www.moodle.tum.de) through the SSO session as text with its links, or as raw HTML. Fallback for anything the other moodle_ tools do not cover.",
			inputSchema: {
				path: z.string().min(1).describe('e.g. "/course/view.php?id=123" or a full www.moodle.tum.de URL'),
				raw_html: z.boolean().default(false),
				max_chars: z.number().int().min(500).max(100_000).default(15_000),
			},
			annotations: ro,
		},
		async ({ path, raw_html, max_chars }) =>
			withClient(env, async (m) => {
				const r = await m.web(path);
				if (raw_html) return json({ url: r.url.href, status: r.status, html: r.text.replace(/sesskey=[A-Za-z0-9]+/g, "sesskey=REMOVED").replace(/"sesskey":"[^"]+"/g, '"sesskey":"REMOVED"').slice(0, max_chars) });
				// Links that carry the session key (logout) are left out, so the key does not leave the server.
				const seen = new Set<string>();
				const links = parseLinks(r.text, r.url).filter((l) => {
					if (!l.url.startsWith(SITE) || !l.text || /\/(theme|lib)\//.test(l.url) || /sesskey=/i.test(l.url) || seen.has(l.url)) return false;
					seen.add(l.url);
					return true;
				});
				return json({ url: r.url.href, status: r.status, text: mainText(r.text, max_chars), links: links.slice(0, 200) });
			}),
	);

	server.registerTool(
		"moodle_course_contents",
		{
			description: "Sections and activities of a Moodle course (cmid, type, name, link, dates). Files: pass the activity link to moodle_download_file.",
			inputSchema: { course_id: courseIdArg },
			annotations: ro,
		},
		async ({ course_id }) =>
			withClient(env, (m) =>
				ajaxOrWeb(
					async () => {
						const sections = await m.call("core_course_get_contents", { courseid: course_id });
						return json({
							course_id,
							source: "web service",
							sections: sections.map((s: Any) => ({ id: s.id, name: s.name, summary: text(s.summary, 1000), modules: (s.modules ?? []).map(moduleSummary) })),
						});
					},
					async () => json({ course_id, source: "course index (core_courseformat_get_state) and course/view.php", sections: await coursePage(m, course_id) }),
				),
			),
	);

	server.registerTool(
		"moodle_download_file",
		{
			description:
				"Download a Moodle file: a pluginfile.php URL, or an activity link such as mod/resource/view.php?id=… (the file behind it is downloaded). Images as image, text as text, others as base64 resource.",
			inputSchema: { url: z.string().min(1).describe("URL or path on www.moodle.tum.de") },
			annotations: ro,
		},
		async ({ url }) =>
			withClient(env, async (m) => {
				const u = new URL(url, SITE);
				if (m.mode === "session" && /\/mod\/\w+\/view\.php/.test(u.pathname)) {
					// Activity page: Moodle either redirects to the file or shows a page with the file link.
					const r = await m.web(u);
					let fileUrl = /pluginfile\.php/.test(r.url.pathname) ? r.url.href : undefined;
					if (!fileUrl) {
						const link = parseLinks(r.text, r.url).find((l) => /\/pluginfile\.php\//.test(l.url));
						const obj = /<(?:object|iframe|embed)[^>]*(?:data|src)="([^"]*pluginfile\.php[^"]*)"/i.exec(r.text)?.[1];
						fileUrl = link?.url ?? (obj ? new URL(decodeEntities(obj), r.url).href : undefined);
					}
					if (!fileUrl) throw new MoodleError("No file found behind this activity. Use moodle_page to look at it.");
					const f = await m.download(fileUrl);
					return fileResult(f.filename, f.mimeType, f.bytes, `moodle://${encodeURIComponent(f.filename)}`);
				}
				const f = await m.download(u.href);
				return fileResult(f.filename, f.mimeType, f.bytes, `moodle://${encodeURIComponent(f.filename)}`);
			}),
	);

	server.registerTool(
		"moodle_forums",
		{
			description: "Forums of my current courses (or one course), with cmid. 'announcements' marks the news forum.",
			inputSchema: { course_id: courseIdArg.optional() },
			annotations: ro,
		},
		async ({ course_id }) =>
			withClient(env, (m) =>
				ajaxOrWeb(
					async () => {
						const courseids = course_id ? [course_id] : await myCourseIds(m);
						const forums = await m.call("mod_forum_get_forums_by_courses", { courseids });
						return json({
							source: "web service",
							forums: forums.map((f: Any) => ({ id: f.id, course_id: f.course, cmid: f.cmid, name: f.name, type: f.type, announcements: f.type === "news" })),
						});
					},
					async () => {
						const out: Record<string, unknown>[] = [];
						for (const c of (await webCourseIds(m, course_id)).slice(0, MAX_COURSES)) {
							const forums = modulesOf(await coursePage(m, c.id), "forum");
							forums.forEach((f, i) =>
								out.push({ course_id: c.id, course: c.name, cmid: f.cmid, name: f.name, announcements: ANNOUNCEMENT_RE.test(f.name) || (i === 0 && f.sectionNumber === 0) }),
							);
						}
						return json({ source: "web page course/view.php", note: "Use cmid with moodle_forum_discussions.", forums: out });
					},
				),
			),
	);

	server.registerTool(
		"moodle_forum_discussions",
		{
			description: "Discussions of a Moodle forum (by forum_id or cmid), newest first. Read the posts with moodle_discussion_posts.",
			inputSchema: {
				forum_id: z.number().int().positive().optional().describe("Forum instance ID"),
				cmid: z.number().int().positive().optional().describe("Course module ID from moodle_forums or moodle_course_contents"),
				per_page: z.number().int().min(1).max(100).default(20),
			},
			annotations: ro,
		},
		async ({ forum_id, cmid, per_page }) =>
			withClient(env, async (m) => {
				if (!forum_id && !cmid) throw new Error("Give forum_id or cmid");
				return ajaxOrWeb(
					async () => {
						if (!forum_id) throw new FunctionNotAllowedError("no forum_id", "notallowed");
						const d = await m.call("mod_forum_get_forum_discussions", { forumid: forum_id, sortorder: 1, page: 0, perpage: per_page });
						return json({
							source: "web service",
							discussions: (d.discussions ?? []).map((x: Any) => ({
								discussion_id: x.discussion,
								subject: x.subject ?? x.name,
								author: x.userfullname,
								created: iso(x.created),
								last_post: iso(x.timemodified),
								replies: x.numreplies,
							})),
						});
					},
					async () => {
						const page = await m.page(cmid ? `/mod/forum/view.php?id=${cmid}` : `/mod/forum/view.php?f=${forum_id}`);
						const parsed = parseForumPage(page);
						return json({ source: "web page mod/forum/view.php", forum_id: parsed.forum_id, discussions: parsed.discussions.slice(0, per_page) });
					},
				);
			}),
	);

	server.registerTool(
		"moodle_announcements",
		{
			description: "Latest announcements (posts in the news forums) of my current courses or one course, with text.",
			inputSchema: { course_id: courseIdArg.optional(), per_course: z.number().int().min(1).max(20).default(3) },
			annotations: ro,
		},
		async ({ course_id, per_course }) =>
			withClient(env, (m) =>
				ajaxOrWeb(
					async () => {
						const courseids = course_id ? [course_id] : await myCourseIds(m);
						const forums = (await m.call("mod_forum_get_forums_by_courses", { courseids })).filter((f: Any) => f.type === "news");
						const out = [];
						for (const f of forums) {
							const d = await m.call("mod_forum_get_forum_discussions", { forumid: f.id, sortorder: 1, page: 0, perpage: per_course });
							for (const x of d.discussions ?? []) {
								out.push({ course_id: f.course, discussion_id: x.discussion, subject: x.subject ?? x.name, author: x.userfullname, time: iso(x.created), message: text(x.message, 3000) });
							}
						}
						return json({ source: "web service", count: out.length, announcements: out });
					},
					async () => {
						const out = [];
						const notes: string[] = [];
						for (const c of (await webCourseIds(m, course_id)).slice(0, MAX_COURSES)) {
							const forums = modulesOf(await coursePage(m, c.id), "forum");
							const news = forums.find((f) => ANNOUNCEMENT_RE.test(f.name)) ?? forums.find((f) => f.sectionNumber === 0);
							if (!news) {
								notes.push(`${c.name}: no announcement forum found`);
								continue;
							}
							const { discussions } = parseForumPage(await m.page(`/mod/forum/view.php?id=${news.cmid}`));
							for (const d of discussions.slice(0, per_course)) {
								let posts: Any[] = [];
								try {
									posts = (await m.call("mod_forum_get_discussion_posts", { discussionid: d.discussion_id, sortby: "created", sortdirection: "ASC" })).posts ?? [];
								} catch {
									// keep the list entry without text
								}
								const first = posts[0] ? post(posts[0]) : undefined;
								out.push({
									course_id: c.id,
									course: c.name,
									forum: news.name,
									discussion_id: d.discussion_id,
									subject: d.subject,
									author: first?.author ?? d.author,
									time: first?.time ?? d.last_post,
									message: first?.message,
								});
							}
						}
						out.sort((a, b) => String(b.time ?? "").localeCompare(String(a.time ?? "")));
						return json({ source: "web pages plus mod_forum_get_discussion_posts", count: out.length, announcements: out, notes: notes.length ? notes : undefined });
					},
				),
			),
	);

	server.registerTool(
		"moodle_forum_post",
		{
			description: `Start a new discussion in a Moodle forum through the normal Moodle web form. Give the forum cmid (from moodle_forums) or forum_id. ${CONFIRM}`,
			inputSchema: {
				cmid: z.number().int().positive().optional(),
				forum_id: z.number().int().positive().optional(),
				subject: z.string().min(1).max(255),
				message: z.string().min(1).describe("Plain text or HTML"),
			},
			annotations: write,
		},
		async ({ cmid, forum_id, subject, message }) =>
			withClient(env, async (m) => {
				let forumId = forum_id;
				if (!forumId) {
					if (!cmid) throw new Error("Give cmid or forum_id");
					forumId = parseForumPage(await m.page(`/mod/forum/view.php?id=${cmid}`)).forum_id;
					if (!forumId) throw new MoodleError("Could not find the forum ID on the forum page. You may not be allowed to post in this forum.");
				}
				const page = await m.web(`/mod/forum/post.php?forum=${forumId}`);
				const form = formWith(parseForms(page.text, page.url), (f) => /post\.php/.test(f.action.pathname) && "subject" in f.fields, "new discussion");
				const html = /<[a-z][\s\S]*>/i.test(message) ? message : message.split(/\n{2,}/).map((p) => `<p>${p.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>")}</p>`).join("");
				const r = await submitForm(m, form, { subject, "message[text]": html, "message[format]": "1" }, "submitbutton");
				if (/\/mod\/forum\/(view|discuss)\.php/.test(r.url.pathname)) return json({ posted: true, page: r.url.href });
				throw new MoodleError(`Moodle did not accept the post: ${pageError(r.text) ?? `ended at ${r.url.pathname}`}`);
			}),
	);

	server.registerTool(
		"moodle_assignments",
		{
			description: "Assignments of my current courses (or one course) with cmid and the dates shown by Moodle.",
			inputSchema: { course_id: courseIdArg.optional() },
			annotations: ro,
		},
		async ({ course_id }) =>
			withClient(env, (m) =>
				ajaxOrWeb(
					async () => {
						const courseids = course_id ? [course_id] : await myCourseIds(m);
						const r = await m.call("mod_assign_get_assignments", { courseids });
						const out = [];
						for (const c of r.courses ?? []) {
							for (const a of c.assignments ?? []) out.push({ id: a.id, cmid: a.cmid, course_id: c.id, name: a.name, due: iso(a.duedate), cutoff: iso(a.cutoffdate) });
						}
						return json({ source: "web service", count: out.length, assignments: out });
					},
					async () => {
						const out = [];
						for (const c of (await webCourseIds(m, course_id)).slice(0, MAX_COURSES)) {
							for (const a of modulesOf(await coursePage(m, c.id), "assign")) {
								out.push({ cmid: a.cmid, course_id: c.id, course: c.name, name: a.name, dates: a.dates, section: a.section, url: a.url });
							}
						}
						return json({ source: "web page course/view.php", count: out.length, assignments: out, note: "Status and due date details: moodle_assignment_status with the cmid." });
					},
				),
			),
	);

	server.registerTool(
		"moodle_assignment_status",
		{
			description: "Submission and grading status of one assignment (by cmid): dates, submission status, grading status, files, grade and feedback.",
			inputSchema: { cmid: z.number().int().positive().describe("Course module ID from moodle_assignments") },
			annotations: ro,
		},
		async ({ cmid }) =>
			withClient(env, async (m) => {
				const r = await m.web(`/mod/assign/view.php?id=${cmid}`);
				const status = keyValueRows(r.text);
				const files = parseLinks(r.text, r.url)
					.filter((l) => /\/pluginfile\.php\/.*\/assign(submission|feedback)_/.test(l.url))
					.map((l) => ({ name: l.text, url: l.url }));
				const intro = /<div[^>]*(?:id="intro"|class="[^"]*\bactivity-description\b[^"]*")[^>]*>([\s\S]*?)<\/div>/i.exec(r.text)?.[1];
				return json({
					cmid,
					source: "web page mod/assign/view.php",
					title: cellText(/<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(r.text)?.[1] ?? ""),
					dates: activityDates(r.text),
					description: intro ? text(intro, 3000) : undefined,
					status,
					files,
					can_edit: /action=editsubmission/.test(r.text),
					can_submit: /action=submit\b/.test(r.text),
				});
			}),
	);

	const submitForGrading = z.boolean().default(false).describe("Also submit for grading (final in courses that require it)");

	async function finishSubmission(m: MoodleClient, cmid: number): Promise<boolean> {
		const page = await m.web(`/mod/assign/view.php?id=${cmid}&action=submit`);
		const form = formWith(parseForms(page.text, page.url), (f) => /assign\/view\.php/.test(f.action.pathname) && "action" in f.fields, "submit for grading");
		const fields: Record<string, string> = {};
		if (/name="submissionstatement"/.test(page.text)) fields.submissionstatement = "1";
		const r = await submitForm(m, form, fields, "submitbutton");
		const err = pageError(r.text);
		if (err) throw new MoodleError(`Submit for grading failed: ${err}`);
		return true;
	}

	server.registerTool(
		"moodle_assignment_submit_text",
		{
			description: `Save an online text submission for an assignment (by cmid) through the Moodle web form, optionally submit for grading. ${CONFIRM}`,
			inputSchema: { cmid: z.number().int().positive(), text: z.string().min(1).describe("Plain text or HTML"), submit_for_grading: submitForGrading },
			annotations: { ...write, destructiveHint: true },
		},
		async ({ cmid, text: body, submit_for_grading }) =>
			withClient(env, async (m) => {
				const page = await m.web(`/mod/assign/view.php?id=${cmid}&action=editsubmission`);
				const form = formWith(parseForms(page.text, page.url), (f) => "onlinetext_editor[text]" in f.fields, "online text submission");
				const html = /<[a-z][\s\S]*>/i.test(body) ? body : body.split(/\n{2,}/).map((p) => `<p>${p.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>")}</p>`).join("");
				const r = await submitForm(m, form, { "onlinetext_editor[text]": html, "onlinetext_editor[format]": "1" }, "submitbutton");
				const err = pageError(r.text);
				if (err && /action=editsubmission|savesubmission/.test(r.url.search)) throw new MoodleError(`Moodle did not save the submission: ${err}`);
				const submitted = submit_for_grading ? await finishSubmission(m, cmid) : false;
				return json({ saved: true, submitted_for_grading: submitted, status: keyValueRows((await m.web(`/mod/assign/view.php?id=${cmid}`)).text) });
			}),
	);

	server.registerTool(
		"moodle_assignment_submit_file",
		{
			description: `Upload a file as assignment submission (by cmid) through the Moodle web form and file picker, optionally submit for grading. ${CONFIRM}`,
			inputSchema: {
				cmid: z.number().int().positive(),
				filename: z.string().min(1),
				content_base64: z.string(),
				mime_type: z.string().optional(),
				submit_for_grading: submitForGrading,
			},
			annotations: { ...write, destructiveHint: true },
		},
		async ({ cmid, filename, content_base64, mime_type, submit_for_grading }) =>
			withClient(env, async (m) => {
				const page = await m.web(`/mod/assign/view.php?id=${cmid}&action=editsubmission`);
				const form = formWith(parseForms(page.text, page.url), (f) => "files_filemanager" in f.fields, "file submission");
				const itemid = form.fields.files_filemanager;
				const repoId = /"id":"?(\d+)"?,"name":"[^"]*","type":"upload"/.exec(page.text)?.[1] ?? /"type":"upload"[^}]*?"id":"?(\d+)/.exec(page.text)?.[1];
				const clientId = /"client_id":"([0-9a-f]+)"/.exec(page.text)?.[1] ?? "";
				const ctxId = /"context":\{"id":(\d+)/.exec(page.text)?.[1] ?? /"contextid":(\d+)/.exec(page.text)?.[1] ?? "";
				if (!repoId) throw new MoodleError("Could not find the Moodle upload repository on the submission page");
				const up = new FormData();
				up.append("repo_upload_file", new Blob([fromBase64(content_base64)], { type: mime_type || guessMimeType(filename) }), filename);
				for (const [k, v] of Object.entries({
					sesskey: await m.sesskey(),
					repo_id: repoId,
					itemid,
					author: "",
					license: "allrightsreserved",
					title: filename,
					savepath: "/",
					env: "filemanager",
					client_id: clientId,
					ctx_id: ctxId,
					p: "",
					page: "",
				})) {
					up.append(k, v);
				}
				const ur = await m.web(`/repository/repository_ajax.php?action=upload`, { method: "POST", body: up });
				let uj: Any;
				try {
					uj = JSON.parse(ur.text);
				} catch {
					throw new MoodleError(`File upload failed: ${cellText(ur.text).slice(0, 200)}`);
				}
				if (uj.error) throw new MoodleError(`File upload failed: ${uj.error}`);
				const r = await submitForm(m, form, {}, "submitbutton");
				const err = pageError(r.text);
				if (err && /editsubmission|savesubmission/.test(r.url.search)) throw new MoodleError(`Moodle did not save the submission: ${err}`);
				const submitted = submit_for_grading ? await finishSubmission(m, cmid) : false;
				return json({ uploaded: true, saved: true, submitted_for_grading: submitted, status: keyValueRows((await m.web(`/mod/assign/view.php?id=${cmid}`)).text) });
			}),
	);

	server.registerTool(
		"moodle_quizzes",
		{ description: "Quizzes of my current courses (or one course) with cmid and dates.", inputSchema: { course_id: courseIdArg.optional() }, annotations: ro },
		async ({ course_id }) =>
			withClient(env, (m) =>
				ajaxOrWeb(
					async () => {
						const courseids = course_id ? [course_id] : await myCourseIds(m);
						const r = await m.call("mod_quiz_get_quizzes_by_courses", { courseids });
						return json({
							source: "web service",
							quizzes: (r.quizzes ?? []).map((q: Any) => ({ id: q.id, cmid: q.coursemodule, course_id: q.course, name: q.name, opens: iso(q.timeopen), closes: iso(q.timeclose) })),
						});
					},
					async () => {
						const out = [];
						for (const c of (await webCourseIds(m, course_id)).slice(0, MAX_COURSES)) {
							for (const q of modulesOf(await coursePage(m, c.id), "quiz")) out.push({ cmid: q.cmid, course_id: c.id, course: c.name, name: q.name, dates: q.dates });
						}
						return json({ source: "web page course/view.php", quizzes: out });
					},
				),
			),
	);

	server.registerTool(
		"moodle_quiz_attempts",
		{
			description: "My attempts of a quiz (by cmid): state, marks, grade and review attempt IDs, plus the quiz info box.",
			inputSchema: { cmid: z.number().int().positive().describe("Quiz course module ID from moodle_quizzes") },
			annotations: ro,
		},
		async ({ cmid }) =>
			withClient(env, async (m) => {
				const r = await m.web(`/mod/quiz/view.php?id=${cmid}`);
				const table = parseTables(r.text).find((t) => /quizattemptsummary/.test(t.className)) ?? parseTables(r.text).find((t) => t.rowHtml.some((h) => /review\.php\?attempt=/.test(h)));
				const attempts = table
					? table.rows.map((row, i) => ({
							...Object.fromEntries(row.map((v, j) => [table.headers[j] || `col${j + 1}`, v])),
							attempt_id: Number(/review\.php\?attempt=(\d+)/.exec(table.rowHtml[i])?.[1]) || undefined,
						}))
					: [];
				const info = /<div[^>]*class="[^"]*\bquizinfo\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(r.text)?.[1];
				const feedback = /<div[^>]*id="feedback"[^>]*>([\s\S]*?)<\/div>/i.exec(r.text)?.[1];
				return json({
					cmid,
					source: "web page mod/quiz/view.php",
					dates: activityDates(r.text),
					info: info ? text(info, 1500) : undefined,
					attempts,
					overall_feedback: feedback ? text(feedback, 1500) : undefined,
				});
			}),
	);

	server.registerTool(
		"moodle_quiz_attempt_review",
		{
			description: "Result of a finished quiz attempt (attempt_id from moodle_quiz_attempts): summary and each question as text, as far as the review options allow.",
			inputSchema: { attempt_id: z.number().int().positive() },
			annotations: ro,
		},
		async ({ attempt_id }) =>
			withClient(env, async (m) => {
				const r = await m.web(`/mod/quiz/review.php?attempt=${attempt_id}&showall=1`);
				const summaryTable = /<table[^>]*class="[^"]*quizreviewsummary[^"]*"[^>]*>[\s\S]*?<\/table>/i.exec(r.text)?.[0] ?? "";
				const questions = [...r.text.matchAll(/<div\b[^>]*\bid="question-[\d-]+"[^>]*class="([^"]*\bque\b[^"]*)"[^>]*>([\s\S]*?)(?=<div\b[^>]*\bid="question-[\d-]+"|<div[^>]*class="[^"]*submitbtns)/gi)].map(
					(q, i) => ({ number: i + 1, state: /\b(correct|incorrect|partiallycorrect|notanswered|complete)\b/.exec(q[1])?.[1], text: text(q[2], 2500) }),
				);
				return json({ attempt_id, source: "web page mod/quiz/review.php", summary: keyValueRows(summaryTable), questions });
			}),
	);

	server.registerTool(
		"moodle_grades_overview",
		{ description: "My grades across all Moodle courses (course name, grade, course ID).", inputSchema: {}, annotations: ro },
		async () =>
			withClient(env, (m) =>
				ajaxOrWeb(
					async () => {
						const r = await m.call("gradereport_overview_get_course_grades", { userid: await m.me() });
						return json({ source: "web service", grades: (r.grades ?? []).map((g: Any) => ({ course_id: g.courseid, grade: g.grade, raw: g.rawgrade, rank: g.rank })) });
					},
					async () => {
						const r = await m.web("/grade/report/overview/index.php");
						const tables = parseTables(r.text);
						const t = tables.find((x) => /overview-grade/.test(x.id) || /overview-grade/.test(x.className)) ?? tables[0];
						if (!t) return json({ source: "web page grade/report/overview", grades: [], text: mainText(r.text, 3000) });
						return json({
							source: "web page grade/report/overview",
							columns: t.headers,
							grades: t.rows.map((row, i) => ({
								course: row[0],
								grade: row[1],
								rank: row[2],
								course_id: Number(/[?&;](?:id|course)=(\d+)/.exec(t.rowHtml[i])?.[1]) || undefined,
							})),
						});
					},
				),
			),
	);

	server.registerTool(
		"moodle_course_grades",
		{ description: "My grade items in one Moodle course (item, grade, range, percentage, feedback).", inputSchema: { course_id: courseIdArg }, annotations: ro },
		async ({ course_id }) =>
			withClient(env, (m) =>
				ajaxOrWeb(
					async () => {
						const r = await m.call("gradereport_user_get_grade_items", { courseid: course_id, userid: await m.me() });
						const items = r.usergrades?.[0]?.gradeitems ?? [];
						return json({
							course_id,
							source: "web service",
							items: items.map((i: Any) => ({ name: i.itemname ?? i.itemtype, grade: i.gradeformatted, range: i.rangeformatted, percentage: i.percentageformatted, feedback: text(i.feedback, 1000) })),
						});
					},
					async () => {
						const r = await m.web(`/grade/report/user/index.php?id=${course_id}`);
						const t = parseTables(r.text).find((x) => /user-grade/.test(x.className) || /user-grade/.test(x.id));
						if (!t) return json({ course_id, source: "web page grade/report/user", items: [], text: mainText(r.text, 3000) });
						return json({
							course_id,
							source: "web page grade/report/user",
							columns: t.headers,
							items: t.rows.filter((row) => row.some(Boolean)).map((row) => Object.fromEntries(row.map((v, j) => [t.headers[j] || `col${j + 1}`, v]))),
						});
					},
				),
			),
	);

	server.registerTool(
		"moodle_calendar_events",
		{
			description: "Moodle calendar events in a date range. Uses the web service, else the iCal export (MOODLE_CALENDAR_URL).",
			inputSchema: {
				from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Start date YYYY-MM-DD"),
				to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("End date YYYY-MM-DD (inclusive)"),
			},
			annotations: ro,
		},
		async ({ from, to }) =>
			run(async () => {
				const timestart = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000);
				const timeend = Math.floor(Date.parse(`${to}T23:59:59Z`) / 1000);
				try {
					const m = MoodleClient.create(env);
					const r = await m.call("core_calendar_get_calendar_events", { options: { userevents: 1, siteevents: 1, timestart, timeend } });
					return json({
						source: "web service",
						events: (r.events ?? []).map((e: Any) => ({ name: e.name, course_id: e.courseid, type: e.eventtype, start: iso(e.timestart), description: text(e.description, 1000) })),
					});
				} catch (e) {
					if (!env.MOODLE_CALENDAR_URL?.trim()) throw e;
				}
				const fromIso = new Date(timestart * 1000).toISOString();
				const toIso = new Date(timeend * 1000).toISOString();
				const events = (await fetchIcsEvents(env))
					.filter((e) => e.start && e.start >= fromIso.slice(0, e.all_day ? 10 : 30) && e.start <= toIso)
					.sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""));
				return json({ source: "moodle calendar export (iCal)", count: events.length, events });
			}),
	);
}
