// Moodle units (TUM SSO session).
// "moodle": the enrolled courses named in config/moodle-courses.json, the iCal export (MOODLE_CALENDAR_URL), popup
//   notifications with the discussions they name, conversations.
// "moodle-course:<id>": the course page, every activity page (whole page text, links, dates, HTML),
//   the grade report, every file of resources and folders (R2, PDF text), every forum discussion with all
//   posts and attachments. Activity pages have no version mark, so they are read again in rotation.
//   Opening these pages sets Moodle's "viewed" and completion marks; the owner accepted this (0.7.2).

import moodleScope from "../../../config/moodle-courses.json";
import { decodeEntities, htmlToText } from "../../lib/html";
import { withTimeout } from "../../lib/tools";
import { type Any, MoodleClient } from "../../platforms/moodle";
import { parseForumPage } from "../../platforms/moodle-web";
import { fileByStableKey, linkOnly, storeResponse } from "../files";
import { type Content, type Entry, type FileRef, hash64, isVideo, type Json, toJson } from "../model";
import { Deferred, dropStaleCourseState, forgetCourses, getState, setState } from "../store";
import { capBudget, errText, item, type UnitCtx } from "../unit";
import { stripSessionParams, webContent } from "../web";

const SITE = "https://www.moodle.tum.de";
const HOST = "www.moodle.tum.de";
const SOURCE = "moodle";

/** The Moodle course list of the scope (config/moodle-courses.json). */
export interface MoodleScope {
	course_ids: number[];
	name_contains: string[];
}

/** True when the course id is in the list or its full or short name contains one of the texts (case ignored). */
export function moodleCourseInScope(c: { id: number | string; fullname?: string; shortname?: string }, scope: MoodleScope = moodleScope): boolean {
	if (scope.course_ids.map(Number).includes(Number(c.id))) return true;
	const names = [c.fullname, c.shortname].map((n) => decodeEntities(String(n ?? "")).toLowerCase());
	return scope.name_contains.some((t) => t.trim() && names.some((n) => n.includes(t.trim().toLowerCase())));
}

export interface MoodleCourseRef {
	id: number;
	name: string;
}

// ---------- unit "moodle" ----------

/** VEVENT properties as written in the iCal file (unfolded, unescaped), with their parameters. */
export function rawIcsEvents(text: string): Record<string, Json>[] {
	const lines = text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
	const out: Record<string, Json>[] = [];
	let cur: Record<string, Json> | undefined;
	for (const line of lines) {
		if (line === "BEGIN:VEVENT") cur = {};
		else if (line === "END:VEVENT" && cur) {
			out.push(cur);
			cur = undefined;
		} else if (cur) {
			const colon = line.indexOf(":");
			if (colon < 0) continue;
			const [name, ...params] = line.slice(0, colon).split(";");
			const value = line.slice(colon + 1).replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
			cur[name.toUpperCase()] = params.length ? { value, params } : value;
		}
	}
	return out;
}

const icsValue = (v: Json | undefined): string => (v && typeof v === "object" && !Array.isArray(v) ? String(v.value ?? "") : String(v ?? ""));

