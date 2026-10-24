// TUM Moodle (www.moodle.tum.de).
// Mode "token": REST web service with secret MOODLE_TOKEN (any service the token belongs to).
// Mode "session": no MOODLE_TOKEN, so the server logs in through TUM SSO with TUM_USER/TUM_PASSWORD
// and calls the same functions through lib/ajax/service.php. Only AJAX-enabled functions work there.
// Checked on 2026-10-17: TUM Moodle has enablemobilewebservice = 0, so the Moodle app token
// (service moodle_mobile_app) is not available. See README.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { htmlToText } from "../lib/html";
import { CookieJar, type JarResponse, jarFetch } from "../lib/http";
import { storeDelete, storeGet, storePut } from "../lib/store";
import { CONFIRM, json, LoginError, NotConfiguredError, type PlatformStatus, run, withTimeout } from "../lib/tools";
import { tumSsoLogin } from "../lib/tum-sso";
import { icsUpcoming } from "./moodle-feeds";

const SITE = "https://www.moodle.tum.de";
const HOST = "www.moodle.tum.de";
const SSO_START = `${SITE}/Shibboleth.sso/Login?providerId=${encodeURIComponent("https://tumidp.lrz.de/idp/shibboleth")}&target=${encodeURIComponent(`${SITE}/auth/shibboleth/index.php`)}`;
const TIMEOUT_MS = 30_000;
const SESSION_KEY = "moodle-session";

export class MoodleError extends Error {
	constructor(
		message: string,
		public errorcode?: string,
	) {
		super(message);
	}
}

export class FunctionNotAllowedError extends MoodleError {}

export type Args = Record<string, unknown>;
// Moodle responses are large and vary per function.
export type Any = any;

/** PHP-style form encoding: a[0][b]=1 */
export function flattenArgs(value: unknown, prefix = "", out = new URLSearchParams()): URLSearchParams {
	if (value === undefined || value === null) return out;
	if (Array.isArray(value)) value.forEach((v, i) => flattenArgs(v, `${prefix}[${i}]`, out));
	else if (typeof value === "object") {
		for (const [k, v] of Object.entries(value as Args)) flattenArgs(v, prefix ? `${prefix}[${k}]` : k, out);
	} else out.append(prefix, typeof value === "boolean" ? (value ? "1" : "0") : String(value));
	return out;
}

interface Session {
	cookies: Record<string, Record<string, string>>;
	sesskey: string;
	userid?: number;
}

function notAllowed(fn: string, mode: string, detail: string): FunctionNotAllowedError {
	const hint =
		mode === "token"
			? "The service of MOODLE_TOKEN does not include this function. Run moodle_site_info to see the allowed functions."
			: "This function is not available through the Moodle web session (not AJAX-enabled). A MOODLE_TOKEN for a service with this function is needed.";
	return new FunctionNotAllowedError(`Moodle function ${fn} is not allowed. ${hint} (${detail})`, "notallowed");
}

