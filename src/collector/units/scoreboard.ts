// Unit "its_scoreboard": every page and file that the ITS scoreboard (scoreboard.sec.in.tum.de) shows to
// the user when logged in with TUM SSO: scoreboard, tasks and each task page, course materials and their files,
// presentation booking, tutorial attendance, team and SSH keys, and every further page linked from them.
// Read only: only GET requests, no form is ever sent, and links with an action word (logout, join, register,
// submit, book, delete and the like, see safeScoreboardUrl) are never requested.
// The listing is the start page plus every link on the host found on the pages read so far, so a page
// that is no longer linked shows up as removed. Pages have no version mark and are read again in rotation.
// Files go to R2 like Moodle files, without any text extraction.

import { scoreboardFetch, safeScoreboardUrl } from "../../platforms/its-scoreboard";
import { storeResponse } from "../files";
import type { Content, Entry, Item, Json } from "../model";
import { item, type UnitCtx } from "../unit";
import { webContent } from "../web";

const SITE = "https://scoreboard.sec.in.tum.de";
const SOURCE = "its_scoreboard";
const SCOPE = "its_scoreboard";
const ROOT = "/scoreboard";
/** Upper limit of URLs in the listing, in case a page links endless variants of itself. */
const MAX_URLS = 300;
/** Page assets, not content. */
const ASSET = /\.(css|js|mjs|map|woff2?|ttf|otf|eot|ico)$/i;

/** Path and query of a URL; the key of its item. The scoreboard table keeps the key it has had since 0.7.0. */
export const pathOf = (u: URL) => `${u.pathname}${u.search}`;
export const scoreboardKey = (path: string) => (path === ROOT ? "its_scoreboard:page" : `its_scoreboard:url:${path}`);

/** Links of a page that the unit reads: on the host, no action link, no page asset. */
export function readableLinks(hrefs: string[]): string[] {
	const out = new Set<string>();
	for (const h of hrefs) {
		let u: URL;
		try {
			u = new URL(h, SITE);
		} catch {
			continue;
		}
		u.hash = "";
		if (!safeScoreboardUrl(u) || ASSET.test(u.pathname)) continue;
		out.add(pathOf(u));
	}
	return [...out];
}

/**
 * The team page shows a one-time code to form a team ("The code is valid for 60 minutes"). It is new on
 * every read and lets another student join the user's team, so it is blanked in the content (the HTML in R2
 * keeps the page as served). Everything else on the page stays.
 */
export function blankTeamCode(c: Content): Content {
	if (typeof c.text !== "string") return c;
	return { ...c, text: c.text.replace(/(valid for \d+ minutes:\s*)[A-Z0-9]{6,}/gi, "$1[one-time team code, not stored]") };
}

async function load(ctx: UnitCtx, path: string, linkText?: string): Promise<Item> {
	const { url, res } = await scoreboardFetch(ctx.env, path);
	const type = (res.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
	const key = scoreboardKey(path);
	if (type === "text/html" || type === "application/xhtml+xml" || (!type && !/\.[a-z0-9]{1,5}$/i.test(url.pathname))) {
		const html = await res.text();
		const page = blankTeamCode(webContent(html, url.toString(), false));
		const content: Content = path === ROOT ? { page } : { path, final_url: url.toString(), http_status: res.status, kind: "page", page };
		return item(SOURCE, key, String(page.page_title || path), url.toString(), content, html);
	}
	// Downloads like /tasks/6/dl come without a file name; the link text on the task page names them (t04.zip).
	const last = decodeURIComponent(url.pathname.split("/").pop() || "file");
	const name = !/\.[a-z0-9]{1,5}$/i.test(last) && linkText && /^[^\s/]+\.[a-z0-9]{1,5}$/i.test(linkText.trim()) ? linkText.trim() : last;
	const file = await storeResponse(ctx.env, { name, url: url.toString(), open: async () => res });
	return item(SOURCE, key, file.name || name, url.toString(), { path, final_url: url.toString(), http_status: res.status, kind: "file", file: file as unknown as Json });
}

/** Paths linked from the stored pages of this listing, with the text of the first link to each. */
async function storedLinks(env: Env): Promise<{ paths: string[]; texts: Map<string, string> }> {
	const rows = (await env.DB.prepare("SELECT content FROM items WHERE scope = ? AND status = 'present'").bind(SCOPE).all<{ content: string }>()).results;
	const hrefs: string[] = [];
	const texts = new Map<string, string>();
	for (const r of rows) {
		const c = JSON.parse(r.content) as { page?: { links?: { href: string; text: string }[] } };
		for (const l of c.page?.links ?? []) {
			hrefs.push(l.href);
			const [p] = readableLinks([l.href]);
			if (p && l.text && !texts.has(p)) texts.set(p, l.text);
		}
	}
	return { paths: readableLinks(hrefs), texts };
}

export async function unitScoreboard(ctx: UnitCtx): Promise<void> {
	const read = new Map<string, Item>();
	// Pages read in this run can link new pages; those are listed in the next round of the same run.
	for (let round = 0; round < 4; round++) {
		const links = await storedLinks(ctx.env);
		const paths = [ROOT, ...links.paths.filter((p) => p !== ROOT)].slice(0, MAX_URLS);
		const fresh = paths.filter((p) => !read.has(scoreboardKey(p)));
		if (round > 0 && (!fresh.length || !ctx.budget.canLoad())) break;
		const entries: Entry[] = paths.map((p) => {
			const key = scoreboardKey(p);
			const done = read.get(key);
			if (done) return { key, item: done };
			return {
				key,
				load: async () => {
					const it = await load(ctx, p, links.texts.get(p));
					read.set(key, it);
					return it;
				},
			};
		});
		await ctx.apply({ scope: SCOPE, complete: true, entries });
		if (paths.length >= MAX_URLS) ctx.note(`more than ${MAX_URLS} scoreboard URLs: only the first ${MAX_URLS} are read`);
	}
}
