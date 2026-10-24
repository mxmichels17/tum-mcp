import { describe, expect, it } from "vitest";
import { fakeEnv } from "./fake-store";
import { changedLines, computeChanges, flatten, type Item, type ScopeResult } from "../src/collector/model";
import { applyScope, type Budget, deltaOut, deltaRows, dropStaleCourseState, ensureSchema, forgetCourses, setState } from "../src/collector/store";
import { decodeChunk, leafName, parseBodyStructure } from "../src/collector/units/mail-large";
import { folderFiles, moduleChunks, rawIcsEvents, sessionFileUrl } from "../src/collector/units/moodle";
import { imapSince, MAIL_SINCE_UNIX, semesterOf, startsInSemester } from "../src/collector/scope";
import { courseIdsInEvent, examPicker } from "../src/collector/units/tumonline";
import { parseResponse } from "../src/lib/imap-parse";
import { utf8 } from "../src/lib/bytes";
import { dateStrings, pageLinks, stripSessionParams, webContent } from "../src/collector/web";

function budget(max = 100): Budget {
	let n = 0;
	return { canLoad: () => n < max, loaded: () => void n++, used: () => 0 };
}

const it_ = (key: string, text: string, extra: Partial<Item> = {}): Item => ({ key, source: "test", title: key, url: `https://x/${key}`, content: { text }, ...extra });

async function ready() {
	const f = fakeEnv();
	await ensureSchema(f.env.DB);
	return f;
}

// ---------- tests ----------

describe("change computation", () => {
	it("lists every changed field with old and new value", () => {
		const a = { title: "A", url: "u", content: { due: "2026-11-01", files: [{ name: "a.pdf" }], same: 1 } };
		const b = { title: "A", url: "u", content: { due: "2026-11-08", files: [{ name: "a.pdf" }, { name: "b.pdf" }], same: 1 } };
		expect(computeChanges(a, b)).toEqual([
			{ field: "content.due", old: "2026-11-01", new: "2026-11-08" },
			{ field: "content.files[1].name", old: null, new: "b.pdf" },
		]);
	});

	it("shows only the changed lines of long texts", () => {
		const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
		const changed = [...lines];
		changed[30] = "line 30 NEW";
		const d = computeChanges({ title: "t", url: "u", content: { text: lines.join("\n") } }, { title: "t", url: "u", content: { text: changed.join("\n") } });
		expect(d).toEqual([{ field: "content.text", old: "line 30", new: "line 30 NEW", old_lines: "31-31", new_lines: "31-31" }]);
		expect(changedLines("a\nb", "a\nb\nc")).toMatchObject({ old: "", new: "c", new_lines: "3-3" });
	});

	it("flattens nested JSON to paths", () => {
		expect([...flatten({ a: { b: [1, { c: 2 }] }, e: [] }).entries()]).toEqual([
			["a.b[0]", 1],
			["a.b[1].c", 2],
			["e", []],
		]);
	});
});

describe("web pages", () => {
	const html = `<html><head><title>Blatt 3</title></head><body><div role="main"><h2>Blatt 3</h2>
		<p>Abgabe bis 12. November 2026, 23:59 Uhr. Ausgabe am 05.11.2026.</p>
		<a href="/pluginfile.php/1/x.pdf">Blatt</a> <a href="https://example.org/?sesskey=abc&id=1">Link</a>
		<time datetime="2026-11-12T23:59:00+01:00">12.11.</time><div>Verbleibende Zeit 6 Tage 3 Stunden</div></div>
		<footer>Impressum</footer></body></html>`;

	it("keeps the full text, all links and the date strings as written", () => {
		const c = webContent(html, "https://www.moodle.tum.de/mod/assign/view.php?id=5");
		expect(c.page_title).toBe("Blatt 3");
		expect(c.text).toContain("Abgabe bis 12. November 2026, 23:59 Uhr");
		expect(c.text).not.toContain("Impressum");
		expect(c.links).toEqual([
			{ text: "Blatt", href: "https://www.moodle.tum.de/pluginfile.php/1/x.pdf" },
			{ text: "Link", href: "https://example.org/?sesskey=abc&id=1" },
		]);
		expect(c.dates).toEqual(["12. November 2026, 23:59 Uhr", "05.11.2026", "12.11."]);
		expect(c.time_elements).toEqual([{ datetime: "2026-11-12T23:59:00+01:00", text: "12.11." }]);
	});

	it("blanks the session key and the countdown, which change on every read", () => {
		const c = stripSessionParams(webContent(html, "https://www.moodle.tum.de/x"));
		expect((c.links as { href: string }[])[1].href).toBe("https://example.org/?id=1");
		expect(c.text).toContain("Verbleibende Zeit [counted from the time of reading, removed]");
		expect(c.text).not.toContain("6 Tage");
	});

	it("finds dates in English and ISO forms", () => {
		expect(dateStrings("Due November 12, 2026 at 11:59 pm, opens 2026-11-01T10:00:00Z, 3 Dec 2026")).toEqual(["November 12, 2026 at 11:59 pm", "2026-11-01T10:00:00Z", "3 Dec 2026"]);
		expect(pageLinks('<a href="#top">x</a><a href="javascript:void(0)">y</a>', "https://a/")).toEqual([]);
	});
});

