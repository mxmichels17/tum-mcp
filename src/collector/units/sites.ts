// Units "site:<id>": external course websites from config/external-sites.json (read only, GET only).
// The listing is the start pages plus every link found on the pages read so far that lies under one of
// the site's `follow` prefixes. A page (HTML) becomes an item with its full text (HTML comments, which the
// browser does not show, are left out), links, dates and tables, and its HTML in R2. Any other content
// type is a file in R2 (streamed, at most 100 MB, no text). Videos are never downloaded.
// Pages that unlock links with a token in the URL fragment (CryptoJS AES) get the unlocked
// links as `unlocked`; the token is read from a stored item at run time and never stored.

import sitesConfig from "../../../config/external-sites.json";
import { cellText, parseTables } from "../../lib/html-table";
import { cryptoJsDecrypt } from "../../lib/cryptojs-aes";
import { withTimeout } from "../../lib/tools";
import { fileByStableKey, linkOnly, storeResponse } from "../files";
import { forget, storedKeys } from "../store";
import { type Content, type Entry, type Item, isVideo, type Json, toJson } from "../model";
import { item, type UnitCtx } from "../unit";
import { webContent } from "../web";

export interface SiteConfig {
	id: string;
	name: string;
	moodle_course?: number;
	start: string[];
	follow: string[];
	unlock?: { token_in_items_like: string };
}

export const SITES: SiteConfig[] = sitesConfig.sites;

const UA = "Mozilla/5.0 (compatible; tum-mcp collector; read only)";
const MAX_URLS = 300;
const ASSET = /\.(css|js|mjs|map|woff2?|ttf|otf|eot|ico)$/i;
/** File extensions that are read with a HEAD first, so an unchanged file is not downloaded again. */
const FILE_EXT = /\.(pdf|zip|sql|png|jpe?g|gif|svg|txt|csv|ipynb|py|java|c|h|tar|gz|tgz|docx?|pptx?|xlsx?|odt|odp|ods|md)$/i;

export const siteKey = (site: SiteConfig, url: string) => `site:${site.id}:${url}`;
export const siteScope = (site: SiteConfig) => `site:${site.id}`;

/** URLs of links that the site unit reads: under a follow prefix, no asset, no video, without #fragment. */
export function followedLinks(site: SiteConfig, hrefs: string[]): string[] {
	const out = new Set<string>();
	for (const h of hrefs) {
		let u: URL;
		try {
			u = new URL(h);
		} catch {
			continue;
		}
		u.hash = "";
		const s = u.toString();
		if (!/^https?:$/.test(u.protocol) || ASSET.test(u.pathname) || isVideo(u.pathname)) continue;
		if (site.start.includes(s) || site.follow.some((p) => s.startsWith(p))) out.add(s);
	}
	return [...out];
}

/** HTML without comments: the browser does not show them (some course sites keep the links of later modules there). */
export const withoutComments = (html: string) => html.replace(/<!--[\s\S]*?-->/g, "");