export async function unitMoodle(ctx: UnitCtx): Promise<void> {
	const { env } = ctx;
	const m = MoodleClient.create(env);
	const r = await m.call("core_course_get_enrolled_courses_by_timeline_classification", { classification: "all", limit: 0 });
	// Scope: the courses named in config/moodle-courses.json (by id or by a text in the name). Everything
	// stored for other courses is forgotten.
	const all: Any[] = r.courses ?? [];
	const courses = all.filter((c) => moodleCourseInScope(c));
	const others = all.filter((c) => !courses.includes(c));
	const forgotten = await forgetCourses(env, SOURCE, others.map((c) => c.id), (id) => [`moodle:course:${id}`, `moodle:actions:${id}`, `moodle:sections:${id}`]);
	if (forgotten) ctx.note(`${forgotten} stored items of ${others.length} courses outside the scope forgotten`);
	const dropped = await dropStaleCourseState(env, {
		keep: courses.map((c) => c.id),
		listingPrefixes: ["moodle:course:", "moodle:actions:", "moodle:sections:"],
		unitPrefix: "moodle-course:",
		subPrefix: "moodle:sub:",
		subListingPrefixes: ["moodle:folder:", "moodle:forum:"],
	});
	if (dropped) ctx.note(`${dropped} pending markers and unit rows of courses outside the scope removed`);
	await setState(
		env.DB,
		"moodle:courses",
		courses.map((c) => ({ id: c.id, name: decodeEntities(c.fullname ?? "") })),
	);
	await ctx.apply({
		scope: "moodle:courses",
		complete: true,
		outOfScope: others.map((c) => `moodle:course:${c.id}`),
		entries: courses.map((c) => {
			const key = `moodle:course:${c.id}`;
			// Fields that change on every visit are left out.
			const { courseimage: _img, progress: _p, hasprogress: _hp, isfavourite: _f, hidden: _h, showshortname: _s, ...raw } = c;
			return { key, item: item(SOURCE, key, decodeEntities(c.fullname ?? ""), `${SITE}/course/view.php?id=${c.id}`, { course: toJson(raw) }) };
		}),
	});

	const ics = env.MOODLE_CALENDAR_URL?.trim();
	if (ics) {
		try {
			const url = new URL(ics);
			if (url.hostname !== HOST || url.pathname !== "/calendar/export_execute.php") throw new Error("MOODLE_CALENDAR_URL is not a Moodle calendar export link");
			const res = await withTimeout(fetch(url), 30_000, "Moodle calendar export");
			const text = await res.text();
			if (!res.ok || !text.includes("BEGIN:VCALENDAR")) throw new Error(`calendar export HTTP ${res.status}`);
			const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
			await ctx.apply({
				scope: "moodle:calendar",
				complete: true,
				// The export covers a moving range; events before today are not reported as removed.
				windowFrom: today,
				entries: rawIcsEvents(text).map((e) => {
					const uid = icsValue(e.UID) || hash64(JSON.stringify(e));
					const key = `moodle:ics:${uid}`;
					return { key, window: icsValue(e.DTSTART).slice(0, 8), item: item(SOURCE, key, icsValue(e.SUMMARY), `${SITE}/calendar/view.php?view=upcoming`, { event: e }) };
				}),
			});
		} catch (e) {
			ctx.note(`calendar export: ${errText(e)}`);
		}
	}

	const me = await m.me().catch(() => undefined);
	if (me) {
		try {
			const n = await m.call("message_popup_get_popup_notifications", { useridto: me, newestfirst: true, limit: 50, offset: 0 });
			// Discussions named in notifications are read with all posts. Discussions that a forum listing already
			// holds stay in that listing.
			const ids = [...new Set(((n.notifications ?? []) as Any[]).map((x) => Number(/\/mod\/forum\/discuss\.php\?d=(\d+)/.exec(String(x.contexturl ?? ""))?.[1])).filter((x) => x > 0))];
			const elsewhere = new Set<string>();
			if (ids.length) {
				const keys = ids.map((d) => `moodle:discussion:${d}`);
				const rows = await env.DB.prepare(`SELECT key FROM items WHERE key IN (${keys.map(() => "?").join(",")}) AND scope != 'moodle:notified_discussions'`).bind(...keys).all<{ key: string }>();
				for (const r of rows.results) elsewhere.add(r.key);
			}
			await ctx.apply({
				scope: "moodle:notified_discussions",
				complete: false,
				entries: ids.filter((d) => !elsewhere.has(`moodle:discussion:${d}`)).map((d) => discussionEntry(m, ctx, d, { found_in: "moodle notification" })),
			});
			await ctx.apply({
				scope: "moodle:notifications",
				complete: false,
				entries: (n.notifications ?? []).map((x: Any) => {
					const key = `moodle:notification:${x.id}`;
					// "read" changes when the user opens Moodle; it is user state, not content.
					const { read: _r, timeread: _t, ...raw } = x;
					return { key, item: item(SOURCE, key, htmlToText(x.subject ?? ""), x.contexturl ?? `${SITE}/message/output/popup/notifications.php`, { notification: toJson(raw) }) };
				}),
			});
		} catch (e) {
			ctx.note(`notifications: ${errText(e)}`);
		}
		try {
			const cv = await m.call("core_message_get_conversations", { userid: me, limitfrom: 0, limitnum: 50 });
			await ctx.apply({
				scope: "moodle:conversations",
				complete: false,
				entries: (cv.conversations ?? []).map((x: Any) => {
					const key = `moodle:conversation:${x.id}`;
					const { unreadcount: _u, isread: _r, ...raw } = x;
					const who = (x.members ?? []).map((p: Any) => p.fullname).join(", ");
					return { key, item: item(SOURCE, key, x.name || who, `${SITE}/message/index.php?convid=${x.id}`, { conversation: toJson(raw) }) };
				}),
			});
		} catch (e) {
			ctx.note(`conversations: ${errText(e)}`);
		}
	}
}