describe("source parsers", () => {
	it("reads iCal events raw", () => {
		const ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:42@moodle\r\nSUMMARY:Blatt 3 ist fällig\r\nDTSTART;TZID=Europe/Berlin:20261112T235900\r\nDESCRIPTION:Zeile 1\\nZeile\r\n  2\r\nEND:VEVENT\r\nEND:VCALENDAR";
		expect(rawIcsEvents(ics)).toEqual([{ UID: "42@moodle", SUMMARY: "Blatt 3 ist fällig", DTSTART: { value: "20261112T235900", params: ["TZID=Europe/Berlin"] }, DESCRIPTION: "Zeile 1\nZeile 2" }]);
	});

	it("reads folder files with their revision and course page chunks", () => {
		const page = '<a href="https://www.moodle.tum.de/pluginfile.php/77/mod_folder/content/4/Sub/Blatt%201.pdf?forcedownload=1">Blatt 1</a>';
		expect(folderFiles(page)).toEqual([{ path: "Sub/Blatt 1.pdf", revision: "4", url: "https://www.moodle.tum.de/pluginfile.php/77/mod_folder/content/4/Sub/Blatt%201.pdf" }]);
		const course = '<li id="section-0"><ul><li class="activity" id="module-11">Label text</li><li id="module-12">Next</li></ul></li><li id="section-1">S1</li>';
		const chunks = moduleChunks(course);
		expect([...chunks.keys()]).toEqual([11, 12]);
		expect(chunks.get(12)).not.toContain("S1");
		expect(chunks.get(11)).toBe('<li class="activity" id="module-11">Label text</li><li id="module-12">Next</li></ul></li>'.split("<li id=\"module-12\">")[0]);
		expect(sessionFileUrl("https://www.moodle.tum.de/webservice/pluginfile.php/5/mod_resource/content/2/a.pdf?forcedownload=1&token=x")).toBe("https://www.moodle.tum.de/pluginfile.php/5/mod_resource/content/2/a.pdf");
	});

	it("finds course numbers in TUMonline calendar events", () => {
		expect(courseIdsInEvent({ url: "https://campus.tum.de/tumonline/wbLv.wbShowLVDetail?pS_LV_ID=950812345", description: "LV 950700001" }).sort()).toEqual(["950700001", "950812345"]);
	});
});

