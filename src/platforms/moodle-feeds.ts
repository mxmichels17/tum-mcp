// Moodle sources that need no login:
// - MOODLE_CALENDAR_URL: iCal export link (Kalender > Exportieren), parsed into events and deadlines.
// - MOODLE_RSS_TOKEN: RSS feeds of forums. URL format on moodle.tum.de (checked 2026-10-17):
//   https://www.moodle.tum.de/rss/file.php/{forum context id}/{rss token}/mod_forum/{forum id}/rss.xml
//   The context IDs are found once through the SSO session (moodle_rss_discover) and stored in KV.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { decodeEntities, htmlToText } from "../lib/html";
import { storeGet, storePut } from "../lib/store";
import { json, NotConfiguredError, type PlatformStatus, run, withTimeout } from "../lib/tools";
import { MoodleClient } from "./moodle";

const SITE = "https://www.moodle.tum.de";
const HOST = "www.moodle.tum.de";
const FEEDS_KEY = "moodle-rss-feeds";
const TIMEOUT_MS = 30_000;

// ---------- iCal ----------

export interface IcsEvent {
	uid?: string;
	summary: string;
	start?: string; // ISO 8601
	end?: string;
	all_day?: boolean;
	description?: string;
	course?: string;
	location?: string;
	deadline: boolean;
}

function unescapeIcs(v: string): string {
	return v.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
}

/** Offset of a time zone at a UTC instant, in minutes (e.g. 60 or 120 for Europe/Berlin). */
function tzOffsetMinutes(utcMs: number, tz: string): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: tz,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).formatToParts(new Date(utcMs));
	const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
	const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
	return Math.round((asUtc - utcMs) / 60000);
}

export function icsDate(value: string, params: Record<string, string>): { iso?: string; allDay: boolean } {
	const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
	if (!m) return { allDay: false };
	const [, y, mo, d, h, mi, se, z] = m;
	if (h === undefined) return { iso: `${y}-${mo}-${d}`, allDay: true };
	const naive = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
	if (z) return { iso: new Date(naive).toISOString(), allDay: false };
	const tz = params.TZID ?? "Europe/Berlin";
	let utc = naive - tzOffsetMinutes(naive, tz) * 60000;
	utc = naive - tzOffsetMinutes(utc, tz) * 60000;
	return { iso: new Date(utc).toISOString(), allDay: false };
}

const DEADLINE_RE = /fällig|is due|\bdue\b|abgabe|deadline|schließt|closes|endet|ends/i;

export function parseIcs(text: string): IcsEvent[] {
	const lines = text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
	const events: IcsEvent[] = [];
	let cur: Record<string, { value: string; params: Record<string, string> }> | undefined;
	for (const line of lines) {
		if (line === "BEGIN:VEVENT") {
			cur = {};
			continue;
		}
		if (line === "END:VEVENT" && cur) {
			const start = cur.DTSTART ? icsDate(cur.DTSTART.value, cur.DTSTART.params) : { allDay: false };
			const end = cur.DTEND ? icsDate(cur.DTEND.value, cur.DTEND.params) : { allDay: false };
			const summary = unescapeIcs(cur.SUMMARY?.value ?? "");
			events.push({
				uid: cur.UID?.value,
				summary,
				start: start.iso,
				end: end.iso,
				all_day: start.allDay || undefined,
				description: cur.DESCRIPTION ? htmlToText(unescapeIcs(cur.DESCRIPTION.value)).slice(0, 1000) || undefined : undefined,
				course: cur.CATEGORIES ? unescapeIcs(cur.CATEGORIES.value) : undefined,
				location: cur.LOCATION ? unescapeIcs(cur.LOCATION.value) || undefined : undefined,
				deadline: DEADLINE_RE.test(summary) || (!!start.iso && start.iso === end.iso),
			});
			cur = undefined;
			continue;
		}
		if (!cur) continue;
		const colon = line.indexOf(":");
		if (colon < 0) continue;
		const [name, ...paramParts] = line.slice(0, colon).split(";");
		const params: Record<string, string> = {};
		for (const p of paramParts) {
			const eq = p.indexOf("=");
			if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
		}
		cur[name.toUpperCase()] = { value: line.slice(colon + 1), params };
	}
	return events;
}

