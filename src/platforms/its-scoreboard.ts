// ITS scoreboard (IT-Sicherheit, chair I20): https://scoreboard.sec.in.tum.de/scoreboard
// Checked 2026-10-17: not public. Without login, /scoreboard redirects to / with "Sign in using TUM-ID"
// (/shib-login, TUM SSO) and an "Alternativer Login" (email and password). This module uses TUM SSO.
// The scoreboard markup was not visible without login, so the parser reads any HTML table generically.
// Logged in, the menu has: /scoreboard, /tasks, /materialien, /booking, /tutorials/attend, /team, /sshkeys
// (seen 2026-10-22). Every request here is a GET; action links are refused (safeScoreboardUrl).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { htmlToText } from "../lib/html";
import { parseTables, type Table } from "../lib/html-table";
import { CookieJar } from "../lib/http";
import { storeDelete, storeGet, storePut } from "../lib/store";
import { json, LoginError, NotConfiguredError, type PlatformStatus, run, withTimeout } from "../lib/tools";
import { tumSsoLogin } from "../lib/tum-sso";
import { webContent } from "../collector/web";

const SITE = "https://scoreboard.sec.in.tum.de";
const HOST = "scoreboard.sec.in.tum.de";
const STORE_KEY = "its-scoreboard-session";

/**
 * Words that mark a link as an action (logout, joining or leaving a team, registering, submitting, booking,
 * deleting, adding keys, starting instances and the like). Such paths are never requested, so reading never
 * changes anything on the scoreboard. A path segment matches when it is the word or starts with it and a
 * separator ("delete_key", "join-team"). Query keys and values are checked the same way.
 */
const ACTION = /^(logout|logoff|signout|abmelden|delete|del|remove|rm|destroy|drop|leave|join|submit|upload|accept|decline|confirm|cancel|unbook|book|storno|revoke|reset|activate|deactivate|register|unregister|signup|invite|kick|promote|demote|vote|update|edit|create|new|add|set|toggle|checkin|check-in|claim|redeem|flag|solve|start|stop|restart|spawn|deploy|shib-login|login|shibboleth\.sso)(?:[_\-.]|$)/i;
/** Query parameters that carry a secret or a one-time token. Links with them are not followed. */
const SECRET_PARAM = /token|csrf|nonce|sig|signature|auth|session|key/i;

/** True when a URL is on the scoreboard host and is no action link (see ACTION). */
export function safeScoreboardUrl(u: URL): boolean {
	if (u.hostname !== HOST || u.protocol !== "https:") return false;
	const segments = u.pathname.split("/").filter(Boolean).map((x) => decodeURIComponent(x));
	if (segments.some((x) => ACTION.test(x))) return false;
	for (const [k, v] of u.searchParams) if (ACTION.test(k) || ACTION.test(v) || SECRET_PARAM.test(k)) return false;
	return true;
}

async function loginJar(env: Env, fresh: boolean): Promise<CookieJar> {
	const stored = fresh ? undefined : await storeGet<Record<string, Record<string, string>>>(env, STORE_KEY);
	const jar = new CookieJar(stored);
	if (!stored) {
		await tumSsoLogin(env, jar, `${SITE}/shib-login`);
		await storePut(env, STORE_KEY, jar.toJSON(), 12 * 3600);
	}
	return jar;
}

/** A redirect to the start page or to the login means the session is gone. */
const toLogin = (u: URL) => u.hostname !== HOST || u.pathname === "/" || /shib|login/i.test(u.pathname);

/**
 * GET of one scoreboard URL with the TUM SSO session, read only. Follows redirects on the host and logs in
 * again once when the session is gone. Refuses action links (safeScoreboardUrl). The body is not read.
 */
