// TUMonline personal data through the token web service "wbservicesbasic" (XML).
// Functions and parameters from TUM-Dev/Campus-Android (TUMOnlineAPIService.kt), TUM-Dev/campus_flutter
// and the gist zsewa/ce45cf64c1802d2d0bbf7c5665ea2950. Checked live on 2026-10-17: the endpoints still answer
// after the July 2026 move of TUMonline to Public REST APIs (that move replaced the institutional web services).
// Token: secret TUMONLINE_TOKEN, else the token that tumonline_request_token stored in KV.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { storeGet, storePut } from "../lib/store";
import { CONFIRM, json, LoginError, NotConfiguredError, type PlatformStatus, requireSecrets, run, withTimeout } from "../lib/tools";
import { child, childrenNamed, parseXml, textOf, type XmlNode, xmlToJson } from "../lib/xml";

const BASE = "https://campus.tum.de/tumonline";
const STORE_KEY = "tumonline-token";
const TIMEOUT_MS = 30_000;

export class TokenNotConfirmedError extends Error {}
export class NoRightsError extends Error {}

async function token(env: Env): Promise<string> {
	const fromSecret = env.TUMONLINE_TOKEN?.trim();
	if (fromSecret) return fromSecret;
	const stored = await storeGet<{ token: string }>(env, STORE_KEY);
	if (stored?.token) return stored.token;
	throw new NotConfiguredError("tumonline (personal)", ["TUMONLINE_TOKEN, or run tumonline_request_token first"]);
}

/** Maps the <error><message> documents of TUMonline to clear errors. */
export function checkTumonlineError(root: XmlNode, fn: string): void {
	const err = child(root, "error");
	if (!err) return;
	const msg = textOf(err, "message") ?? err.text.trim();
	if (/nicht bestätigt/i.test(msg)) {
		throw new TokenNotConfirmedError(
			"TUMonline token is not activated yet. Activate it in TUMonline: Visitenkarte > Token-Management (or the link in the email), and grant all rights.",
		);
	}
	if (/Keine Rechte für Funktion|Funktion nicht erlaubt/i.test(msg)) {
		throw new NoRightsError(
			`The TUMonline token has no right for "${fn}" (${msg}). Grant the right in TUMonline: Visitenkarte > Token-Management > the token > rights.`,
		);
	}
	if (/Token ist ungültig|ungültiges Benutzertoken/i.test(msg)) {
		throw new LoginError(`TUMonline token is invalid (${msg}). Run tumonline_request_token again or fix TUMONLINE_TOKEN.`);
	}
	throw new Error(`TUMonline ${fn}: ${msg}`);
}

export async function call(env: Env, fn: string, params: Record<string, string | number> = {}, withToken = true): Promise<XmlNode> {
	const url = new URL(`${BASE}/wbservicesbasic.${fn}`);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
	if (withToken) url.searchParams.set("pToken", await token(env));
	const res = await withTimeout(fetch(url), TIMEOUT_MS, "TUMonline");
	if (res.status === 404) throw new Error(`TUMonline function wbservicesbasic.${fn} does not exist (HTTP 404). The web service may have moved.`);
	const root = parseXml(await res.text());
	checkTumonlineError(root, fn);
	return root;
}

export function rows(root: XmlNode): Record<string, unknown>[] {
	const rowset = child(root, "rowset");
	return childrenNamed(rowset, "row").map((r) => {
		const out: Record<string, unknown> = {};
		for (const c of r.children) {
			if (c.attrs.isnull === "true") continue;
			out[c.name] = c.children.length ? xmlToJson(c) : c.text.trim();
		}
		return out;
	});
}

/** Read-only token functions for tumonline_token_raw. No write function (terminCreate, terminDelete, secretUpload). */
export const RAW_FUNCTIONS = [
	"kalender",
	"noten",
	"pruefungenEigene",
	"veranstaltungenEigene",
	"veranstaltungenDetails",
	"veranstaltungenTermine",
	"absNoten",
	"id",
	"studienbeitragsstatus",
] as const;