/** Finds the logged-in user's ID in a Moodle page. */
export function userIdFromHtml(html: string): number | undefined {
	// Moodle 4 links the user menu to /user/profile.php without an ID, so look at other own-user links too.
	const patterns = [
		/"userId":\s*(\d+)/,
		/"userid":\s*(\d+)/,
		/data-userid="(\d+)"/,
		/data-user-id="(\d+)"/,
		/user\/edit\.php\?id=(\d+)/,
		/mod\/forum\/user\.php\?id=(\d+)/,
		/grade\/report\/overview\/index\.php\?[^"]*userid=(\d+)/,
		/blog\/index\.php\?userid=(\d+)/,
		/[?&;]userid=(\d+)/,
		/user\/profile\.php\?id=(\d+)/,
	];
	for (const re of patterns) {
		const m = re.exec(html);
		if (m && Number(m[1]) > 1) return Number(m[1]);
	}
	return undefined;
}

export class MoodleClient {
	userid?: number;
	private session?: Session;
	private jar?: CookieJar;

	constructor(
		private env: Env,
		public mode: "token" | "session",
	) {}

	static create(env: Env): MoodleClient {
		if (env.MOODLE_TOKEN?.trim()) return new MoodleClient(env, "token");
		if (env.TUM_USER?.trim() && env.TUM_PASSWORD?.trim()) return new MoodleClient(env, "session");
		throw new NotConfiguredError("moodle", ["MOODLE_TOKEN (or TUM_USER and TUM_PASSWORD for the SSO session)"]);
	}

	async call(fn: string, args: Args = {}): Promise<Any> {
		return this.mode === "token" ? this.callToken(fn, args) : this.callSession(fn, args, true);
	}

	private async callToken(fn: string, args: Args): Promise<Any> {
		const body = flattenArgs(args);
		body.set("wstoken", this.env.MOODLE_TOKEN.trim());
		body.set("wsfunction", fn);
		body.set("moodlewsrestformat", "json");
		const res = await withTimeout(fetch(`${SITE}/webservice/rest/server.php`, { method: "POST", body }), TIMEOUT_MS, "Moodle");
		const text = await res.text();
		let data: Any;
		try {
			data = JSON.parse(text);
		} catch {
			throw new MoodleError(`Moodle returned no JSON for ${fn} (HTTP ${res.status})`);
		}
		if (data && typeof data === "object" && !Array.isArray(data) && data.exception) {
			const code = String(data.errorcode ?? "");
			const msg = `${data.message ?? ""} ${data.debuginfo ?? ""}`.trim();
			if (code === "invalidtoken") throw new LoginError(`Moodle token rejected: ${msg}`);
			if (code === "accessexception" || code === "servicenotavailable" || /not allowed|nicht erlaubt|not available/i.test(msg)) {
				throw notAllowed(fn, "token", msg);
			}
			throw new MoodleError(`Moodle ${fn}: ${msg} [${code}]`, code);
		}
		return data;
	}

	private async loadSession(forceLogin: boolean): Promise<Session> {
		if (!forceLogin) {
			this.session ??= await storeGet<Session>(this.env, SESSION_KEY);
			if (this.session) return this.session;
		}
		const jar = new CookieJar();
		const page = await tumSsoLogin(this.env, jar, SSO_START);
		let html = page.text;
		if (page.url.hostname !== HOST || !/"sesskey":"/.test(html)) {
			html = (await jarFetch(jar, `${SITE}/my/`)).text;
		}
		const sesskey = /"sesskey":"([^"]+)"/.exec(html)?.[1];
		if (!sesskey) throw new LoginError("Moodle SSO login finished, but no Moodle session was found");
		let userid = userIdFromHtml(html);
		if (!userid) userid = userIdFromHtml((await jarFetch(jar, `${SITE}/user/profile.php`)).text);
		this.session = { cookies: jar.toJSON(), sesskey, userid };
		await storePut(this.env, SESSION_KEY, this.session, 2 * 3600);
		return this.session;
	}

	private async callSession(fn: string, args: Args, retry: boolean): Promise<Any> {
		const s = await this.loadSession(false);
		const jar = new CookieJar(s.cookies);
		const res = await jarFetch(jar, `${SITE}/lib/ajax/service.php?sesskey=${encodeURIComponent(s.sesskey)}&info=${encodeURIComponent(fn)}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify([{ index: 0, methodname: fn, args }]),
		});
		let data: Any;
		try {
			data = JSON.parse(res.text);
		} catch {
			data = undefined;
		}
		const first = Array.isArray(data) ? data[0] : data;
		const ex = first?.exception ?? (first?.error && typeof first.error === "object" ? first.error : undefined);
		const code = String(ex?.errorcode ?? first?.errorcode ?? "");
		if (!first || res.status === 401 || /servicerequireslogin|invalidsesskey|requirelogin/.test(code)) {
			if (retry) {
				await storeDelete(this.env, SESSION_KEY);
				this.session = undefined;
				await this.loadSession(true);
				return this.callSession(fn, args, false);
			}
			throw new LoginError(`Moodle session expired or invalid (${code || `HTTP ${res.status}`})`);
		}
		if (first.error) {
			const msg = String(ex?.message ?? first.error);
			if (/servicenotavailable|not available|ajax/i.test(`${code} ${msg}`)) throw notAllowed(fn, "session", msg);
			throw new MoodleError(`Moodle ${fn}: ${msg} [${code}]`, code);
		}
		return first.data;
	}

	/**
	 * Requests a Moodle web page with the session cookies (session mode only). Logs in again once when
	 * Moodle answers with its login page. Cookie updates are kept for the rest of this client.
	 */
	async web(path: string | URL, init: { method?: string; body?: BodyInit; headers?: Record<string, string> } = {}): Promise<JarResponse> {
		if (this.mode !== "session") throw new MoodleError("Moodle web pages need the SSO session (TUM_USER and TUM_PASSWORD)");
		for (let attempt = 0; attempt < 2; attempt++) {
			const s = await this.loadSession(attempt > 0);
			this.jar ??= new CookieJar(s.cookies);
			const url = new URL(path, SITE);
			if (url.hostname !== HOST) throw new Error(`Only pages on ${HOST} are allowed`);
			const r = await jarFetch(this.jar, url, init);
			if (r.url.hostname === HOST && !/\/login\/index\.php/.test(r.url.pathname)) return r;
			await storeDelete(this.env, SESSION_KEY);
			this.session = undefined;
			this.jar = undefined;
		}
		throw new LoginError("Moodle session could not be restored");
	}

	async page(path: string): Promise<string> {
		return (await this.web(path)).text;
	}

	async sesskey(): Promise<string> {
		return (await this.loadSession(false)).sesskey;
	}

	/** Session mode: user ID through AJAX (core_user_get_users_by_field), else from own-user links in pages. */
	private async userIdBySession(): Promise<number | undefined> {
		const lookups: [string, string | undefined][] = [
			["username", this.env.TUM_USER?.trim().toLowerCase()],
			["email", this.env.TUM_EMAIL?.trim().toLowerCase()],
			["username", this.env.TUM_EMAIL?.trim().toLowerCase()],
		];
		for (const [field, value] of lookups) {
			if (!value) continue;
			try {
				const users = await this.call("core_user_get_users_by_field", { field, values: [value] });
				if (Array.isArray(users) && users.length === 1 && users[0].id > 1) return users[0].id;
			} catch (e) {
				if (e instanceof LoginError) throw e;
				if (e instanceof FunctionNotAllowedError) break;
			}
		}
		// Own pages only: other pages can link to other users.
		for (const path of ["/user/profile.php", "/user/preferences.php", "/grade/report/overview/index.php"]) {
			const id = userIdFromHtml(await this.page(path));
			if (id) return id;
		}
		return undefined;
	}

	async me(): Promise<number> {
		if (this.userid) return this.userid;
		if (this.mode === "session") {
			// core_webservice_get_site_info is not AJAX-enabled, so the user ID comes from the pages.
			const s = await this.loadSession(false);
			const id = s.userid ?? (await this.userIdBySession());
			if (!id) throw new MoodleError("Could not find the Moodle user ID (AJAX lookup and session pages failed)");
			if (!s.userid) {
				s.userid = id;
				await storePut(this.env, SESSION_KEY, s, 2 * 3600);
			}
			return (this.userid = id);
		}
		const info = await this.call("core_webservice_get_site_info");
		this.userid = info.userid;
		return info.userid;
	}

	/** Tries functions in order and returns the first allowed one. */
	async first(calls: [string, Args][]): Promise<{ fn: string; data: Any }> {
		let last: unknown;
		for (const [fn, args] of calls) {
			try {
				return { fn, data: await this.call(fn, args) };
			} catch (e) {
				if (!(e instanceof FunctionNotAllowedError)) throw e;
				last = e;
			}
		}
		throw last;
	}

	async download(url: string): Promise<{ bytes: Uint8Array; mimeType: string; filename: string }> {
		const u = new URL(url, SITE);
		if (u.hostname !== HOST) throw new Error(`Only files from ${HOST} can be downloaded`);
		let res: Response;
		if (this.mode === "token") {
			u.pathname = u.pathname.replace(/^\/pluginfile\.php/, "/webservice/pluginfile.php");
			u.searchParams.set("token", this.env.MOODLE_TOKEN.trim());
			res = await withTimeout(fetch(u), TIMEOUT_MS, "Moodle download");
		} else {
			const s = await this.loadSession(false);
			const jar = new CookieJar(s.cookies);
			u.pathname = u.pathname.replace(/^\/webservice\/pluginfile\.php/, "/pluginfile.php");
			const headers: Record<string, string> = {};
			const cookie = jar.header(u);
			if (cookie) headers.Cookie = cookie;
			res = await withTimeout(fetch(u, { headers }), TIMEOUT_MS, "Moodle download");
		}
		if (!res.ok) throw new MoodleError(`Download failed: HTTP ${res.status}`);
		const mimeType = (res.headers.get("Content-Type") ?? "application/octet-stream").split(";")[0].trim();
		if (mimeType === "text/html" && /\/pluginfile\.php/.test(u.pathname)) {
			const text = await res.text();
			if (/login|anmelden|errorcode/i.test(text.slice(0, 5000))) throw new LoginError("Moodle answered with a login or error page instead of the file");
			return { bytes: new TextEncoder().encode(text), mimeType, filename: decodeURIComponent(u.pathname.split("/").pop() ?? "file") };
		}
		const disposition = res.headers.get("Content-Disposition") ?? "";
		const filename =
			decodeURIComponent(/filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1] ?? "") ||
			/filename="([^"]+)"/i.exec(disposition)?.[1] ||
			decodeURIComponent(u.pathname.split("/").pop() ?? "file");
		return { bytes: new Uint8Array(await res.arrayBuffer()), mimeType, filename };
	}

	/**
	 * One request with the session cookies and no redirect following (session mode). For the watcher:
	 * the redirect of mod/resource/view.php?redirect=1 names the current file revision.
	 */
	async rawFetch(url: string, redirect: "manual" | "follow" = "manual"): Promise<Response> {
		if (this.mode !== "session") throw new MoodleError("Raw Moodle requests need the SSO session");
		const u = new URL(url, SITE);
		if (u.hostname !== HOST) throw new Error(`Only ${HOST} is allowed`);
		const s = await this.loadSession(false);
		const headers: Record<string, string> = {};
		const cookie = new CookieJar(s.cookies).header(u);
		if (cookie) headers.Cookie = cookie;
		return withTimeout(fetch(u, { headers, redirect }), TIMEOUT_MS, "Moodle");
	}

	/** Uploads a file to the user's draft area (token mode only). Returns the draft item ID. */
	async uploadDraft(filename: string, bytes: Uint8Array, mimeType: string): Promise<number> {
		if (this.mode !== "token") {
			throw new FunctionNotAllowedError("File upload needs MOODLE_TOKEN. The SSO session mode cannot upload files.", "notallowed");
		}
		const form = new FormData();
		form.append("token", this.env.MOODLE_TOKEN.trim());
		form.append("filearea", "draft");
		form.append("itemid", "0");
		form.append("file_1", new Blob([bytes], { type: mimeType }), filename);
		const res = await withTimeout(fetch(`${SITE}/webservice/upload.php`, { method: "POST", body: form }), TIMEOUT_MS, "Moodle upload");
		const data: Any = JSON.parse(await res.text());
		if (!Array.isArray(data) || !data[0]?.itemid) throw new MoodleError(`Moodle upload failed: ${data?.error ?? data?.message ?? JSON.stringify(data).slice(0, 200)}`);
		return data[0].itemid;
	}
}

// ---------- formatting ----------

export const iso = (ts: number | undefined | null) => (ts ? new Date(ts * 1000).toISOString() : undefined);
export const text = (html: string | undefined | null, max = 4000) => {
	if (!html) return undefined;
	const t = htmlToText(html);
	return t.length > max ? `${t.slice(0, max)} [truncated]` : t;
};

export function moduleSummary(m: Any) {
	return {
		id: m.id,
		name: m.name,
		type: m.modname,
		instance: m.instance,
		url: m.url,
		visible: m.uservisible !== false,
		description: text(m.description, 1000),
		files: (m.contents ?? [])
			.filter((c: Any) => c.type === "file")
			.map((c: Any) => ({ filename: c.filename, size: c.filesize, mime_type: c.mimetype, url: c.fileurl, modified: iso(c.timemodified) })),
		links: (m.contents ?? []).filter((c: Any) => c.type === "url").map((c: Any) => c.fileurl),
		completion: m.completiondata?.state,
	};
}

export function post(p: Any) {
	return {
		id: p.id,
		subject: p.subject,
		author: p.author?.fullname ?? p.userfullname,
		time: iso(p.timecreated ?? p.created),
		parent_id: p.parentid ?? p.parent,
		message: text(p.message, 8000),
		attachments: (p.attachments ?? []).map((a: Any) => ({ filename: a.filename, url: a.url ?? a.fileurl, size: a.filesize })),
	};
}

export const courseIdArg = z.number().int().positive().describe("Moodle course ID from moodle_courses");

/** Tool name, Moodle function, and arguments. "write" functions get empty arguments, so Moodle rejects them before running. */
const PROBES: { tools: string; fn: string; args: (ctx: { userid: number; courseid: number }) => Args; write?: boolean }[] = [
	{ tools: "user ID lookup", fn: "core_user_get_users_by_field", args: () => ({ field: "id", values: [2] }) },
	{ tools: "moodle_courses", fn: "core_course_get_enrolled_courses_by_timeline_classification", args: () => ({ classification: "all", limit: 1 }) },
	{ tools: "moodle_courses (preferred)", fn: "core_enrol_get_users_courses", args: (c) => ({ userid: c.userid }) },
	{ tools: "moodle_course_contents", fn: "core_course_get_contents", args: (c) => ({ courseid: c.courseid }) },
	{ tools: "moodle_course_contents (course index)", fn: "core_courseformat_get_state", args: (c) => ({ courseid: c.courseid }) },
	{ tools: "moodle_forums, moodle_announcements", fn: "mod_forum_get_forums_by_courses", args: (c) => ({ courseids: [c.courseid] }) },
	{ tools: "moodle_forum_discussions, moodle_announcements", fn: "mod_forum_get_forum_discussions", args: () => ({ forumid: 1, sortorder: 1, page: 0, perpage: 1 }) },
	{ tools: "moodle_discussion_posts", fn: "mod_forum_get_discussion_posts", args: () => ({ discussionid: 1 }) },
	{ tools: "moodle_forum_post", fn: "mod_forum_add_discussion", args: () => ({}), write: true },
	{ tools: "moodle_forum_reply", fn: "mod_forum_add_discussion_post", args: () => ({}), write: true },
	{ tools: "moodle_assignments", fn: "mod_assign_get_assignments", args: (c) => ({ courseids: [c.courseid] }) },
	{ tools: "moodle_assignment_status", fn: "mod_assign_get_submission_status", args: () => ({ assignid: 1 }) },
	{ tools: "moodle_assignment_submit_text, moodle_assignment_submit_file", fn: "mod_assign_save_submission", args: () => ({}), write: true },
	{ tools: "moodle_assignment_submit_* (submit_for_grading)", fn: "mod_assign_submit_for_grading", args: () => ({}), write: true },
	{ tools: "moodle_quizzes", fn: "mod_quiz_get_quizzes_by_courses", args: (c) => ({ courseids: [c.courseid] }) },
	{ tools: "moodle_quiz_attempts", fn: "mod_quiz_get_user_attempts", args: () => ({ quizid: 1, status: "all" }) },
	{ tools: "moodle_quiz_attempts (best grade)", fn: "mod_quiz_get_user_best_grade", args: () => ({ quizid: 1 }) },
	{ tools: "moodle_quiz_attempt_review", fn: "mod_quiz_get_attempt_review", args: () => ({ attemptid: 1 }) },
	{ tools: "moodle_grades_overview", fn: "gradereport_overview_get_course_grades", args: (c) => ({ userid: c.userid }) },
	{ tools: "moodle_course_grades", fn: "gradereport_user_get_grade_items", args: (c) => ({ courseid: c.courseid, userid: c.userid }) },
	{ tools: "moodle_calendar_events", fn: "core_calendar_get_calendar_events", args: () => ({ options: { userevents: 1, siteevents: 1, timestart: Math.floor(Date.now() / 1000), timeend: Math.floor(Date.now() / 1000) + 86400 } }) },
	{ tools: "moodle_upcoming_deadlines", fn: "core_calendar_get_action_events_by_timesort", args: () => ({ timesortfrom: Math.floor(Date.now() / 1000), limitnum: 1 }) },
	{ tools: "moodle_conversations", fn: "core_message_get_conversations", args: (c) => ({ userid: c.userid, limitfrom: 0, limitnum: 1 }) },
	{ tools: "moodle_conversation_messages", fn: "core_message_get_conversation_messages", args: (c) => ({ currentuserid: c.userid, convid: 1, limitnum: 1 }) },
	{ tools: "moodle_search_users", fn: "core_message_message_search_users", args: (c) => ({ userid: c.userid, search: "test", limitnum: 1 }) },
	{ tools: "moodle_send_message", fn: "core_message_send_instant_messages", args: () => ({}), write: true },
	{ tools: "moodle_notifications", fn: "message_popup_get_popup_notifications", args: (c) => ({ useridto: c.userid, limit: 1, offset: 0 }) },
	{ tools: "moodle_notifications (fallback)", fn: "core_message_get_messages", args: (c) => ({ useridto: c.userid, type: "notifications", limitnum: 1 }) },
];

async function probe(m: MoodleClient) {
	let userid: number | undefined;
	let useridError: string | undefined;
	try {
		userid = await m.me();
	} catch (e) {
		if (e instanceof LoginError) throw e;
		useridError = e instanceof Error ? e.message : String(e);
	}
	let courseid = 1;
	try {
		const r = await m.call("core_course_get_enrolled_courses_by_timeline_classification", { classification: "all", limit: 1 });
		courseid = r.courses?.[0]?.id ?? 1;
	} catch {
		// keep the site course
	}
	const results: { tools: string; function: string; result: "allowed" | "not allowed" | "skipped"; note?: string }[] = [];
	for (let i = 0; i < PROBES.length; i += 6) {
		const batch = PROBES.slice(i, i + 6);
		const out = await Promise.all(
			batch.map(async (p) => {
				const args = p.args({ userid: userid ?? 0, courseid });
				if (!userid && JSON.stringify(args).match(/"(userid|useridto|currentuserid)":0/)) {
					return { tools: p.tools, function: p.fn, result: "skipped" as const, note: "needs the user ID, which was not found" };
				}
				try {
					await m.call(p.fn, args);
					return { tools: p.tools, function: p.fn, result: "allowed" as const };
				} catch (e) {
					if (e instanceof FunctionNotAllowedError) return { tools: p.tools, function: p.fn, result: "not allowed" as const };
					if (e instanceof LoginError) throw e;
					// Any other error (invalid parameter, record not found) means Moodle reached the function.
					const note = e instanceof Error ? e.message.slice(0, 160) : String(e);
					return { tools: p.tools, function: p.fn, result: "allowed" as const, note: p.write ? "write function, rejected test arguments as expected" : note };
				}
			}),
		);
		results.push(...out);
	}
	return {
		user_id: userid,
		user_id_error: useridError,
		allowed: results.filter((r) => r.result === "allowed").length,
		skipped: results.filter((r) => r.result === "skipped").length || undefined,
		not_allowed: results.filter((r) => r.result === "not allowed").length,
		probes: results,
	};
}

export function withClient(env: Env, fn: (m: MoodleClient) => Promise<CallToolResult>): Promise<CallToolResult> {
	return run(async () => fn(MoodleClient.create(env)));
}

export async function myCourseIds(m: MoodleClient): Promise<number[]> {
	const courses = await listCourses(m);
	return courses.map((c: Any) => c.id);
}

export async function listCourses(m: MoodleClient): Promise<Any[]> {
	const userid = await m.me().catch(() => undefined);
	const calls: [string, Args][] = [];
	if (userid) calls.push(["core_enrol_get_users_courses", { userid }]);
	calls.push(["core_course_get_enrolled_courses_by_timeline_classification", { classification: "all", limit: 0 }]);
	const { data } = await m.first(calls);
	return Array.isArray(data) ? data : (data.courses ?? []);
}

export function registerMoodleTools(server: McpServer, env: Env) {
	const ro = { readOnlyHint: true, openWorldHint: true };
	const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

	server.registerTool(
		"moodle_site_info",
		{
			description:
				"Moodle connection info. Token mode: user, site and the web service functions the token allows. SSO session mode: core_webservice_get_site_info is not available there, so this runs moodle_probe instead.",
			inputSchema: {},
			annotations: ro,
		},
		async () =>
			withClient(env, async (m) => {
				if (m.mode === "session") return json({ mode: m.mode, ...(await probe(m)) });
				const info = await m.call("core_webservice_get_site_info");
				return json({
					mode: m.mode,
					site: info.sitename,
					release: info.release,
					user: { id: info.userid, name: info.fullname, username: info.username },
					function_count: info.functions?.length,
					functions: (info.functions ?? []).map((f: Any) => f.name).sort(),
					upload_allowed: info.uploadfiles,
					download_allowed: info.downloadfiles,
				});
			}),
	);

	server.registerTool(
		"moodle_probe",
		{
			description:
				"Test which Moodle tools work: calls the Moodle function behind each moodle_ tool once and reports allowed or not allowed. Write functions are called with empty arguments, which Moodle rejects before it does anything.",
			inputSchema: {},
			annotations: ro,
		},
		async () => withClient(env, async (m) => json({ mode: m.mode, ...(await probe(m)) })),
	);

	server.registerTool(
		"moodle_courses",
		{ description: "List my Moodle courses with IDs.", inputSchema: {}, annotations: ro },
		async () =>
			withClient(env, async (m) => {
				const courses = await listCourses(m);
				return json({
					count: courses.length,
					courses: courses.map((c: Any) => ({
						id: c.id,
						name: c.fullname,
						short_name: c.shortname,
						start: iso(c.startdate),
						end: iso(c.enddate),
						progress: c.progress,
						last_access: iso(c.lastaccess),
						url: `${SITE}/course/view.php?id=${c.id}`,
					})),
				});
			}),
	);

	server.registerTool(
		"moodle_discussion_posts",
		{ description: "Read all posts of a Moodle forum discussion.", inputSchema: { discussion_id: z.number().int().positive() }, annotations: ro },
		async ({ discussion_id }) =>
			withClient(env, async (m) => {
				const r = await m.call("mod_forum_get_discussion_posts", { discussionid: discussion_id, sortby: "created", sortdirection: "ASC" });
				return json({ discussion_id, posts: (r.posts ?? []).map(post) });
			}),
	);

	server.registerTool(
		"moodle_forum_reply",
		{
			description: `Reply to a Moodle forum post. ${CONFIRM}`,
			inputSchema: {
				post_id: z.number().int().positive().describe("ID of the post to reply to (from moodle_discussion_posts)"),
				subject: z.string().min(1),
				message: z.string().min(1),
			},
			annotations: write,
		},
		async ({ post_id, subject, message }) =>
			withClient(env, async (m) => {
				const r = await m.call("mod_forum_add_discussion_post", { postid: post_id, subject, message });
				return json({ posted: true, post_id: r.postid });
			}),
	);

	server.registerTool(
		"moodle_upcoming_deadlines",
		{
			description:
				"Upcoming Moodle deadlines (assignments, quizzes and other action events) in the next N days, soonest first. Uses the Moodle session, and the iCal export (MOODLE_CALENDAR_URL) when the session fails or is not configured.",
			inputSchema: { days: z.number().int().min(1).max(365).default(14), limit: z.number().int().min(1).max(50).default(30) },
			annotations: ro,
		},
		async ({ days, limit }) =>
			run(async () => {
				let sessionError: string | undefined;
				try {
					const m = MoodleClient.create(env);
					const now = Math.floor(Date.now() / 1000);
					const r = await m.call("core_calendar_get_action_events_by_timesort", {
						timesortfrom: now,
						timesortto: now + days * 86400,
						limitnum: limit,
					});
					return json({
						source: `moodle ${m.mode}`,
						deadlines: (r.events ?? []).map((e: Any) => ({
							name: e.name,
							course: e.course?.fullname,
							course_id: e.course?.id,
							module: e.modulename,
							due: iso(e.timesort ?? e.timestart),
							overdue: e.overdue,
							action: e.action?.name,
							url: e.url,
						})),
					});
				} catch (e) {
					sessionError = e instanceof Error ? e.message : String(e);
					if (!env.MOODLE_CALENDAR_URL?.trim()) throw e;
				}
				let events: Awaited<ReturnType<typeof icsUpcoming>>;
				try {
					events = await icsUpcoming(env, days, true);
				} catch (e) {
					throw new Error(`Moodle session failed (${sessionError}). The iCal fallback failed too (${e instanceof Error ? e.message : String(e)}).`);
				}
				return json({
					source: "moodle calendar export (iCal)",
					fallback_reason: sessionError,
					deadlines: events.slice(0, limit).map((e) => ({ name: e.summary, course: e.course, due: e.start, description: e.description })),
				});
			}),
	);

	server.registerTool(
		"moodle_conversations",
		{ description: "List my Moodle message conversations (private and group) with the latest message.", inputSchema: { limit: z.number().int().min(1).max(100).default(20) }, annotations: ro },
		async ({ limit }) =>
			withClient(env, async (m) => {
				const r = await m.call("core_message_get_conversations", { userid: await m.me(), limitfrom: 0, limitnum: limit });
				return json({
					conversations: (r.conversations ?? []).map((c: Any) => ({
						id: c.id,
						name: c.name || (c.members ?? []).map((x: Any) => x.fullname).join(", "),
						members: (c.members ?? []).map((x: Any) => ({ id: x.id, name: x.fullname })),
						unread: c.unreadcount,
						last_message: c.messages?.[0] ? { text: text(c.messages[0].text, 500), time: iso(c.messages[0].timecreated) } : undefined,
					})),
				});
			}),
	);

	server.registerTool(
		"moodle_conversation_messages",
		{
			description: "Read the messages of one Moodle conversation, newest first.",
			inputSchema: { conversation_id: z.number().int().positive(), limit: z.number().int().min(1).max(200).default(50) },
			annotations: ro,
		},
		async ({ conversation_id, limit }) =>
			withClient(env, async (m) => {
				const me = await m.me();
				const r = await m.call("core_message_get_conversation_messages", {
					currentuserid: me,
					convid: conversation_id,
					limitfrom: 0,
					limitnum: limit,
					newest: true,
				});
				const names = new Map((r.members ?? []).map((x: Any) => [x.id, x.fullname]));
				return json({
					conversation_id,
					messages: (r.messages ?? []).map((x: Any) => ({
						id: x.id,
						from: x.useridfrom === me ? "me" : (names.get(x.useridfrom) ?? x.useridfrom),
						time: iso(x.timecreated),
						text: text(x.text, 4000),
					})),
				});
			}),
	);

	server.registerTool(
		"moodle_search_users",
		{ description: "Find Moodle users (for messages) by name.", inputSchema: { query: z.string().min(2) }, annotations: ro },
		async ({ query }) =>
			withClient(env, async (m) => {
				const r = await m.call("core_message_message_search_users", { userid: await m.me(), search: query, limitnum: 20 });
				const users = [...(r.contacts ?? []), ...(r.noncontacts ?? [])];
				return json({ users: users.map((u: Any) => ({ id: u.id, name: u.fullname })) });
			}),
	);

	server.registerTool(
		"moodle_send_message",
		{
			description: `Send a private Moodle message to a user (ID from moodle_search_users or moodle_conversations). ${CONFIRM}`,
			inputSchema: { user_id: z.number().int().positive(), text: z.string().min(1) },
			annotations: write,
		},
		async ({ user_id, text: body }) =>
			withClient(env, async (m) => {
				const r = await m.call("core_message_send_instant_messages", { messages: [{ touserid: user_id, text: body, textformat: 2 }] });
				const res = Array.isArray(r) ? r[0] : r;
				if (res?.errormessage) throw new MoodleError(`Moodle did not send the message: ${res.errormessage}`);
				return json({ sent: true, message_id: res?.msgid });
			}),
	);

	server.registerTool(
		"moodle_notifications",
		{
			description: "My latest Moodle notifications (new grades, forum posts, assignment reminders), newest first.",
			inputSchema: { limit: z.number().int().min(1).max(100).default(20), unread_only: z.boolean().default(false) },
			annotations: ro,
		},
		async ({ limit, unread_only }) =>
			withClient(env, async (m) => {
				const me = await m.me();
				const { data } = await m.first([
					["message_popup_get_popup_notifications", { useridto: me, newestfirst: true, limit, offset: 0 }],
					["core_message_get_messages", { useridto: me, type: "notifications", read: unread_only ? 0 : 2, newestfirst: true, limitfrom: 0, limitnum: limit }],
				]);
				const list = data.notifications ?? data.messages ?? [];
				return json({
					notifications: list
						.filter((n: Any) => !unread_only || !n.read && !n.timeread)
						.map((n: Any) => ({
							id: n.id,
							subject: n.subject,
							text: text(n.smallmessage || n.fullmessagehtml || n.fullmessage || n.text, 1000),
							time: iso(n.timecreated),
							read: Boolean(n.read ?? n.timeread),
							url: n.contexturl,
						})),
				});
			}),
	);
}

export async function moodleStatus(env: Env): Promise<PlatformStatus> {
	const platform = "moodle";
	try {
		const m = MoodleClient.create(env);
		if (m.mode === "token") {
			const info = await m.call("core_webservice_get_site_info");
			return { platform, state: "OK", detail: `token mode, user ${info.fullname}, ${info.functions?.length ?? "?"} functions allowed` };
		}
		// core_webservice_get_site_info is never available in session mode. Use an AJAX-enabled function.
		const r = await m.call("core_course_get_enrolled_courses_by_timeline_classification", { classification: "all", limit: 0 });
		return { platform, state: "OK", detail: `SSO session mode (no MOODLE_TOKEN), ${r.courses?.length ?? 0} courses` };
	} catch (e) {
		const detail = e instanceof Error ? e.message : String(e);
		if (e instanceof NotConfiguredError) return { platform, state: "not configured", detail };
		if (e instanceof LoginError) return { platform, state: "login error", detail };
		return { platform, state: "error", detail };
	}
}