// ---------- unit "moodle-course:<id>" ----------

/** Course page HTML per activity (cmid -> HTML of its <li>, from its opening tag on). */
export function moduleChunks(html: string): Map<number, string> {
	const out = new Map<number, string>();
	for (const p of html.split(/<li\b(?=[^>]*\bid="module-\d+")/i).slice(1)) {
		const cmid = Number(/^[^>]*\bid="module-(\d+)"/.exec(p)?.[1]);
		// The split takes "<li" away; it is put back so the chunk is HTML and its tag is not read as text.
		if (cmid) out.set(cmid, `<li${p.split(/<li\b(?=[^>]*\bid="section-\d+")/i)[0]}`);
	}
	return out;
}

/** The HTML inside the <li> of an activity (its own tag would read as a list item "- "). */
const innerOf = (chunk: string) => chunk.replace(/^<li\b[^>]*>/i, "");

/** Section pages read per run in a course with one section per page. */
const SECTION_LOADS = 4;

/**
 * Sections that the course page does not show (course format "one section per page"): sections after 0
 * without their block on the page, or with activities that are not on the page.
 */
export function separateSections(sections: Any[], html: string, chunks: Map<number, string>): Any[] {
	return sections.filter((sec) => {
		const n = Number(sec.number ?? sec.section ?? 0);
		if (n === 0) return false;
		const cms = (sec.cmlist ?? []).map(Number);
		if (cms.some((id: number) => !chunks.has(id))) return true;
		return !new RegExp(`\\bid="section-${n}"`).test(html);
	});
}

interface FolderFile {
	path: string;
	revision: string;
	url: string;
}

/** Files of a folder page: pluginfile links of mod_folder with their revision number. */
export function folderFiles(html: string): FolderFile[] {
	const out = new Map<string, FolderFile>();
	for (const a of html.matchAll(/href="([^"]*\/pluginfile\.php\/\d+\/mod_folder\/content\/(\d+)\/([^"?]+)[^"]*)"/gi)) {
		const path = decodeURIComponent(a[3]);
		if (!out.has(path)) out.set(path, { path, revision: a[2], url: decodeEntities(a[1]).replace(/[?&]forcedownload=1$/, "") });
	}
	return [...out.values()];
}

interface Discussion {
	discussion_id: number;
	subject: string;
	author?: string;
	last_post?: string;
	replies?: string;
}

/** Listings found on activity pages; the follow-up scopes run from these on every invocation. */
interface Sub {
	folders: Record<string, { name: string; files: FolderFile[] }>;
	forums: Record<string, { name: string; complete: boolean; discussions: Discussion[] }>;
}