function calendarUrl(env: Env): URL {
	const raw = env.MOODLE_CALENDAR_URL?.trim();
	if (!raw) throw new NotConfiguredError("moodle calendar export", ["MOODLE_CALENDAR_URL"]);
	const url = new URL(raw);
	if (url.hostname !== HOST || url.pathname !== "/calendar/export_execute.php") {
		throw new Error("MOODLE_CALENDAR_URL must be a https://www.moodle.tum.de/calendar/export_execute.php link");
	}
	return url;
}

export async function fetchIcsEvents(env: Env): Promise<IcsEvent[]> {
	const res = await withTimeout(fetch(calendarUrl(env)), TIMEOUT_MS, "Moodle calendar export");
	const text = await res.text();
	if (!res.ok || !text.includes("BEGIN:VCALENDAR")) {
		throw new Error(`Moodle calendar export failed (HTTP ${res.status}): ${text.replace(/<[^>]+>/g, " ").trim().slice(0, 200)}. Create a new export link.`);
	}
	return parseIcs(text);
}

/** Events from the iCal export between now (or include_past days back) and now + days. */
export async function icsUpcoming(env: Env, days: number, onlyDeadlines: boolean, pastDays = 0): Promise<IcsEvent[]> {
	const now = Date.now();
	const from = new Date(now - pastDays * 86400_000).toISOString();
	const to = new Date(now + days * 86400_000).toISOString();
	return (await fetchIcsEvents(env))
		.filter((e) => e.start && (e.end ?? e.start) >= from && e.start <= to)
		.filter((e) => !onlyDeadlines || e.deadline)
		.sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""));
}

// ---------- RSS ----------

export interface RssFeed {
	course_id: number;
	course: string;
	forum: string;
	cmid: number;
	contextid: number;
	forumid: number;
	rss_link_on_page: boolean;
}

export interface RssItem {
	title: string;
	link?: string;
	published?: string;
	author?: string;
	text?: string;
}

export function parseRss(xml: string): { title?: string; items: RssItem[]; error?: string } {
	const tag = (src: string, name: string) => {
		const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(src);
		if (!m) return undefined;
		const v = m[1].replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1").trim();
		return decodeEntities(v);
	};
	const channel = /<channel\b[\s\S]*?(?=<item\b|<\/channel>)/i.exec(xml)?.[0] ?? "";
	const items = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((m) => {
		const pub = tag(m[1], "pubDate");
		const desc = tag(m[1], "description");
		return {
			title: tag(m[1], "title") ?? "",
			link: tag(m[1], "link"),
			published: pub && !Number.isNaN(Date.parse(pub)) ? new Date(pub).toISOString() : pub,
			author: tag(m[1], "dc:creator") ?? tag(m[1], "author"),
			text: desc ? htmlToText(decodeEntities(desc)).slice(0, 3000) : undefined,
		};
	});
	const title = tag(channel, "title");
	// Moodle answers a disabled or unreadable feed with one item "RSS Error" / "Fehler beim Lesen der RSS-Daten".
	const errorItem = items.length === 1 && /^rss error$/i.test(items[0].title) ? items[0].text || items[0].title : undefined;
	const channelError = !items.length && /error|fehler/i.test(tag(channel, "description") ?? "") ? tag(channel, "description") : undefined;
	const error = errorItem ?? channelError;
	return { title, items: error ? [] : items, error };
}

function rssToken(env: Env): string {
	const t = env.MOODLE_RSS_TOKEN?.trim();
	if (!t) throw new NotConfiguredError("moodle RSS", ["MOODLE_RSS_TOKEN"]);
	if (!/^[0-9a-f]{32}$/i.test(t)) throw new Error("MOODLE_RSS_TOKEN must be the 32 character RSS key from Moodle > Sicherheitsschlüssel");
	return t;
}

export function rssUrl(token: string, contextid: number, forumid: number): string {
	return `${SITE}/rss/file.php/${contextid}/${token}/mod_forum/${forumid}/rss.xml`;
}