export async function scoreboardFetch(env: Env, path: string): Promise<{ url: URL; res: Response }> {
	const start = new URL(path, SITE);
	if (!safeScoreboardUrl(start)) throw new Error(`Not read: ${start.pathname}${start.search} is not a plain page of ${HOST} (action link or other host)`);
	for (let attempt = 0; attempt < 2; attempt++) {
		const jar = await loginJar(env, attempt > 0);
		let url = start;
		let expired = false;
		for (let i = 0; i < 6; i++) {
			const headers: Record<string, string> = {};
			const cookie = jar.header(url);
			if (cookie) headers.Cookie = cookie;
			const res = await withTimeout(fetch(url, { headers, redirect: "manual" }), 25_000, HOST);
			jar.store(url, res);
			const loc = res.headers.get("Location");
			if (res.status >= 300 && res.status < 400 && loc) {
				await res.body?.cancel();
				const next = new URL(loc, url);
				if (toLogin(next) && !toLogin(start)) {
					expired = true;
					break;
				}
				if (!safeScoreboardUrl(next)) throw new Error(`Not read: ${url.pathname} redirects to ${next.origin}${next.pathname}, which is not a plain page`);
				url = next;
				continue;
			}
			if (res.status === 401 || res.status === 403) {
				await res.body?.cancel();
				expired = true;
				break;
			}
			return { url, res };
		}
		if (!expired) throw new Error(`Too many redirects at ${url.href}`);
		await storeDelete(env, STORE_KEY);
	}
	throw new LoginError(`ITS scoreboard: ${start.pathname} still needs a login after a new TUM login`);
}

/** Text of one scoreboard page (see scoreboardFetch). */
export async function scoreboardHtml(env: Env, path: string): Promise<{ url: URL; status: number; html: string }> {
	const { url, res } = await scoreboardFetch(env, path);
	return { url, status: res.status, html: await res.text() };
}

export async function scoreboardPage(env: Env): Promise<string> {
	const r = await scoreboardHtml(env, "/scoreboard");
	if (r.status !== 200 || !r.url.pathname.startsWith("/scoreboard")) throw new LoginError(`ITS scoreboard did not open after the TUM login (ended at ${r.url.pathname}, HTTP ${r.status})`);
	return r.html;
}

export function mainTable(html: string): Table {
	const tables = parseTables(html);
	if (!tables.length) {
		throw new Error(`No table found on the scoreboard page. Page text: ${htmlToText(html).replace(/\s+/g, " ").slice(0, 500)}`);
	}
	return tables.reduce((a, b) => (b.rows.length > a.rows.length ? b : a));
}

function toObjects(t: Pick<Table, "headers" | "rows">): Record<string, string>[] {
	return t.rows.map((r) => Object.fromEntries(r.map((v, i) => [t.headers[i] || `col${i + 1}`, v])));
}

/** The column with the team or player names: a header like Team/Name, else the most non-numeric column. */
export function nameColumn(t: Table): number {
	const byHeader = t.headers.findIndex((h) => /team|name|user|spieler|player|nick/i.test(h));
	if (byHeader >= 0) return byHeader;
	let best = 0;
	let bestCount = -1;
	const cols = Math.max(0, ...t.rows.map((r) => r.length));
	for (let c = 0; c < cols; c++) {
		const count = t.rows.filter((r) => r[c] && !/^[\d.,\s%-]+$/.test(r[c])).length;
		if (count > bestCount) {
			best = c;
			bestCount = count;
		}
	}
	return best;
}

function scoreColumn(t: Table): number {
	return t.headers.findIndex((h) => /score|punkte|points/i.test(h));
}

/** Rank by score, highest first, equal scores share a rank. Undefined without a score column. */
export function ranksByScore(t: Table): (number | undefined)[] {
	const sc = scoreColumn(t);
	if (sc < 0) return t.rows.map(() => undefined);
	const scores = t.rows.map((r) => Number.parseFloat((r[sc] ?? "").replace(",", ".")));
	return scores.map((v) => (Number.isFinite(v) ? scores.filter((o) => Number.isFinite(o) && o > v).length + 1 : undefined));
}

function levenshtein(a: string, b: string): number {
	const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		let prev = dp[0];
		dp[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const tmp = dp[j];
			dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
			prev = tmp;
		}
	}
	return dp[b.length];
}

const norm = (x: string) => x.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();

