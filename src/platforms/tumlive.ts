// TUM-Live (live.rbg.tum.de, source TUM-Dev/gocast v1.11.0). The JSON API is /api/v2 (gRPC gateway).
// The old /api/... v1 routes return 404 since v1.11. Login: SAML through TUM SSO (/saml/out -> login.tum.de
// -> POST /shib), which sets the "jwt" session cookie (7 days). The internal /login form is only for
// non-TUM accounts unless LDAP login is on, which cannot be checked from outside.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CookieJar } from "../lib/http";
import { storeDelete, storeGet, storePut } from "../lib/store";
import { json, LoginError, NotConfiguredError, type PlatformStatus, run, withTimeout } from "../lib/tools";
import { tumSsoLogin } from "../lib/tum-sso";

const SITE = "https://live.rbg.tum.de";
const HOST = "live.rbg.tum.de";
const STORE_KEY = "tumlive-jwt";
const TIMEOUT_MS = 30_000;

// TUM-Live protojson DTOs.
type Any = any;

async function login(env: Env): Promise<string> {
	const jar = new CookieJar();
	await tumSsoLogin(env, jar, `${SITE}/saml/out`);
	const token = jar.get(HOST, "jwt");
	if (!token) throw new LoginError("TUM-Live SSO login finished, but no jwt session cookie was set");
	await storePut(env, STORE_KEY, { token }, 6 * 86400);
	return token;
}

export async function api(env: Env, path: string, query: Record<string, string | number | undefined> = {}, auth = true): Promise<Any> {
	const url = new URL(`/api/v2${path}`, SITE);
	for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
	for (let attempt = 0; attempt < 2; attempt++) {
		const headers: Record<string, string> = { Accept: "application/json" };
		if (auth) {
			let token = attempt === 0 ? (await storeGet<{ token: string }>(env, STORE_KEY))?.token : undefined;
			token ??= await login(env);
			headers.Cookie = `jwt=${token}`;
		}
		const res = await withTimeout(fetch(url, { headers }), TIMEOUT_MS, "TUM-Live");
		const text = await res.text();
		if (res.status === 401 && auth && attempt === 0) {
			await storeDelete(env, STORE_KEY);
			continue;
		}
		let data: Any;
		try {
			data = JSON.parse(text);
		} catch {
			throw new Error(`TUM-Live HTTP ${res.status} for ${path}: ${text.slice(0, 200)}`);
		}
		if (res.status === 401) throw new LoginError(`TUM-Live rejected the session: ${data.message ?? res.status}`);
		if (!res.ok) throw new Error(`TUM-Live HTTP ${res.status} for ${path}: ${data.message ?? text.slice(0, 200)}`);
		return data;
	}
}

export async function currentSemester(env: Env): Promise<{ year: number; term: string }> {
	const s = await api(env, "/semesters", {}, false);
	return { year: s.current?.year, term: s.current?.teachingTerm };
}

function streamSummary(slug: string, s: Any) {
	return {
		id: Number(s.id),
		name: s.name,
		start: s.start,
		end: s.end,
		live_now: s.liveNow || undefined,
		recording: s.recording,
		duration_minutes: s.duration ? Math.round(Number(s.duration) / 60) : undefined,
		room: s.roomName,
		url: `${SITE}/w/${slug}/${s.id}`,
	};
}

const semesterArgs = {
	year: z.number().int().optional().describe("Default: current semester"),
	term: z.enum(["W", "S"]).optional().describe("W = winter, S = summer. Default: current"),
};

