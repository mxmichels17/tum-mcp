// HTML tables and forms, for pages without an API (Moodle web pages, ITS scoreboard).

import { decodeEntities, htmlToText } from "./html";

export interface Table {
	headers: string[];
	rows: string[][];
	/** Raw HTML of each data row, for links. */
	rowHtml: string[];
	/** class attribute of the table */
	className: string;
	id: string;
}

/**
 * Visible text of a table cell: link texts without URLs, without action menus, icons and
 * screen-reader-only labels.
 */
export function cellText(html: string): string {
	let h = html;
	for (let i = 0; i < 3; i++) {
		h = h.replace(/<(div|span)\b[^>]*class="[^"]*\b(?:action-menu|dropdown|dropdown-menu|sr-only|accesshide|visually-hidden)\b[^"]*"[^>]*>[\s\S]*?<\/\1>/gi, " ");
	}
	h = h.replace(/<a\b[^>]*>/gi, "").replace(/<\/a>/gi, "");
	return htmlToText(h).replace(/\s+/g, " ").trim();
}

/**
 * All tables of a page. The header is the first row that has only <th> cells.
 * Data rows keep <th> and <td> cells in document order (Moodle puts item names in <th>).
 */
export function parseTables(html: string): Table[] {
	const tables: Table[] = [];
	for (const t of html.matchAll(/<table\b([^>]*)>([\s\S]*?)<\/table>/gi)) {
		const rows = [...t[2].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => ({
			html: r[0],
			cells: [...r[1].matchAll(/<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((c) => ({ th: c[1].toLowerCase() === "th", text: cellText(c[2]) })),
		}));
		const headerIdx = rows.findIndex((r) => r.cells.length && r.cells.every((c) => c.th));
		const data = rows.filter((r, i) => i !== headerIdx && r.cells.length && r.cells.some((c) => !c.th));
		tables.push({
			headers: headerIdx >= 0 ? rows[headerIdx].cells.map((c) => c.text) : [],
			rows: data.map((r) => r.cells.map((c) => c.text)),
			rowHtml: data.map((r) => r.html),
			className: /class="([^"]*)"/.exec(t[1])?.[1] ?? "",
			id: /id="([^"]*)"/.exec(t[1])?.[1] ?? "",
		});
	}
	return tables;
}

/** Two-column tables (label in <th> or first cell, value in the last cell) as key/value pairs. */
export function keyValueRows(html: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const r of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
		const cells = [...r[1].matchAll(/<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((c) => cellText(c[2]));
		if (cells.length === 2 && cells[0] && !(cells[0] in out)) out[cells[0]] = cells[1];
	}
	return out;
}

export interface HtmlForm {
	action: URL;
	method: string;
	id: string;
	fields: Record<string, string>;
	/** names of submit buttons with their values */
	buttons: Record<string, string>;
}

const attr = (tag: string, name: string) => {
	const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
	return m ? decodeEntities(m[2] ?? m[3] ?? "") : undefined;
};

/** All forms of a page with their current field values (inputs, checked boxes, textareas, selects). */
export function parseForms(html: string, baseUrl: URL): HtmlForm[] {
	const forms: HtmlForm[] = [];
	for (const f of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
		const fields: Record<string, string> = {};
		const buttons: Record<string, string> = {};
		const body = f[2];
		for (const input of body.matchAll(/<input\b[^>]*>/gi)) {
			const name = attr(input[0], "name");
			if (!name) continue;
			const type = (attr(input[0], "type") ?? "text").toLowerCase();
			const value = attr(input[0], "value") ?? "";
			if (type === "submit" || type === "button" || type === "image") {
				buttons[name] = value;
				continue;
			}
			if ((type === "checkbox" || type === "radio") && !/\bchecked\b/i.test(input[0])) continue;
			if (type === "file") continue;
			fields[name] = value;
		}
		for (const ta of body.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
			const name = attr(ta[1], "name");
			if (name) fields[name] = decodeEntities(ta[2]);
		}
		for (const sel of body.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
			const name = attr(sel[1], "name");
			if (!name) continue;
			const options = [...sel[2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)];
			const chosen = options.find((o) => /\bselected\b/i.test(o[1])) ?? options[0];
			if (chosen) fields[name] = attr(chosen[1], "value") ?? cellText(chosen[2]);
		}
		for (const b of body.matchAll(/<button\b([^>]*)>/gi)) {
			const name = attr(b[1], "name");
			if (name) buttons[name] = attr(b[1], "value") ?? "";
		}
		forms.push({
			action: new URL(attr(f[1], "action") || baseUrl.href, baseUrl),
			method: (attr(f[1], "method") ?? "get").toLowerCase(),
			id: attr(f[1], "id") ?? "",
			fields,
			buttons,
		});
	}
	return forms;
}

/** All links of a page as absolute URLs with their text. */
export function parseLinks(html: string, baseUrl: URL): { url: string; text: string }[] {
	const out: { url: string; text: string }[] = [];
	for (const a of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
		const href = attr(a[1], "href");
		if (!href || href.startsWith("#") || href.startsWith("javascript:")) continue;
		try {
			out.push({ url: new URL(href, baseUrl).href, text: cellText(a[2]) });
		} catch {
			// ignore broken links
		}
	}
	return out;
}