/** Similarity 0..1 between a search name and a cell. Substring matches score high. */
export function similarity(query: string, cell: string): number {
	const a = norm(query);
	const b = norm(cell);
	if (!a || !b) return 0;
	if (a === b) return 1;
	if (b.includes(a) || a.includes(b)) return 0.9 * (Math.min(a.length, b.length) / Math.max(a.length, b.length)) + 0.1;
	return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

export function findEntry(t: Table, name: string): { index: number; rank: number | string; entry: Record<string, string> } | undefined {
	const col = nameColumn(t);
	const needle = norm(name);
	const i = t.rows.findIndex((r) => norm(r[col] ?? "") === needle);
	if (i < 0) return undefined;
	const rankCol = t.headers.findIndex((h) => /^(#|rang|rank|platz|pos)/i.test(h));
	return { index: i, rank: rankCol >= 0 ? t.rows[i][rankCol] : i + 1, entry: toObjects(t)[i] };
}

export function closestEntries(t: Table, name: string, n = 5) {
	const col = nameColumn(t);
	const ranks = ranksByScore(t);
	const objects = toObjects(t);
	return t.rows
		.map((r, i) => ({ name: r[col] ?? "", similarity: Math.round(similarity(name, r[col] ?? "") * 100) / 100, rank_by_score: ranks[i], entry: objects[i] }))
		.sort((a, b) => b.similarity - a.similarity)
		.slice(0, n);
}

/** One scoreboard page as data: title, full text, links, dates and tables. Files are named, not read. */
export async function scoreboardPageData(env: Env, path: string) {
	const { url, res } = await scoreboardFetch(env, path);
	const type = (res.headers.get("Content-Type") ?? "").split(";")[0].trim();
	if (type && !/html/i.test(type)) {
		await res.body?.cancel();
		return { url: url.toString(), http_status: res.status, content_type: type, file: true, note: "a file, not a page; the collector stores it in R2 (collector_item)" };
	}
	const html = await res.text();
	const c = webContent(html, url.toString(), false);
	return {
		url: url.toString(),
		http_status: res.status,
		title: c.page_title,
		text: c.text,
		links: c.links,
		dates: c.dates,
		tables: parseTables(html).map((t) => ({ headers: t.headers, rows: t.rows })),
	};
}

export function registerItsScoreboardTools(server: McpServer, env: Env) {
	const ro = { readOnlyHint: true, openWorldHint: true };

	server.registerTool(
		"its_scoreboard_page",
		{
			description:
				"One page of the ITS scoreboard (scoreboard.sec.in.tum.de) as the user sees it when logged in with TUM SSO: title, full text, links, dates and tables. Pages: /scoreboard, /tasks, /materialien, /booking, /tutorials/attend, /team, /sshkeys and every page linked from them. Read only: only GET, action links (logout, join, register, submit, book, delete and the like) are refused.",
			inputSchema: { path: z.string().min(1).describe("Path on the scoreboard, for example /tasks or /materialien") },
			annotations: ro,
		},
		async ({ path }) => run(async () => json(await scoreboardPageData(env, path))),
	);

	server.registerTool(
		"its_scoreboard_task",
		{
			description:
				"One task page of the ITS scoreboard: description, points, dates, hints and attachment links, as shown when logged in. Give the path of the task page, or a name or number that its link on /tasks contains (for example t03 or Buffer). Without a match it returns the task links of /tasks. Read only.",
			inputSchema: { task: z.string().min(1).describe("Task path (/...) or a text of its link on /tasks") },
			annotations: ro,
		},
		async ({ task }) =>
			run(async () => {
				if (task.startsWith("/")) return json(await scoreboardPageData(env, task));
				const list = await scoreboardPageData(env, "/tasks");
				const links = ("links" in list ? (list.links as { text: string; href: string }[]) : []).filter((l) => {
					try {
						const u = new URL(l.href);
						return safeScoreboardUrl(u) && u.pathname !== "/tasks" && /task/i.test(u.pathname);
					} catch {
						return false;
					}
				});
				const q = task.toLowerCase();
				const hit = links.find((l) => l.text.toLowerCase() === q) ?? links.find((l) => l.text.toLowerCase().includes(q) || l.href.toLowerCase().includes(q));
				if (!hit) return json({ found: false, searched: task, task_links: links });
				return json({ found: true, link: hit, ...(await scoreboardPageData(env, new URL(hit.href).pathname + new URL(hit.href).search)) });
			}),
	);

	server.registerTool(
		"its_scoreboard_team",
		{
			description:
				"My team on the ITS scoreboard (/team) as shown when logged in: team name and members, or the registration state when I am not in a team yet. Read only: nothing is registered or joined.",
			inputSchema: {},
			annotations: ro,
		},
		async () => run(async () => json(await scoreboardPageData(env, "/team"))),
	);

	server.registerTool(
		"public_its_scoreboard",
		{
			description:
				"The ITS (IT-Sicherheit) scoreboard at scoreboard.sec.in.tum.de: all teams with their columns, plus rank_by_score (highest score first). Logs in with TUM SSO.",
			inputSchema: { limit: z.number().int().min(1).max(1000).default(100) },
			annotations: ro,
		},
		async ({ limit }) =>
			run(async () => {
				const t = mainTable(await scoreboardPage(env));
				const ranks = ranksByScore(t);
				return json({
					columns: t.headers,
					name_column: t.headers[nameColumn(t)],
					total: t.rows.length,
					entries: toObjects(t)
						.map((e, i) => ({ rank_by_score: ranks[i], ...e }))
						.slice(0, limit),
				});
			}),
	);

	server.registerTool(
		"public_its_scoreboard_me",
		{
			description:
				"My team's entry and rank on the ITS scoreboard. The scoreboard lists teams, so ITS_SCOREBOARD_NAME (or the name given here) must be the team name. Without an exact match it returns the columns and the 5 closest names.",
			inputSchema: { name: z.string().min(1).optional().describe("Team name as shown on the scoreboard. Default: ITS_SCOREBOARD_NAME") },
			annotations: ro,
		},
		async ({ name }) =>
			run(async () => {
				const who = name ?? env.ITS_SCOREBOARD_NAME?.trim();
				if (!who) throw new NotConfiguredError("its scoreboard", ["ITS_SCOREBOARD_NAME (or pass a team name)"]);
				const t = mainTable(await scoreboardPage(env));
				const hit = findEntry(t, who);
				if (!hit) {
					return json({
						found: false,
						searched: who,
						name_column: t.headers[nameColumn(t)],
						columns: t.headers,
						total: t.rows.length,
						closest: closestEntries(t, who, 5),
						hint: "The scoreboard lists teams. Set ITS_SCOREBOARD_NAME to your team name exactly as shown.",
					});
				}
				return json({
					found: true,
					name: who,
					position_column: hit.rank,
					rank_by_score: ranksByScore(t)[hit.index],
					of: t.rows.length,
					columns: t.headers,
					entry: hit.entry,
				});
			}),
	);
}

export async function itsScoreboardStatus(env: Env): Promise<PlatformStatus> {
	const platform = "its scoreboard";
	try {
		const t = mainTable(await scoreboardPage(env));
		const me = env.ITS_SCOREBOARD_NAME?.trim() ? findEntry(t, env.ITS_SCOREBOARD_NAME) : undefined;
		const named = env.ITS_SCOREBOARD_NAME?.trim();
		const detail = `${t.rows.length} teams${named ? (me ? `, my team at rank ${ranksByScore(t)[me.index] ?? me.rank} by score` : ", ITS_SCOREBOARD_NAME not found (team name needed, see public_its_scoreboard_me)") : ", ITS_SCOREBOARD_NAME not set"}`;
		return { platform, state: "OK", detail };
	} catch (e) {
		const detail = e instanceof Error ? e.message : String(e);
		if (e instanceof NotConfiguredError) return { platform, state: "not configured", detail };
		if (e instanceof LoginError) return { platform, state: "login error", detail };
		return { platform, state: "error", detail };
	}
}