/**
 * One read-only token call, returned unchanged as JSON of the XML (and the XML text). TUMonline errors are
 * returned as data, not mapped. The token never appears in the result.
 */
export async function rawCall(env: Env, fn: (typeof RAW_FUNCTIONS)[number], params: Record<string, string | number>) {
	if (!(RAW_FUNCTIONS as readonly string[]).includes(fn)) throw new Error(`${fn} is not in the read-only allowlist`);
	const tok = await token(env);
	const url = new URL(`${BASE}/wbservicesbasic.${fn}`);
	for (const [k, v] of Object.entries(params)) {
		if (/^ptoken$/i.test(k)) throw new Error("pToken is set by the server");
		url.searchParams.set(k, String(v));
	}
	url.searchParams.set("pToken", tok);
	const res = await withTimeout(fetch(url), TIMEOUT_MS, "TUMonline");
	const text = (await res.text()).split(tok).join("[token]");
	let data: unknown = null;
	try {
		data = xmlToJson(parseXml(text));
	} catch {
		// not XML (for example an HTML error page): the text is returned below
	}
	return { function: fn, params, http_status: res.status, content_type: res.headers.get("Content-Type") ?? undefined, data, xml: text.length > 200_000 ? `${text.slice(0, 200_000)} [truncated]` : text };
}