describe("store", () => {
	it("creates the tables and never drops or deletes anything", async () => {
		const f = fakeEnv();
		f.sql.exec("CREATE TABLE deadlines (key TEXT); INSERT INTO deadlines VALUES ('a')");
		await f.env.FILES.put("files/old.pdf", "x");
		await ensureSchema(f.env.DB);
		await ensureSchema(f.env.DB);
		const tables = f.sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => (r as { name: string }).name);
		expect(tables).toEqual(["deadlines", "deltas", "items", "sqlite_sequence", "state", "unit_runs"]);
		expect(f.sql.prepare("SELECT COUNT(*) AS n FROM deadlines").get()).toEqual({ n: 1 });
		expect([...f.objects.keys()]).toEqual(["files/old.pdf"]);
	});

	it("does not report an item as new when it moves to another listing", async () => {
		const { env } = await ready();
		await applyScope(env, budget(), { scope: "a", complete: false, entries: [{ key: "d1", item: it_("d1", "x") }] });
		const r = await applyScope(env, budget(), { scope: "b", complete: true, entries: [{ key: "d1", load: async () => it_("d1", "x") }] });
		expect(r).toMatchObject({ new: 0, changed: 0, removed: 0 });
		const r2 = await applyScope(env, budget(), { scope: "b", complete: true, entries: [{ key: "d1", item: it_("d1", "y") }] });
		expect(r2).toMatchObject({ new: 0, changed: 1 });
	});

	it("reports new, changed and removed items with content, and nothing when unchanged", async () => {
		const { env } = await ready();
		const scope = (items: Item[], extra: Partial<ScopeResult> = {}): ScopeResult => ({ scope: "s", complete: true, entries: items.map((i) => ({ key: i.key, item: i })), ...extra });
		let r = await applyScope(env, budget(), scope([it_("a", "one"), it_("b", "two")]));
		expect(r).toMatchObject({ new: 2, changed: 0, removed: 0 });
		r = await applyScope(env, budget(), scope([it_("a", "one"), it_("b", "two")]));
		expect(r).toMatchObject({ new: 0, changed: 0, removed: 0, written: 0 });
		r = await applyScope(env, budget(), scope([it_("a", "ONE")]));
		expect(r).toMatchObject({ new: 0, changed: 1, removed: 1 });
		const rows = await deltaRows(env.DB, 0, 10);
		const out = await Promise.all(rows.map((d) => deltaOut(env, d)));
		expect(out.map((d) => [d.type, d.key])).toEqual([
			["new", "a"],
			["new", "b"],
			["changed", "a"],
			["removed", "b"],
		]);
		expect(out[2]).toMatchObject({ content: { text: "ONE" }, changes: [{ field: "content.text", old: "one", new: "ONE" }], url: "https://x/a" });
		expect(out[3]).toMatchObject({ content: { text: "two" } });
		// A removed item that comes back is new again.
		r = await applyScope(env, budget(), scope([it_("a", "ONE"), it_("b", "two")]));
		expect(r).toMatchObject({ new: 1, changed: 0, removed: 0 });
	});

	it("does not remove items outside the read window", async () => {
		const { env } = await ready();
		const e = (k: string, w: string) => ({ key: k, window: w, item: it_(k, k) });
		await applyScope(env, budget(), { scope: "cal", complete: true, entries: [e("old", "2026-09-01"), e("new", "2026-11-01")] });
		const r = await applyScope(env, budget(), { scope: "cal", complete: true, windowFrom: "2026-10-01", entries: [] });
		expect(r.removed).toBe(1);
		expect((await deltaRows(env.DB, 2, 10)).map((d) => d.item_key)).toEqual(["new"]);
	});

	it("loads within the budget, keeps the rest pending and skips entries with an unchanged sig", async () => {
		const { env } = await ready();
		let loads = 0;
		const entries = ["x", "y", "z"].map((k) => ({ key: k, sig: "1", load: async () => (loads++, it_(k, k)) }));
		let r = await applyScope(env, budget(1), { scope: "l", complete: true, entries });
		expect(r).toMatchObject({ loaded: 1, pending: 2, new: 1, removed: 0 });
		r = await applyScope(env, budget(10), { scope: "l", complete: true, entries });
		expect(r).toMatchObject({ loaded: 2, pending: 0, new: 2, unchanged: 1 });
		r = await applyScope(env, budget(10), { scope: "l", complete: true, entries });
		expect(r).toMatchObject({ loaded: 0, new: 0, unchanged: 3 });
		expect(loads).toBe(3);
	});

	it("keeps contents over 400 kB in R2 and returns them whole", async () => {
		const { env, objects } = await ready();
		const big = "x".repeat(500_000);
		await applyScope(env, budget(), { scope: "big", complete: true, entries: [{ key: "p", item: it_("p", big) }] });
		expect([...objects.keys()].some((k) => k.startsWith("content/"))).toBe(true);
		const [d] = await deltaRows(env.DB, 0, 1);
		expect(((await deltaOut(env, d)).content as { text: string }).text.length).toBe(500_000);
	});
});