/** Reads forum context IDs and forum IDs from a Moodle page. */
export function forumIdsFromPage(html: string): { contextid?: number; forumid?: number; rssLink: boolean } {
	const link = /rss\/file\.php\/(\d+)\/[0-9a-f]{32}\/mod_forum\/(\d+)\/rss\.xml/i.exec(html);
	if (link) return { contextid: Number(link[1]), forumid: Number(link[2]), rssLink: true };
	const ctx = /"contextid":\s*(\d+)/.exec(html)?.[1];
	const forum =
		/data-forumid="(\d+)"/.exec(html)?.[1] ??
		/name="forum" value="(\d+)"/.exec(html)?.[1] ??
		/[?&]forum(?:id)?=(\d+)/.exec(html)?.[1] ??
		/"forumid":\s*(\d+)/.exec(html)?.[1];
	return { contextid: ctx ? Number(ctx) : undefined, forumid: forum ? Number(forum) : undefined, rssLink: false };
}

async function discoverFeeds(env: Env, courseId?: number): Promise<{ feeds: RssFeed[]; skipped: string[] }> {
	const m = MoodleClient.create(env);
	if (m.mode !== "session") throw new Error("Feed discovery needs the SSO session (TUM_USER and TUM_PASSWORD).");
	let courses: { id: number; name: string }[];
	if (courseId) courses = [{ id: courseId, name: String(courseId) }];
	else {
		const r = await m.call("core_course_get_enrolled_courses_by_timeline_classification", { classification: "inprogress", limit: 0 });
		courses = (r.courses ?? []).map((c: { id: number; fullname: string }) => ({ id: c.id, name: decodeEntities(c.fullname) }));
	}
	const feeds: RssFeed[] = [];
	const skipped: string[] = [];
	for (const c of courses.slice(0, 20)) {
		const html = await m.page(`/course/view.php?id=${c.id}`);
		const forums = new Map<number, string>();
		for (const a of html.matchAll(/href="[^"]*\/mod\/forum\/view\.php\?id=(\d+)"[^>]*>([\s\S]*?)<\/a>/g)) {
			if (!forums.has(Number(a[1]))) forums.set(Number(a[1]), decodeEntities(htmlToText(a[2])).replace(/\s+/g, " ").trim().slice(0, 120));
		}
		for (const [cmid, name] of forums) {
			const page = await m.page(`/mod/forum/view.php?id=${cmid}`);
			const ids = forumIdsFromPage(page);
			if (!ids.contextid || !ids.forumid) {
				skipped.push(`${c.name}: ${name || cmid} (IDs not found on the forum page)`);
				continue;
			}
			feeds.push({ course_id: c.id, course: c.name, forum: name, cmid, contextid: ids.contextid, forumid: ids.forumid, rss_link_on_page: ids.rssLink });
		}
	}
	if (!courseId) await storePut(env, FEEDS_KEY, feeds);
	else {
		const old = (await storeGet<RssFeed[]>(env, FEEDS_KEY)) ?? [];
		await storePut(env, FEEDS_KEY, [...old.filter((f) => f.course_id !== courseId), ...feeds]);
	}
	return { feeds, skipped };
}

async function readFeed(token: string, f: Pick<RssFeed, "contextid" | "forumid">) {
	const res = await withTimeout(fetch(rssUrl(token, f.contextid, f.forumid)), TIMEOUT_MS, "Moodle RSS");
	const parsed = parseRss(await res.text());
	if (res.status === 403 || parsed.error) {
		return {
			items: [] as RssItem[],
			error: `RSS not available (HTTP ${res.status}${parsed.error ? `: ${parsed.error}` : ""}). RSS is switched off for this forum, or MOODLE_RSS_TOKEN is wrong.`,
		};
	}
	return { items: parsed.items };
}

