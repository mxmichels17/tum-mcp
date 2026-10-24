// fetch with a cookie jar and manual redirects, for web logins (SAML SSO, form logins).

import { decodeEntities } from "./html";
import { withTimeout } from "./tools";

// A cookie with a Path other than "/" is stored as "name\tpath", so the same name can exist for several paths
// (Keycloak sets AUTH_SESSION_ID per realm). Keys without a tab are path "/", as in sessions stored before 0.6.10.
const PATH_SEP = "\t";

function splitKey(key: string): { name: string; path: string } {
	const i = key.indexOf(PATH_SEP);
	return i < 0 ? { name: key, path: "/" } : { name: key.slice(0, i), path: key.slice(i + 1) };
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
	if (requestPath === cookiePath || cookiePath === "/") return true;
	return requestPath.startsWith(cookiePath) && (cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/");
}

/** True when Max-Age is 0 or less, or Expires lies in the past (RFC 6265 5.2.1, 5.2.2). */
export function cookieExpired(attrs: string[], now = Date.now()): boolean {
	for (const raw of attrs) {
		const a = raw.trim();
		const maxAge = /^max-age=\s*(-?\d+)/i.exec(a);
		if (maxAge) return Number(maxAge[1]) <= 0; // Max-Age wins over Expires
	}
	for (const raw of attrs) {
		const exp = /^expires=(.*)$/i.exec(raw.trim());
		if (!exp) continue;
		// Keycloak writes "Thu, 01-Jan-1970 00:00:10 GMT"; Date.parse needs spaces instead of dashes.
		const t = Date.parse(exp[1].replace(/(\d{1,2})-([A-Za-z]{3})-(\d{2,4})/, "$1 $2 $3"));
		if (!Number.isNaN(t) && t <= now) return true;
	}
	return false;
}

export class CookieJar {
	cookies = new Map<string, Map<string, string>>(); // host -> name (or name\tpath) -> value
	/** When set, jarFetch writes per request the cookie names sent and set (never values). For login diagnostics. */
	log?: string[];

	constructor(initial?: Record<string, Record<string, string>>) {
		for (const [host, list] of Object.entries(initial ?? {})) this.cookies.set(host, new Map(Object.entries(list)));
	}

	header(url: URL): string | undefined {
		const found: { name: string; path: string; value: string }[] = [];
		for (const [host, list] of this.cookies) {
			if (url.hostname !== host && !url.hostname.endsWith(`.${host}`)) continue;
			for (const [k, value] of list) {
				const { name, path } = splitKey(k);
				if (pathMatches(url.pathname, path)) found.push({ name, path, value });
			}
		}
		// Longer paths first, as browsers send them (RFC 6265 5.4).
		found.sort((a, b) => b.path.length - a.path.length);
		return found.length ? found.map((c) => `${c.name}=${c.value}`).join("; ") : undefined;
	}

	store(url: URL, res: Response) {
		for (const line of res.headers.getSetCookie()) {
			const [pair, ...attrs] = line.split(";");
			const eq = pair.indexOf("=");
			if (eq < 1) continue;
			const name = pair.slice(0, eq).trim();
			const value = pair.slice(eq + 1).trim();
			const domainAttr = attrs.map((a) => a.trim()).find((a) => /^domain=/i.test(a));
			const host = domainAttr ? domainAttr.slice(7).replace(/^\./, "").toLowerCase() : url.hostname;
			const pathAttr = attrs.map((a) => a.trim()).find((a) => /^path=/i.test(a));
			const path = pathAttr?.slice(5).trim().startsWith("/") ? pathAttr.slice(5).trim() : "/";
			const key = path === "/" ? name : `${name}${PATH_SEP}${path}`;
			const expired = cookieExpired(attrs);
			const list = this.cookies.get(host) ?? new Map<string, string>();
			if (expired || value === "") list.delete(key);
			else list.set(key, value);
			this.cookies.set(host, list);
		}
	}

	/** Value of a cookie by name, for any path ("/" first). */
	get(host: string, name: string): string | undefined {
		const list = this.cookies.get(host);
		if (!list) return undefined;
		if (list.has(name)) return list.get(name);
		for (const [k, v] of list) if (splitKey(k).name === name) return v;
		return undefined;
	}

	toJSON(): Record<string, Record<string, string>> {
		const out: Record<string, Record<string, string>> = {};
		for (const [h, l] of this.cookies) out[h] = Object.fromEntries(l);
		return out;
	}
}

const UA = "Mozilla/5.0 (compatible; tum-mcp/0.2)";

export interface JarResponse {
	url: URL;
	status: number;
	headers: Headers;
	text: string;
	/** Status and URL (without query) of every response in this call, redirects included. For login errors. */
	trail: string[];
}

/** One diagnostic line: cookie names sent, and per Set-Cookie the name, Path, SameSite and expiry. No values. */
export function cookieLogLine(method: string, res: Response, url: URL, sentHeader?: string): string {
	const sent = (sentHeader ?? "")
		.split(";")
		.map((c) => c.split("=")[0].trim())
		.filter(Boolean);
	const set = res.headers.getSetCookie().map((line) => {
		const [pair, ...attrs] = line.split(";");
		const name = pair.slice(0, Math.max(0, pair.indexOf("="))).trim() || "?";
		const path = attrs.map((a) => a.trim()).find((a) => /^path=/i.test(a))?.slice(5) ?? "-";
		const site = attrs.map((a) => a.trim()).find((a) => /^samesite=/i.test(a))?.slice(9) ?? "-";
		const empty = pair.slice(pair.indexOf("=") + 1).trim() === "";
		return `${name}(${path},${site}${cookieExpired(attrs) || empty ? ",deleted" : ""})`;
	});
	return `${method} ${res.status} ${url.host}${url.pathname} | sent: ${sent.join(",") || "-"} | set: ${set.join(" ") || "-"}`;
}

/** Fetches with cookies and follows up to 10 redirects. Returns the final page as text. */
export async function jarFetch(
	jar: CookieJar,
	input: string | URL,
	init: { method?: string; body?: BodyInit; headers?: Record<string, string> } = {},
	timeoutMs = 20_000,
): Promise<JarResponse> {
	let url = new URL(input);
	let method = init.method ?? "GET";
	let body = init.body;
	const trail: string[] = [];
	for (let i = 0; i < 10; i++) {
		const headers: Record<string, string> = { "User-Agent": UA, ...init.headers };
		const cookie = jar.header(url);
		if (cookie) headers.Cookie = cookie;
		const res = await withTimeout(fetch(url, { method, body, headers, redirect: "manual" }), timeoutMs, url.hostname);
		jar.store(url, res);
		trail.push(`${method} ${res.status} ${url.origin}${url.pathname}`);
		if (jar.log) jar.log.push(cookieLogLine(method, res, url, cookie));
		const loc = res.headers.get("Location");
		if (res.status >= 300 && res.status < 400 && loc) {
			await res.body?.cancel();
			url = new URL(loc, url);
			if (res.status !== 307 && res.status !== 308) {
				method = "GET";
				body = undefined;
			}
			continue;
		}
		return { url, status: res.status, headers: res.headers, text: await res.text(), trail };
	}
	throw new Error(`Too many redirects at ${url.href}`);
}

export interface HtmlLoginForm {
	action: URL;
	/** Last value per name. */
	fields: Record<string, string>;
	/** All values of names that occur more than once. */
	multi: Record<string, string[]>;
}

/**
 * Reads the first <form> of a page: action and the named inputs a browser sends without a click (hidden, text,
 * checked boxes and radios). Submit buttons are left out: a browser sends only the clicked one, and the caller
 * sets it. (Shibboleth's consent page has the buttons _eventId_AttributeReleaseRejected and _eventId_proceed.)
 */
export function parseForm(html: string, baseUrl: URL): HtmlLoginForm | undefined {
	const m = /<form\b[^>]*>([\s\S]*?)<\/form>/i.exec(html);
	if (!m) return undefined;
	const actionAttr = /action="([^"]*)"/i.exec(m[0])?.[1] ?? "";
	const fields: Record<string, string> = {};
	const multi: Record<string, string[]> = {};
	for (const input of m[1].matchAll(/<input\b[^>]*>/gi)) {
		const name = /name="([^"]*)"/i.exec(input[0])?.[1];
		if (!name) continue;
		const type = /type="([^"]*)"/i.exec(input[0])?.[1]?.toLowerCase();
		if (type === "submit" || type === "button" || type === "image" || type === "reset") continue;
		if ((type === "checkbox" || type === "radio") && !/\schecked\b/i.test(input[0])) continue;
		const value = decodeEntities(/value="([^"]*)"/i.exec(input[0])?.[1] ?? "");
		if (name in fields) (multi[name] ??= [fields[name]]).push(value);
		fields[name] = value;
	}
	return { action: new URL(decodeEntities(actionAttr) || baseUrl.href, baseUrl), fields, multi };
}

/**
 * Form body from `fields` (the form's fields with the caller's changes). A name the form has several times
 * (Shibboleth's _shib_idp_consentIds, one per attribute) is sent with all its values, as a browser does,
 * unless the caller changed it.
 */
export function formBody(form: HtmlLoginForm, fields: Record<string, string>): URLSearchParams {
	const body = new URLSearchParams();
	for (const [k, v] of Object.entries(fields)) {
		const all = form.multi[k];
		if (all && v === all[all.length - 1]) for (const x of all) body.append(k, x);
		else body.append(k, v);
	}
	return body;
}