export function registerTumliveTools(server: McpServer, env: Env) {
	const ro = { readOnlyHint: true, openWorldHint: true };

	async function semester(year?: number, term?: string) {
		if (year && term) return { year, term };
		const cur = await currentSemester(env);
		return { year: year ?? cur.year, term: term ?? cur.term };
	}

	async function enrolled(year?: number, term?: string) {
		const s = await semester(year, term);
		const r = await api(env, "/courses/enrolled", s);
		return { semester: s, courses: (r.courses ?? []) as Any[] };
	}

	server.registerTool(
		"tumlive_my_courses",
		{ description: "My TUM-Live courses in a semester with last recording and next lecture.", inputSchema: semesterArgs, annotations: ro },
		async ({ year, term }) =>
			run(async () => {
				const { semester: s, courses } = await enrolled(year, term);
				return json({
					semester: s,
					courses: courses.map((c) => ({
						id: c.id,
						name: c.name,
						slug: c.slug,
						recordings_enabled: c.vodEnabled,
						downloads_enabled: c.downloadsEnabled,
						last_recording: c.lastRecording?.id ? streamSummary(c.slug, c.lastRecording) : undefined,
						next_lecture: c.nextLecture?.id ? streamSummary(c.slug, c.nextLecture) : undefined,
						url: `${SITE}/course/${s.year}/${s.term}/${c.slug}`,
					})),
				});
			}),
	);

	server.registerTool(
		"tumlive_course_streams",
		{
			description: "All streams and recordings of one TUM-Live course (slug from tumlive_my_courses).",
			inputSchema: { slug: z.string().min(1), ...semesterArgs },
			annotations: ro,
		},
		async ({ slug, year, term }) =>
			run(async () => {
				const s = await semester(year, term);
				const r = await api(env, `/courses/${encodeURIComponent(slug)}`, s);
				const streams = (r.course?.streams ?? []).map((x: Any) => streamSummary(slug, x));
				streams.sort((a: Any, b: Any) => (a.start ?? "").localeCompare(b.start ?? ""));
				return json({ course: r.course?.name, slug, semester: s, count: streams.length, streams });
			}),
	);

	server.registerTool(
		"tumlive_new_recordings",
		{
			description: "New recordings in my TUM-Live courses since a date, newest first.",
			inputSchema: { since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD"), ...semesterArgs },
			annotations: ro,
		},
		async ({ since, year, term }) =>
			run(async () => {
				const { semester: s, courses } = await enrolled(year, term);
				const sinceIso = `${since}T00:00:00Z`;
				const out = [];
				for (const c of courses.slice(0, 20)) {
					const r = await api(env, `/courses/${encodeURIComponent(c.slug)}`, s);
					for (const x of r.course?.streams ?? []) {
						if (x.recording && (x.start ?? "") >= sinceIso) out.push({ course: c.name, slug: c.slug, ...streamSummary(c.slug, x) });
					}
				}
				out.sort((a, b) => (b.start ?? "").localeCompare(a.start ?? ""));
				return json({ since, semester: s, count: out.length, recordings: out });
			}),
	);

	server.registerTool(
		"tumlive_stream",
		{
			description: "Details of one TUM-Live stream: description, watch link, HLS playlist URLs, download links and attachments. Signed URLs expire after about 7 hours.",
			inputSchema: { slug: z.string().min(1), stream_id: z.number().int().positive() },
			annotations: ro,
		},
		async ({ slug, stream_id }) =>
			run(async () => {
				const w = await api(env, `/streams/${encodeURIComponent(slug)}/${stream_id}/watch`);
				const st = w.stream ?? {};
				return json({
					id: stream_id,
					course: w.course?.name,
					name: st.displayName ?? st.name,
					start: st.start,
					end: st.end,
					live_now: st.liveNow,
					recording: st.recording,
					room: st.lectureHallName,
					description: st.descriptionHtml ? String(st.descriptionHtml).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : undefined,
					watch_url: `${SITE}/w/${slug}/${stream_id}`,
					playlists: (w.views ?? []).map((v: Any) => ({ kind: String(v.kind ?? "").replace("WATCH_VIEW_KIND_", "").toLowerCase(), url: v.playlistUrl })),
					downloads: (w.downloads ?? []).map((d: Any) => ({ name: d.friendlyName, url: d.url })),
					attachments: (w.attachments ?? []).map((a: Any) => ({
						name: a.filename,
						url: a.externalUrl || (a.fileId ? `${SITE}/api/v2/streams/${stream_id}/files/${a.fileId}` : undefined),
					})),
				});
			}),
	);

	server.registerTool(
		"tumlive_live_now",
		{ description: "Courses that are streaming live on TUM-Live right now.", inputSchema: {}, annotations: ro },
		async () =>
			run(async () => {
				const r = await api(env, "/courses/live");
				return json({
					live: (r.liveCourses ?? []).map((l: Any) => ({
						course: l.course?.name,
						slug: l.course?.slug,
						stream: l.stream ? streamSummary(l.course?.slug, l.stream) : undefined,
						lecture_hall: l.lectureHall?.name,
						viewers: l.viewers,
					})),
				});
			}),
	);
}

export async function tumliveStatus(env: Env): Promise<PlatformStatus> {
	const platform = "tumlive";
	try {
		const me = await api(env, "/users/me");
		return { platform, state: "OK", detail: `logged in as ${me.user?.name ?? ""} ${me.user?.lastName ?? ""}`.trim() };
	} catch (e) {
		const detail = e instanceof Error ? e.message : String(e);
		if (e instanceof NotConfiguredError) return { platform, state: "not configured", detail };
		if (e instanceof LoginError) return { platform, state: "login error", detail };
		return { platform, state: "error", detail };
	}
}