describe("large mails", () => {
	it("reads the leaf parts of a BODYSTRUCTURE with section numbers, names and sizes", () => {
		const bs = parseResponse(
			utf8('(("text" "plain" ("charset" "utf-8") NIL NIL "quoted-printable" 120 4 NIL NIL NIL NIL)("text" "html" ("charset" "utf-8") NIL NIL "base64" 300 5 NIL NIL NIL NIL) "alternative" ("boundary" "a") NIL NIL NIL)'),
		)[0];
		const mixed = parseResponse(utf8('(' + '("text" "plain" ("charset" "utf-8") NIL NIL "7bit" 10 1 NIL NIL NIL NIL)' + '("application" "pdf" ("name" "Skript.pdf") NIL NIL "base64" 40000000 NIL ("attachment" ("filename" "Skript WS.pdf")) NIL NIL)' + ' "mixed" ("boundary" "b") NIL NIL NIL)'))[0];
		expect(parseBodyStructure(bs).map((l) => [l.section, `${l.type}/${l.subtype}`, l.encoding, l.size])).toEqual([
			["1", "text/plain", "quoted-printable", 120],
			["2", "text/html", "base64", 300],
		]);
		const leaves = parseBodyStructure(mixed);
		expect(leaves[1]).toMatchObject({ section: "2", disposition: "attachment", size: 40000000 });
		expect(leafName(leaves[1])).toBe("Skript WS.pdf");
		// A nested multipart gets dotted section numbers.
		const nested = parseResponse(utf8(`(${'(("text" "plain" NIL NIL NIL "7bit" 1 1 NIL NIL NIL NIL)("text" "html" NIL NIL NIL "7bit" 1 1 NIL NIL NIL NIL) "alternative" NIL NIL NIL NIL)'}("image" "png" ("name" "a.png") NIL NIL "base64" 8 NIL NIL NIL NIL) "mixed" NIL NIL NIL NIL)`))[0];
		expect(parseBodyStructure(nested).map((l) => l.section)).toEqual(["1.1", "1.2", "2"]);
	});

	it("decodes base64 and quoted-printable chunk by chunk with the same result as in one piece", () => {
		const data = new Uint8Array(5000).map((_, i) => (i * 7) % 256);
		let b64 = "";
		for (let i = 0; i < data.length; i += 0x8000) b64 += String.fromCharCode(...data.subarray(i, i + 0x8000));
		const encoded = btoa(b64).replace(/.{76}/g, "$&\r\n");
		const bytes = utf8(encoded);
		const parts: Uint8Array[] = [];
		let carry = "";
		for (let off = 0; off < bytes.length; off += 997) {
			const chunk = bytes.subarray(off, off + 997);
			const r = decodeChunk("base64", chunk, carry, off + 997 >= bytes.length);
			parts.push(r.bytes);
			carry = r.carry;
		}
		const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
		let o = 0;
		for (const p of parts) {
			out.set(p, o);
			o += p.length;
		}
		expect([...out]).toEqual([...data]);
		const qp = utf8("Gr=C3=BC=C3=9Fe aus M=C3=BCnchen, eine lange Zeile=\r\nweiter");
		let qcarry = "";
		const q: number[] = [];
		for (let off = 0; off < qp.length; off += 5) {
			const r = decodeChunk("quoted-printable", qp.subarray(off, off + 5), qcarry, off + 5 >= qp.length);
			q.push(...r.bytes);
			qcarry = r.carry;
		}
		expect(new TextDecoder().decode(new Uint8Array(q))).toBe("Grüße aus München, eine lange Zeileweiter");
	});
});