export function registerMoodleFeedTools(server: McpServer, env: Env) {
	const ro = { readOnlyHint: true, openWorldHint: true };

	server.registerTool(
		"moodle_calendar_ics",
		{
			description:
				"Moodle events and deadlines from the iCal export link (secret MOODLE_CALENDAR_URL). Works without Moodle login. Deadlines are events with due, Abgabe, fällig or closes in the title, or with no duration.",
			inputSchema: {
				days: z.number().int().min(1).max(365).default(30),
				only_deadlines: z.boolean().default(false),
				past_days: z.number().int().min(0).max(60).default(0).describe("Also include events of the last N days"),
			},
			annotations: ro,
		},
		async ({ days, only_deadlines, past_days }) =>
			run(async () => {
				const events = await icsUpcoming(env, days, only_deadlines, past_days);
				return json({ source: "moodle calendar export (iCal)", days, count: events.length, events });
			}),
	);

	server.registerTool(
		"moodle_rss_discover",
		{
			description:
				"Find the RSS feeds of the forums (including announcements) in my current Moodle courses and store them, so moodle_forum_rss works later without login. Needs the Moodle SSO session once. Takes up to a minute.",
			inputSchema: { course_id: z.number().int().positive().optional().describe("Only this course (adds to the stored list)") },
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		},
		async ({ course_id }) =>
			run(async () => {
				const { feeds, skipped } = await discoverFeeds(env, course_id);
				return json({
					stored: feeds.length,
					feeds: feeds.map((f) => ({ course_id: f.course_id, course: f.course, forum: f.forum, forum_id: f.forumid, rss_link_on_page: f.rss_link_on_page })),
					skipped,
					note: "rss_link_on_page = false means the forum page shows no RSS link, so RSS is probably switched off for that forum. Test with moodle_forum_rss.",
				});
			}),
	);

	server.registerTool(
		"moodle_forum_rss",
		{
			description:
				"Latest forum and announcement posts from Moodle RSS feeds (secret MOODLE_RSS_TOKEN). Works without Moodle login, after moodle_rss_discover stored the feeds once.",
			inputSchema: {
				course_id: z.number().int().positive().optional(),
				forum_id: z.number().int().positive().optional(),
				per_feed: z.number().int().min(1).max(50).default(5),
			},
			annotations: ro,
		},
		async ({ course_id, forum_id, per_feed }) =>
			run(async () => {
				const token = rssToken(env);
				const feeds = ((await storeGet<RssFeed[]>(env, FEEDS_KEY)) ?? []).filter(
					(f) => (!course_id || f.course_id === course_id) && (!forum_id || f.forumid === forum_id),
				);
				if (!feeds.length) throw new Error("No stored RSS feeds match. Run moodle_rss_discover first.");
				const out = [];
				for (let i = 0; i < feeds.length; i += 6) {
					const batch = await Promise.all(
						feeds.slice(i, i + 6).map(async (f) => {
							const r = await readFeed(token, f);
							return { course: f.course, course_id: f.course_id, forum: f.forum, forum_id: f.forumid, error: r.error, posts: r.items.slice(0, per_feed) };
						}),
					);
					out.push(...batch);
				}
				const working = out.filter((f) => !f.error).length;
				return json({
					source: "moodle RSS",
					rss_available: working > 0,
					summary:
						working > 0
							? `${working} of ${out.length} feeds deliver posts.`
							: `None of the ${out.length} feeds delivers posts. Moodle answers "Fehler beim Lesen der RSS-Daten", and the forum pages show no RSS link, so RSS is switched off for these forums on TUM Moodle. moodle_announcements does not help either: TUM blocks mod_forum_get_forums_by_courses and mod_forum_get_forum_discussions for the web session (see moodle_probe). Moodle notifications (moodle_notifications) often include new announcements.`,
					feeds: working > 0 ? out : out.map((f) => ({ course: f.course, forum: f.forum, error: f.error })),
				});
			}),
	);
}

// RSS is not part of status: TUM Moodle has RSS switched off for the course forums (tested 2026-10-17).
export async function moodleFeedStatus(env: Env): Promise<PlatformStatus[]> {
	const out: PlatformStatus[] = [];
	try {
		const events = await fetchIcsEvents(env);
		out.push({ platform: "moodle (calendar export)", state: "OK", detail: `${events.length} events in the export` });
	} catch (e) {
		const detail = e instanceof Error ? e.message : String(e);
		out.push({ platform: "moodle (calendar export)", state: e instanceof NotConfiguredError ? "not configured" : "error", detail });
	}
	return out;
}