export async function unitMoodleCourse(ctx: UnitCtx, arg?: string): Promise<void> {
	const { env, budget } = ctx;
	const courseId = Number(arg);
	if (!courseId) throw new Error("moodle-course needs a course id");
	const m = MoodleClient.create(env);
	const known = ((await getState<MoodleCourseRef[]>(env.DB, "moodle:courses")) ?? []).find((c) => c.id === courseId);
	const courseName = known?.name ?? String(courseId);
	const scope = `moodle:course:${courseId}`;
	const subKey = `moodle:sub:${courseId}`;
	const sub: Sub = (await getState<Sub>(env.DB, subKey)) ?? { folders: {}, forums: {} };
	const refreshed = new Set<string>();

	const raw = await m.call("core_courseformat_get_state", { courseid: courseId });
	const st = typeof raw === "string" ? JSON.parse(raw) : raw;
	const courseUrl = `${SITE}/course/view.php?id=${courseId}`;
	const html = await m.page(`/course/view.php?id=${courseId}`);
	const chunks = moduleChunks(html);
	const sections: Any[] = st.section ?? [];
	const sectionOf = new Map<number, Any>();
	for (const s of sections) for (const id of s.cmlist ?? []) sectionOf.set(Number(id), s);
	const cms: Any[] = (st.cm ?? []).filter((c: Any) => c.uservisible !== false);
	const base = (c: Any): Content => {
		const s = sectionOf.get(Number(c.id));
		return { course_id: courseId, course: courseName, section: s ? { id: s.id ?? null, number: s.number ?? null, title: s.title ?? null } : null, module: toJson(c) };
	};

	const pageItem = async (key: string, url: string, title: string, extra: Content) => {
		const res = await m.web(url);
		return item(SOURCE, key, title, url, { ...extra, page: stripSessionParams(webContent(res.text, url)) }, res.text);
	};

	// Courses with one section per page (for example Opportunity Hunters): the course page shows section 0
	// only. The other sections (their summary and their labels) are on their own page, which is read here as
	// an item of the listing moodle:sections:<course>. Label texts found there go into the label items.
	const labelKey = `moodle:sectionlabels:${courseId}`;
	const labels: Record<string, { text: string; page: Content }> = (await getState<Record<string, { text: string; page: Content }>>(env.DB, labelKey)) ?? {};
	const separate = separateSections(sections, html, chunks);
	let labelsChanged = false;
	await ctx.apply(
		{
			scope: `moodle:sections:${courseId}`,
			complete: true,
			entries: separate.map((sec) => {
				const key = `moodle:section:${sec.id}`;
				const url = String(sec.sectionurl ?? `${courseUrl}&section=${sec.number}`);
				return {
					key,
					load: async () => {
						const res = await m.web(url);
						for (const [cmid, chunk] of moduleChunks(res.text)) {
							if (!(sec.cmlist ?? []).map(String).includes(String(cmid))) continue;
							labels[cmid] = { text: htmlToText(innerOf(chunk)).replace(/\n{3,}/g, "\n\n").trim(), page: stripSessionParams(webContent(innerOf(chunk), url, false)) };
							labelsChanged = true;
						}
						return item(SOURCE, key, String(sec.title ?? `Section ${sec.number}`), url, { course_id: courseId, course: courseName, section: toJson(sec), page: stripSessionParams(webContent(res.text, url)) }, res.text);
					},
				};
			}),
		},
		// Section pages are re-read in rotation; at most SECTION_LOADS per run, so new activities still get loads.
		capBudget(budget, SECTION_LOADS),
	);
	if (labelsChanged) await setState(env.DB, labelKey, labels);

	const entries: Entry[] = [
		{
			key: `moodle:coursepage:${courseId}`,
			item: item(SOURCE, `moodle:coursepage:${courseId}`, courseName, courseUrl, { course_id: courseId, sections: toJson(sections), page: stripSessionParams(webContent(html, courseUrl)) }, html),
		},
		{
			key: `moodle:grades:${courseId}`,
			load: () => pageItem(`moodle:grades:${courseId}`, `${SITE}/grade/report/user/index.php?id=${courseId}`, `${courseName}: grades`, { course_id: courseId }),
		},
	];

	for (const c of cms) {
		const cmid = Number(c.id);
		const key = `moodle:cm:${cmid}`;
		const type = String(c.module ?? c.modname ?? "");
		const name = decodeEntities(String(c.name ?? ""));
		const viewUrl = c.url ? String(c.url) : `${SITE}/mod/${type}/view.php?id=${cmid}`;
		if (type === "label" || !c.url) {
			// No own page: the text is on the course page, or on the page of its section (see above).
			const chunk = chunks.get(cmid);
			const fromSection = chunk === undefined ? labels[cmid] : undefined;
			const t = fromSection ? fromSection.text : htmlToText(innerOf(chunk ?? "")).replace(/\n{3,}/g, "\n\n").trim();
			const page = fromSection ? fromSection.page : stripSessionParams(webContent(innerOf(chunk ?? ""), courseUrl, false));
			entries.push({ key, item: item(SOURCE, key, name || t.split("\n")[0] || type, `${courseUrl}#module-${cmid}`, { ...base(c), text: t, page }) });
			continue;
		}
		if (type === "resource") {
			entries.push({
				key,
				load: async () => {
					const r = await m.rawFetch(`/mod/resource/view.php?id=${cmid}&redirect=1`, "manual");
					const loc = r.headers.get("Location");
					if (!loc || !/\/pluginfile\.php\//.test(loc)) {
						await r.body?.cancel();
						return pageItem(key, viewUrl, name, base(c));
					}
					await r.body?.cancel();
					const fileUrl = new URL(loc, SITE).toString();
					const fileName = decodeURIComponent(new URL(fileUrl).pathname.split("/").pop() ?? name);
					// The pluginfile URL carries the revision, so a stored copy under it is the current file.
					const file = isVideo(fileUrl)
						? linkOnly(fileName, fileUrl, "video (only the link is kept)")
						: await storeResponse(env, { name: fileName, url: fileUrl, open: () => m.rawFetch(fileUrl, "follow"), stableKey: `moodle:${fileUrl}` });
					return item(SOURCE, key, name, viewUrl, { ...base(c), file: file as unknown as Json });
				},
			});
			continue;
		}
		if (type === "url") {
			entries.push({
				key,
				load: async () => {
					const r = await m.rawFetch(viewUrl, "manual");
					const loc = r.headers.get("Location");
					if (r.status >= 300 && r.status < 400 && loc && !/\/login\/index\.php/.test(loc)) {
						await r.body?.cancel();
						return item(SOURCE, key, name, viewUrl, { ...base(c), target: new URL(loc, SITE).toString() });
					}
					await r.body?.cancel();
					return pageItem(key, viewUrl, name, base(c));
				},
			});
			continue;
		}
		entries.push({
			key,
			load: async () => {
				const it = await pageItem(key, viewUrl, name, base(c));
				if (type === "folder" || type === "forum") refreshed.add(String(cmid));
				if (type === "folder") sub.folders[cmid] = { name, files: folderFiles(it.html ?? "") };
				if (type === "forum") {
					const page = it.html ?? "";
					// More than one page of discussions: the listing is not complete, nothing is reported as removed.
					const paged = new RegExp(`/mod/forum/view\\.php\\?id=${cmid}(?:&amp;|&)[^"]*page=1`).test(page);
					sub.forums[cmid] = { name, complete: !paged, discussions: parseForumPage(page).discussions };
				}
				return it;
			},
		});
	}
	// Order of the loads: the listings of folders and forums (new files and discussions) come before the
	// activity pages, because the activity pages are re-read in rotation and would use the whole budget
	// of the invocation every run. Without this order, folder files and discussions were never read.
	const live = new Set(cms.map((c) => String(c.id)));
	// Activities that are gone take their files and discussions with them.
	for (const id of Object.keys(sub.folders)) {
		if (live.has(id)) continue;
		delete sub.folders[id];
		await ctx.apply({ scope: `moodle:folder:${id}`, complete: true, entries: [] });
	}
	for (const id of Object.keys(sub.forums)) {
		if (live.has(id)) continue;
		delete sub.forums[id];
		await ctx.apply({ scope: `moodle:forum:${id}`, complete: true, entries: [] });
	}
	const applySubs = async (only?: Set<string>) => {
		for (const [cmid, f] of Object.entries(sub.folders)) {
			if (only && !only.has(cmid)) continue;
			await ctx.apply({
				scope: `moodle:folder:${cmid}`,
				complete: true,
				entries: f.files.map((x) => {
					const key = `moodle:folderfile:${cmid}:${x.path}`;
					const name = x.path.split("/").pop() ?? x.path;
					return {
						key,
						sig: x.revision,
						load: async () => {
							const file = isVideo(name)
								? linkOnly(name, x.url, "video (only the link is kept)")
								: await storeResponse(env, { name, url: x.url, open: () => m.rawFetch(x.url, "follow"), stableKey: `moodle:${x.url}` });
							return item(SOURCE, key, `${f.name} / ${x.path}`, `${SITE}/mod/folder/view.php?id=${cmid}`, {
								course_id: courseId,
								course: courseName,
								folder_cmid: Number(cmid),
								folder: f.name,
								path: x.path,
								revision: x.revision,
								file: file as unknown as Json,
							});
						},
					};
				}),
			});
		}

		for (const [cmid, f] of Object.entries(sub.forums)) {
			if (only && !only.has(cmid)) continue;
			await ctx.apply({
				scope: `moodle:forum:${cmid}`,
				complete: f.complete,
				entries: f.discussions.map((d) =>
					discussionEntry(m, ctx, d.discussion_id, { course_id: courseId, course: courseName, forum_cmid: Number(cmid), forum: f.name, listing: toJson(d) }, `${d.last_post ?? ""}|${d.replies ?? ""}`),
				),
			});
		}
	};
	// The listings as the last read of their pages found them.
	await applySubs();
	await ctx.apply({ scope, complete: true, entries });
	await setState(env.DB, subKey, sub);
	// Folder and forum pages read in this run: their new listings.
	if (refreshed.size) await applySubs(refreshed);
}