function monthsBetween(a: Date, b: Date): number {
	return Math.max(0, (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth() + 1);
}

export function registerTumonlinePersonalTools(server: McpServer, env: Env) {
	server.registerTool(
		"tumonline_token_raw",
		{
			description: `Raw data of one read-only TUMonline token web service function (wbservicesbasic), unchanged: the XML as JSON and as text, also TUMonline error documents. Allowlist: ${RAW_FUNCTIONS.join(", ")}. Typical parameters: kalender pMonateVor, pMonateNach; veranstaltungenDetails and veranstaltungenTermine pLVNr. The server adds the token; it never appears in the result.`,
			inputSchema: {
				function: z.enum(RAW_FUNCTIONS),
				params: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,40}$/), z.union([z.string().max(200), z.number()])).default({}),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ function: fn, params }) => run(async () => json(await rawCall(env, fn, params))),
	);


	const ro = { readOnlyHint: true, openWorldHint: true };

	server.registerTool(
		"tumonline_request_token",
		{
			description: `Request a new TUMonline web service token for TUM_USER and store it in the server (it is never shown). TUMonline sends an email. Afterwards the user must activate the token in TUMonline (Visitenkarte > Token-Management) and grant all rights. ${CONFIRM}`,
			inputSchema: { replace_existing: z.boolean().default(false).describe("Replace a token that is already stored") },
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
		},
		async ({ replace_existing }) =>
			run(async () => {
				const { TUM_USER } = requireSecrets(env, "tumonline (personal)", ["TUM_USER"]);
				if (!replace_existing && (await storeGet<{ token: string }>(env, STORE_KEY))) {
					throw new Error("A TUMonline token is already stored. Check it with tumonline_token_status, or call again with replace_existing=true.");
				}
				const root = await call(env, "requestToken", { pUsername: TUM_USER.trim(), pTokenName: "tum-mcp" }, false);
				const t = textOf(root, "token");
				if (!t || !/^[0-9A-Fa-f]{32}$/.test(t)) throw new Error("TUMonline returned no token");
				await storePut(env, STORE_KEY, { token: t, requested: new Date().toISOString() });
				return json({
					stored: true,
					secret_override_active: Boolean(env.TUMONLINE_TOKEN?.trim()),
					next_steps: [
						"Open TUMonline (campus.tum.de) > Visitenkarte > Token-Management, or use the activation link in the email from TUMonline.",
						'Activate the token named "tum-mcp".',
						"Grant all rights (calendar, courses, grades, fees, identity, persons).",
						"Then run tumonline_token_status.",
					],
				});
			}),
	);

	server.registerTool(
		"tumonline_token_status",
		{ description: "Check whether the TUMonline token exists and is activated.", inputSchema: {}, annotations: ro },
		async () =>
			run(async () => {
				const root = await call(env, "isTokenConfirmed");
				const confirmed = textOf(root, "confirmed") === "true";
				return json({ source: env.TUMONLINE_TOKEN?.trim() ? "secret TUMONLINE_TOKEN" : "stored by tumonline_request_token", confirmed });
			}),
	);

	server.registerTool(
		"tumonline_identity",
		{ description: "My TUMonline identity: name, TUM ID and obfuscated IDs.", inputSchema: {}, annotations: ro },
		async () => run(async () => json({ identity: rows(await call(env, "id"))[0] ?? null })),
	);

	server.registerTool(
		"tumonline_grades",
		{ description: "My exam results from TUMonline: course, date, grade, examiner, credits, semester.", inputSchema: {}, annotations: ro },
		async () =>
			run(async () => {
				const list = rows(await call(env, "noten")).map((r) => ({
					course: r.lv_titel,
					course_number: r.lv_nummer,
					semester: r.lv_semester,
					date: r.datum,
					grade: r.uninotenamekurz,
					examiner: r.pruefer_nachname,
					mode: r.modus,
					exam_type: r.exam_typ_name,
					credits: r.lv_credits,
					degree_program: r.studienbezeichnung,
				}));
				return json({ count: list.length, grades: list });
			}),
	);

	server.registerTool(
		"tumonline_calendar",
		{
			description: "My personal TUMonline calendar (courses, exams, own events) in a date range.",
			inputSchema: {
				from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD, default today"),
				to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD, default today + 14 days"),
			},
			annotations: ro,
		},
		async ({ from, to }) =>
			run(async () => {
				const now = new Date();
				const start = from ? new Date(`${from}T00:00:00Z`) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
				const end = to ? new Date(`${to}T23:59:59Z`) : new Date(start.getTime() + 15 * 86400_000 - 1000);
				if (end < start) throw new Error("'to' is before 'from'");
				const before = start < now ? monthsBetween(start, now) : 0;
				const after = end > now ? monthsBetween(now, end) : 0;
				const root = await call(env, "kalender", { pMonateVor: before, pMonateNach: after });
				const fromKey = start.toISOString().slice(0, 10);
				const toKey = end.toISOString().slice(0, 10);
				const events = childrenNamed(child(root, "events"), "event")
					.map((e) => ({
						title: textOf(e, "title"),
						start: textOf(e, "dtstart"),
						end: textOf(e, "dtend"),
						location: textOf(e, "location"),
						status: textOf(e, "status"),
						description: textOf(e, "description"),
						url: textOf(e, "url"),
					}))
					.filter((e) => {
						const d = (e.start ?? "").slice(0, 10);
						return d >= fromKey && d <= toKey;
					})
					.sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""));
				return json({ from: fromKey, to: toKey, timezone: "Europe/Berlin", count: events.length, events });
			}),
	);

	server.registerTool(
		"tumonline_my_courses",
		{ description: "My registered TUMonline courses (LV number, title, type, semester, lecturers).", inputSchema: {}, annotations: ro },
		async () =>
			run(async () => {
				const list = rows(await call(env, "veranstaltungenEigene")).map((r) => ({
					lv_number: r.stp_lv_nr,
					title: r.stp_sp_titel,
					type: r.stp_lv_art_name,
					sws: r.stp_sp_sst,
					semester: r.semester_name ?? r.semester,
					lecturers: r.vortragende_mitwirkende,
					organisation: r.org_name_betreut,
				}));
				return json({ count: list.length, courses: list });
			}),
	);

	server.registerTool(
		"tumonline_my_course_details",
		{
			description: "Details and dates of a TUMonline course by its LV number (stp_lv_nr from tumonline_my_courses), via the token web service.",
			inputSchema: { lv_number: z.string().regex(/^\d+$/), include_dates: z.boolean().default(true) },
			annotations: ro,
		},
		async ({ lv_number, include_dates }) =>
			run(async () => {
				const d = rows(await call(env, "veranstaltungenDetails", { pLVNr: lv_number }))[0];
				if (!d) throw new Error(`No course with LV number ${lv_number}`);
				const dates = include_dates
					? rows(await call(env, "veranstaltungenTermine", { pLVNr: lv_number })).map((r) => ({
							start: r.beginn_datum_zeitpunkt,
							end: r.ende_datum_zeitpunkt,
							type: r.art,
							room: r.ort ?? r.raum_nr,
							group: r.lv_grp_name,
							subject: r.termin_betreff,
						}))
					: undefined;
				return json({
					lv_number,
					title: d.stp_sp_titel,
					type: d.stp_lv_art_name,
					semester: d.semester_name,
					sws: d.stp_sp_sst,
					lecturers: d.vortragende_mitwirkende,
					organisation: d.org_name_betreut,
					language: d.haupt_unterrichtssprache,
					first_date: d.ersttermin,
					content: d.lehrinhalt,
					objectives: d.lehrziel,
					methods: d.lehrmethode,
					prerequisites: d.voraussetzung_lv,
					materials: d.studienbehelfe,
					dates,
				});
			}),
	);

	server.registerTool(
		"tumonline_person_search",
		{ description: "Search TUM staff and students in TUMonline by name. Returns IDs for tumonline_person_details.", inputSchema: { query: z.string().min(3) }, annotations: ro },
		async ({ query }) =>
			run(async () => {
				const list = rows(await call(env, "personenSuche", { pSuche: query })).map((r) => ({
					id: r.obfuscated_id ?? r.nr,
					title: r.titel,
					first_name: r.vorname,
					last_name: r.familienname,
					gender: r.geschlecht,
				}));
				return json({ count: list.length, persons: list });
			}),
	);

	server.registerTool(
		"tumonline_person_details",
		{
			description: "Contact details of a TUM person: email, phone, rooms, office hours, groups.",
			inputSchema: { person_id: z.string().min(1).describe("ID from tumonline_person_search") },
			annotations: ro,
		},
		async ({ person_id }) =>
			run(async () => {
				const root = await call(env, "personenDetails", { pIdentNr: person_id });
				const p = child(root, "person");
				if (!p) throw new Error("Person not found");
				p.children = p.children.filter((c) => c.name !== "image_data");
				return json({ person: xmlToJson(p) });
			}),
	);

	server.registerTool(
		"tumonline_fee_status",
		{ description: "My tuition fee status (Studienbeitrag): semester, open amount and deadline.", inputSchema: {}, annotations: ro },
		async () =>
			run(async () => {
				const list = rows(await call(env, "studienbeitragsstatus")).map((r) => ({
					semester: r.semester_bezeichnung,
					open_amount_eur: r.soll,
					deadline: r.frist,
				}));
				return json({ fees: list });
			}),
	);
}

export async function tumonlinePersonalStatus(env: Env): Promise<PlatformStatus> {
	const platform = "tumonline (personal)";
	try {
		const root = await call(env, "isTokenConfirmed");
		if (textOf(root, "confirmed") !== "true") {
			return { platform, state: "token not activated", detail: "Activate the token in TUMonline: Visitenkarte > Token-Management, and grant all rights." };
		}
		try {
			const me = rows(await call(env, "id"))[0];
			return { platform, state: "OK", detail: `token active for ${me?.vorname ?? ""} ${me?.familienname ?? ""}`.trim() };
		} catch (e) {
			if (e instanceof NoRightsError) return { platform, state: "OK", detail: `token active, but: ${e.message}` };
			throw e;
		}
	} catch (e) {
		const detail = e instanceof Error ? e.message : String(e);
		if (e instanceof NotConfiguredError) return { platform, state: "not configured", detail };
		if (e instanceof TokenNotConfirmedError) return { platform, state: "token not activated", detail };
		if (e instanceof LoginError) return { platform, state: "login error", detail };
		return { platform, state: "error", detail };
	}
}