const CIPHER = /U2FsdGVkX1[A-Za-z0-9+/=]+/g;
export const TOKEN_MASK = "[access token]";
const tokenRe = (token: string) => new RegExp(token.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"), "gi");

/**
 * Rows of a page with encrypted links: per table row its cells and the decrypted values, in
 * order. The page's own check value (grantAccess("…") === "magic") tells whether the token fits.
 */
export async function unlockRows(html: string, token: string): Promise<{ valid: boolean; rows: { cells: string[]; links: string[] }[] }> {
	const check = /grantAccess\(\s*["'](U2FsdGVkX1[A-Za-z0-9+/=]+)["']\s*\)\s*===\s*["']magic["']/.exec(html)?.[1];
	const valid = check ? (await cryptoJsDecrypt(check, token)) === "magic" : false;
	const rows: { cells: string[]; links: string[] }[] = [];
	if (!valid) return { valid, rows };
	for (const r of withoutComments(html).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
		const ciphers = r[1].match(CIPHER) ?? [];
		if (!ciphers.length) continue;
		const cells = [...r[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => cellText(c[1]));
		const links: string[] = [];
		// Some unlocked links carry the token itself (pad.huds.io/#<token>); it is masked, never stored.
		for (const c of ciphers) links.push(((await cryptoJsDecrypt(c, token)) ?? "(could not decrypt)").replace(tokenRe(token), TOKEN_MASK));
		rows.push({ cells, links });
	}
	return { valid, rows };
}

/** The access token: from stored items (Moodle announcement, mail) that contain the link with the token. */
async function findToken(env: Env, like: string): Promise<string[]> {
	const rows = (await env.DB.prepare("SELECT content FROM items WHERE content LIKE ? AND status = 'present' LIMIT 10").bind(`%${like}%`).all<{ content: string }>()).results;
	const escaped = like.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
	const re = new RegExp(`${escaped}([A-Za-z0-9._~\\-]+)`, "g");
	const out = new Set<string>();
	for (const r of rows) for (const m of r.content.matchAll(re)) out.add(m[1]);
	return [...out];
}

async function get(url: string, method: "GET" | "HEAD" = "GET"): Promise<Response> {
	return withTimeout(fetch(url, { method, headers: { "User-Agent": UA }, redirect: "follow" }), 25_000, new URL(url).hostname);
}

const isHtml = (res: Response) => /html/i.test(res.headers.get("Content-Type") ?? "");
const fileName = (url: string) => decodeURIComponent(new URL(url).pathname.split("/").pop() || "file");
const versionOf = (res: Response) => [res.headers.get("Content-Length"), res.headers.get("ETag"), res.headers.get("Last-Modified")].join("|");

async function loadUrl(ctx: UnitCtx, site: SiteConfig, url: string, tokens: string[]): Promise<Item> {
	const key = siteKey(site, url);
	const base = { site: site.id, site_name: site.name, moodle_course: site.moodle_course ?? null, url };
	if (FILE_EXT.test(new URL(url).pathname)) {
		// A file: HEAD first. An unchanged file (same length, ETag, Last-Modified) is taken from R2.
		const head = await get(url, "HEAD");
		await head.body?.cancel();
		if (head.ok && !isHtml(head)) {
			// Without any version header the file is downloaded on every read and stored by its content hash.
			const stableKey = versionOf(head) === "||" ? undefined : `site:${url}|${versionOf(head)}`;
			const file = (stableKey && (await fileByStableKey(ctx.env, stableKey, url))) || (await storeResponse(ctx.env, { name: fileName(url), url, open: () => get(url), stableKey }));
			return item("site", key, file.name, url, { ...base, kind: "file", http_status: head.status, file: file as unknown as Json });
		}
	}
	const res = await get(url);
	if (!isHtml(res)) {
		if (isVideo(res.headers.get("Content-Type") ?? "")) {
			await res.body?.cancel();
			return item("site", key, fileName(url), url, { ...base, kind: "file", http_status: res.status, file: linkOnly(fileName(url), url, "video (only the link is kept)") as unknown as Json });
		}
		const file = await storeResponse(ctx.env, { name: fileName(url), url, open: async () => res, stableKey: versionOf(res) === "||" ? undefined : `site:${url}|${versionOf(res)}` });
		return item("site", key, file.name, url, { ...base, kind: "file", http_status: res.status, file: file as unknown as Json });
	}
	const html = await res.text();
	const shown = withoutComments(html);
	const page = webContent(shown, res.url || url, true);
	const content: Content = { ...base, kind: "page", http_status: res.status, page, tables: toJson(parseTables(shown).map((t) => ({ headers: t.headers, rows: t.rows }))) };
	if (site.unlock) {
		let unlocked: Json = { state: "no token found in the stored items" };
		for (const t of tokens) {
			const r = await unlockRows(html, t);
			if (r.valid) {
				unlocked = { state: "unlocked", rows: toJson(r.rows) };
				break;
			}
			unlocked = { state: "token found but not valid for this page" };
		}
		if (html.includes("U2FsdGVkX1")) content.unlocked = unlocked;
	}
	return item("site", key, String(page.page_title || url), url, content, html);
}

/** URLs linked from the stored pages of this site. */
async function storedLinks(env: Env, site: SiteConfig): Promise<string[]> {
	const rows = (await env.DB.prepare("SELECT content FROM items WHERE scope = ? AND status = 'present'").bind(siteScope(site)).all<{ content: string }>()).results;
	const hrefs: string[] = [];
	for (const r of rows) for (const l of (JSON.parse(r.content) as { page?: { links?: { href: string }[] } }).page?.links ?? []) hrefs.push(l.href);
	return followedLinks(site, hrefs);
}

export async function unitSite(ctx: UnitCtx, arg?: string): Promise<void> {
	const site = SITES.find((s) => s.id === arg);
	if (!site) throw new Error(`No site ${arg} in config/external-sites.json`);
	const tokens = site.unlock ? await findToken(ctx.env, site.unlock.token_in_items_like) : [];
	const read = new Map<string, Item>();
	// Pages read in this run can link new pages; those are listed in the next round of the same run.
	for (let round = 0; round < 4; round++) {
		const urls = [...new Set([...site.start, ...(await storedLinks(ctx.env, site))])].slice(0, MAX_URLS);
		if (round > 0 && (!urls.some((u) => !read.has(siteKey(site, u))) || !ctx.budget.canLoad())) break;
		const entries: Entry[] = urls.map((u) => {
			const key = siteKey(site, u);
			const done = read.get(key);
			if (done) return { key, item: done };
			return {
				key,
				load: async () => {
					const it = await loadUrl(ctx, site, u, tokens);
					read.set(key, it);
					return it;
				},
			};
		});
		await ctx.apply({ scope: siteScope(site), complete: true, entries });
	}
}

/**
 * Sites removed from config/external-sites.json: their items and undelivered deltas are forgotten (no
 * "removed" delta), and their pending marker and unit_runs row are dropped. Returns the number of items.
 */
export async function forgetRemovedSites(env: Env): Promise<number> {
	const ids = SITES.map((s) => `site:${s.id}`);
	const marks = ids.map(() => "?").join(",");
	const keys = await storedKeys(env.DB, `source = 'site' AND scope NOT IN (${marks || "''"})`, ...ids);
	await forget(env, keys);
	await env.DB.batch([
		env.DB.prepare(`DELETE FROM state WHERE key LIKE 'pending:site:%' AND substr(key, 9) NOT IN (${marks || "''"})`).bind(...ids),
		env.DB.prepare(`DELETE FROM unit_runs WHERE unit LIKE 'site:%' AND unit NOT IN (${marks || "''"})`).bind(...ids),
	]);
	return keys.length;
}