/** Web service file URLs point to /webservice/pluginfile.php with a token; the session uses /pluginfile.php. */
export function sessionFileUrl(url: string): string {
	const u = new URL(url, SITE);
	u.pathname = u.pathname.replace(/^\/webservice\/pluginfile\.php/, "/pluginfile.php");
	u.searchParams.delete("token");
	u.searchParams.delete("forcedownload");
	return u.toString();
}

/** One forum discussion with all posts and their files. mod_forum_get_discussion_posts logs no view. */
export function discussionEntry(m: MoodleClient, ctx: UnitCtx, id: number, extra: Content, sig?: string): Entry {
	const key = `moodle:discussion:${id}`;
	return {
		key,
		sig,
		load: async () => {
			const r = await m.call("mod_forum_get_discussion_posts", { discussionid: id, sortby: "created", sortdirection: "ASC" });
			const posts: Content[] = [];
			for (const p of (r.posts ?? []) as Any[]) {
				const files: FileRef[] = [];
				for (const a of [...(p.attachments ?? []), ...(p.messageinlinefiles ?? [])] as Any[]) {
					const url = String(a.url ?? a.fileurl ?? "");
					if (!url) continue;
					const name = String(a.filename ?? "file");
					if (isVideo(name) || isVideo(url) || Number(a.filesize ?? 0) > 100 * 1024 * 1024) {
						files.push(linkOnly(name, url, isVideo(name) || isVideo(url) ? "video (only the link is kept)" : "larger than 100 MB (only the link is kept)", a.filesize ?? null, a.mimetype ?? null));
						continue;
					}
					const fileUrl = sessionFileUrl(url);
					const stableKey = `moodle:${fileUrl}|${a.timemodified ?? ""}`;
					let ref = await fileByStableKey(ctx.env, stableKey, fileUrl);
					if (!ref) {
						if (!ctx.budget.canLoad()) throw new Deferred();
						ctx.budget.loaded();
						ref = await storeResponse(ctx.env, { name, url: fileUrl, open: () => m.rawFetch(fileUrl, "follow"), stableKey });
					}
					files.push(ref);
				}
				const { capabilities: _c, html: _h, ...rawPost } = p;
				posts.push({ post: toJson(rawPost), message_text: htmlToText(String(p.message ?? "")), files: files as unknown as Json });
			}
			const subject = String((r.posts?.[0] as Any)?.subject ?? (extra.listing as Any)?.name ?? id);
			return item(SOURCE, key, subject, `${SITE}/mod/forum/discuss.php?d=${id}`, { ...extra, discussion_id: id, posts: posts as unknown as Json });
		},
	};
}
