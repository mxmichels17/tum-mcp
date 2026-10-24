// Web pages as collector content: the full visible text, every link and every date string as written on
// the page. The raw HTML goes to R2 separately. Nothing is shortened or interpreted.

import { decodeEntities, htmlToText } from "../lib/html";
import type { Content } from "./model";

export interface PageLink {
	text: string;
	href: string;
}

/** The main region of a page (Moodle: role="main"), or the whole body. */
export function mainRegion(html: string): string {
	const main = /<div[^>]*\brole="main"[^>]*>([\s\S]*)$/i.exec(html)?.[1] ?? /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1];
	if (main) return main.split(/<footer\b|<div[^>]*id="page-footer"/i)[0];
	return /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html;
}

export function pageLinks(html: string, base: string): PageLink[] {
	const out: PageLink[] = [];
	const seen = new Set<string>();
	for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi)) {
		const raw = decodeEntities((m[2] ?? m[3] ?? "").trim());
		if (!raw || raw.startsWith("#") || /^javascript:/i.test(raw)) continue;
		let href: string;
		try {
			href = new URL(raw, base).toString();
		} catch {
			href = raw;
		}
		const text = htmlToText(m[4]).replace(/\s+/g, " ").trim();
		const id = `${text}|${href}`;
		if (seen.has(id)) continue;
		seen.add(id);
		out.push({ text, href });
	}
	return out;
}

const MONTH = "(?:jan(?:uar|uary)?|j[äa]n(?:ner)?|feb(?:ruar|ruary)?|m[äa]r(?:z|ch)?|apr(?:il)?|mai|may|jun[ie]?|jul[iy]?|aug(?:ust)?|sep(?:t(?:ember)?)?|o[ck]t(?:ober)?|nov(?:ember)?|de[cz](?:ember)?)\\.?";
const TIME = "(?:,?\\s*(?:um\\s*|at\\s*)?\\d{1,2}[:.]\\d{2}(?:\\s*(?:uhr|am|pm|h))?)?";
const DATE_RES = [
	new RegExp(`\\b\\d{4}-\\d{2}-\\d{2}(?:[T ]\\d{2}:\\d{2}(?::\\d{2})?(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?)?`, "gi"),
	new RegExp(`\\b\\d{1,2}\\.\\s?\\d{1,2}\\.(?:\\s?\\d{2,4})?${TIME}`, "gi"),
	new RegExp(`\\b\\d{1,2}\\.?\\s+${MONTH}\\s+\\d{4}${TIME}`, "gi"),
	new RegExp(`\\b${MONTH}\\s+\\d{1,2},?\\s+\\d{4}${TIME}`, "gi"),
	new RegExp(`\\b\\d{1,2}/\\d{1,2}/\\d{2,4}${TIME}`, "gi"),
];

/** Every date string in a text, verbatim and in order of appearance. No meaning is assigned. */
export function dateStrings(text: string): string[] {
	const found: { at: number; s: string }[] = [];
	for (const re of DATE_RES) for (const m of text.matchAll(re)) found.push({ at: m.index ?? 0, s: m[0].trim() });
	found.sort((a, b) => a.at - b.at || b.s.length - a.s.length);
	const out: string[] = [];
	let end = -1;
	for (const f of found) {
		if (f.at < end) continue;
		out.push(f.s);
		end = f.at + f.s.length;
	}
	return out;
}

/** <time datetime="..."> elements as written. */
function timeElements(html: string): { datetime: string; text: string }[] {
	return [...html.matchAll(/<time\b[^>]*\bdatetime="([^"]*)"[^>]*>([\s\S]*?)<\/time>/gi)].map((m) => ({ datetime: decodeEntities(m[1]), text: htmlToText(m[2]).trim() }));
}

export function pageTitle(html: string): string {
	return htmlToText(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim();
}

/** Text, links and dates of a page. `region` false takes the whole body instead of the main region. */
export function webContent(html: string, url: string, region = true): Content {
	const part = region ? mainRegion(html) : (/<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html);
	const text = htmlToText(part).replace(/\n{3,}/g, "\n\n").trim();
	return {
		page_title: pageTitle(html),
		text,
		links: pageLinks(part, url).map((l) => ({ text: l.text, href: l.href })),
		dates: dateStrings(text),
		time_elements: timeElements(part),
	};
}

/**
 * Moodle pages carry a session key, and assignment and quiz pages count down the time left from the moment
 * of the request. Both change on every read without any change on the platform, so they are blanked
 * before the change check. The due dates themselves stay in the text.
 */
export function stripSessionParams(c: Content): Content {
	const links = (c.links as { text: string; href: string }[] | undefined)?.map((l) => ({ text: l.text, href: l.href.replace(/([?&])sesskey=[^&]*&?/g, "$1").replace(/[?&]$/, "") }));
	const text =
		typeof c.text === "string"
			? c.text.replace(/sesskey=[A-Za-z0-9]+/g, "sesskey=").replace(/\b(Verbleibende Zeit|Time remaining|Verbleibende Bearbeitungszeit|Time left)\b[^\n]*/gi, "$1 [counted from the time of reading, removed]")
			: c.text;
	return { ...c, text, ...(links ? { links } : {}) };
}