describe("public exam list filter", () => {
	const pick = examPicker({ ids: ["950812345"], numbers: ["in0004"], names: ["Grundlagen: Datenbanken", "Fundamentals of Databases"] });
	const entry = (courseId: string, number: string, names: string[]) => ({ courseId, number, names: () => names });

	it("matches by course id, course number or course name in German or English, exactly", () => {
		expect(pick(entry("950812345", "X", []))).toBe(true);
		expect(pick(entry("1", "IN0004", []))).toBe(true);
		expect(pick(entry("1", "IN0008", ["Grundlagen:  Datenbanken"]))).toBe(true);
		expect(pick(entry("1", "IN0008", ["Einführung", "fundamentals of databases"]))).toBe(true);
		// No partial or similar names.
		expect(pick(entry("1", "IN0008", ["Grundlagen: Datenbanken (Wiederholung)"]))).toBe(false);
		expect(pick(entry("2", "IN0009", ["Datenbanken"]))).toBe(false);
	});
});

describe("collection scope", () => {
	it("knows the TUM semester and which course starts belong to it", () => {
		expect(semesterOf(new Date("2026-10-20T12:00:00Z"))).toEqual({ code: "WS26/27", start: "2026-10-01", end: "2027-03-31" });
		expect(semesterOf(new Date("2027-02-01T12:00:00Z")).code).toBe("WS26/27");
		expect(semesterOf(new Date("2027-05-01T12:00:00Z"))).toEqual({ code: "SS27", start: "2027-04-01", end: "2027-09-30" });
		const ws = semesterOf(new Date("2026-10-20T12:00:00Z"));
		expect(startsInSemester("2026-10-12T00:00:00Z", ws)).toBe(true);
		expect(startsInSemester("2026-09-01T00:00:00Z", ws)).toBe(true);
		expect(startsInSemester(Date.parse("2026-04-13T00:00:00Z") / 1000, ws)).toBe(false);
		expect(startsInSemester(0, ws)).toBe(false);
		expect(imapSince()).toBe("15-Sep-2026");
		expect(new Date(MAIL_SINCE_UNIX * 1000).toISOString()).toBe("2026-09-14T22:00:00.000Z");
	});

	it("forgets out-of-scope items and their deltas, without a removed delta", async () => {
		const { env } = await ready();
		const old = { key: "mail:INBOX:1:1", item: { ...it_("mail:INBOX:1:1", "old"), content: { date: "2026-08-01T10:00:00Z", text: "old" } } };
		const gone = { key: "mail:INBOX:1:2", item: { ...it_("mail:INBOX:1:2", "gone"), content: { date: "2026-08-02T10:00:00Z", text: "gone" } } };
		const recent = { key: "mail:INBOX:1:3", item: { ...it_("mail:INBOX:1:3", "new"), content: { date: "2026-10-01T10:00:00Z", text: "new" } } };
		await applyScope(env, budget(), { scope: "mail:INBOX", complete: true, entries: [old, gone, recent] });
		expect((await deltaRows(env.DB, 0, 10)).length).toBe(3);
		const outside = (c: Record<string, unknown>) => typeof c.date === "string" && c.date < "2026-09-15";
		// "old" is still on the server but before the limit; "gone" was deleted on the server and was before the limit.
		const r = await applyScope(env, budget(), { scope: "mail:INBOX", complete: true, entries: [recent], outOfScope: ["mail:INBOX:1:1"], outOfScopeContent: outside });
		expect(r).toMatchObject({ new: 0, changed: 0, removed: 0 });
		const rows = await deltaRows(env.DB, 0, 10);
		expect(rows.map((d) => d.item_key)).toEqual(["mail:INBOX:1:3"]);
		// A mail after the limit that is deleted is still reported as removed.
		const r2 = await applyScope(env, budget(), { scope: "mail:INBOX", complete: true, entries: [], outOfScopeContent: outside });
		expect(r2.removed).toBe(1);
	});

	it("forgets everything stored for courses outside the semester", async () => {
		const { env, sql } = await ready();
		await applyScope(env, budget(), { scope: "moodle:courses", complete: true, entries: [{ key: "moodle:course:1", item: it_("moodle:course:1", "c1") }, { key: "moodle:course:2", item: it_("moodle:course:2", "c2") }] });
		await applyScope(env, budget(), { scope: "moodle:course:1", complete: true, entries: [{ key: "moodle:cm:10", item: { ...it_("moodle:cm:10", "x"), source: "moodle", content: { course_id: 1 } } }] });
		await applyScope(env, budget(), { scope: "moodle:forum:10", complete: true, entries: [{ key: "moodle:discussion:5", item: { ...it_("moodle:discussion:5", "x"), source: "moodle", content: { course_id: 1 } } }] });
		await applyScope(env, budget(), { scope: "moodle:course:2", complete: true, entries: [{ key: "moodle:cm:20", item: { ...it_("moodle:cm:20", "y"), source: "moodle", content: { course_id: 2 } } }] });
		expect(await forgetCourses(env, "moodle", [1], (id) => [`moodle:course:${id}`])).toBe(2);
		const r = await applyScope(env, budget(), { scope: "moodle:courses", complete: true, outOfScope: ["moodle:course:1"], entries: [{ key: "moodle:course:2", item: it_("moodle:course:2", "c2") }] });
		expect(r.removed).toBe(0);
		expect(sql.prepare("SELECT key FROM items ORDER BY key").all()).toEqual([{ key: "moodle:cm:20" }, { key: "moodle:course:2" }]);
		expect((await deltaRows(env.DB, 0, 20)).map((d) => d.item_key).sort()).toEqual(["moodle:cm:20", "moodle:course:2"]);
	});

	it("removes pending markers and unit rows of courses outside the scope, and keeps those inside", async () => {
		const { env, sql } = await ready();
		await setState(env.DB, "moodle:sub:1", { folders: { "11": {} }, forums: { "12": {} } });
		await setState(env.DB, "moodle:sub:2", { folders: {}, forums: { "22": {} } });
		for (const k of ["pending:moodle:course:1", "pending:moodle:course:2", "pending:moodle:actions:2", "pending:moodle:folder:11", "pending:moodle:forum:12", "pending:moodle:forum:22", "pending:moodle:forum:99", "pending:mail:INBOX"]) {
			await setState(env.DB, k, 3);
		}
		sql.exec("INSERT INTO unit_runs (unit, state, last_run) VALUES ('moodle-course:1', 'OK', 'x'), ('moodle-course:2', 'OK', 'x'), ('mail', 'OK', 'x')");
		const n = await dropStaleCourseState(env, { keep: [1], listingPrefixes: ["moodle:course:", "moodle:actions:"], unitPrefix: "moodle-course:", subPrefix: "moodle:sub:", subListingPrefixes: ["moodle:folder:", "moodle:forum:"] });
		expect(n).toBe(6);
		expect(sql.prepare("SELECT key FROM state ORDER BY key").all().map((r) => (r as { key: string }).key)).toEqual([
			"moodle:sub:1",
			"pending:mail:INBOX",
			"pending:moodle:course:1",
			"pending:moodle:folder:11",
			"pending:moodle:forum:12",
		]);
		expect(sql.prepare("SELECT unit FROM unit_runs ORDER BY unit").all()).toEqual([{ unit: "mail" }, { unit: "moodle-course:1" }]);
	});
});

describe("collector_ack", () => {
	it("moves the delivered pointer only forward and only to an existing delta", async () => {
		const { ackDeltas } = await import("../src/collector/tools");
		const { env } = await ready();
		await applyScope(env, budget(), { scope: "s", complete: true, entries: ["a", "b", "c"].map((k) => ({ key: k, item: it_(k, k) })) });
		const ids = (await deltaRows(env.DB, 0, 10)).map((d) => d.id);
		expect(await ackDeltas(env.DB, ids[1])).toEqual({ old_pointer: 0, new_pointer: ids[1], moved: true });
		expect(await ackDeltas(env.DB, ids[1])).toEqual({ old_pointer: ids[1], new_pointer: ids[1], moved: false });
		await expect(ackDeltas(env.DB, ids[0])).rejects.toThrow(/backwards/);
		await expect(ackDeltas(env.DB, ids[2] + 50)).rejects.toThrow(/No delta/);
		expect(await ackDeltas(env.DB, ids[2])).toMatchObject({ old_pointer: ids[1], new_pointer: ids[2] });
	});
});

