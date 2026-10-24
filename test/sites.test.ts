import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { handleDownload, signedDownloadUrl } from "../src/collector/download";
import { storeResponse, streamToR2 } from "../src/collector/files";
import type { ScopeResult } from "../src/collector/model";
import { applyScope, type Budget, ensureSchema } from "../src/collector/store";
import type { UnitCtx } from "../src/collector/unit";
import { followedLinks, forgetRemovedSites, type SiteConfig, SITES, TOKEN_MASK, unitSite, withoutComments } from "../src/collector/units/sites";
import { cryptoJsDecrypt, evpBytesToKey, md5 } from "../src/lib/cryptojs-aes";
import { fakeEnv } from "./fake-store";

const TOKEN = "test-token-123";

const enc = new TextEncoder();
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/** CryptoJS.AES.encrypt(text, pass): OpenSSL "Salted__", EVP_BytesToKey (MD5), AES-256-CBC. */
async function encrypt(text: string, pass: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(8));
	const { key, iv } = evpBytesToKey(enc.encode(pass), salt);
	const k = await crypto.subtle.importKey("raw", key, "AES-CBC", false, ["encrypt"]);
	const body = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, k, enc.encode(text)));
	const out = new Uint8Array([...enc.encode("Salted__"), ...salt, ...body]);
	return btoa(String.fromCharCode(...out));
}

function ctxFor(env: Env, max = 15): UnitCtx {
	let loads = 0;
	const budget: Budget = { canLoad: () => loads < max, loaded: () => void loads++, used: () => 0 };
	return { env, budget, note: () => {}, writesLeft: () => 1e9, apply: (r: ScopeResult) => applyScope(env, budget, r) };
}

type Page = { type: string; body: string; headers?: Record<string, string> };
let web: Record<string, Page> = {};
const requests: string[] = [];

function stubFetch() {
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		const method = init?.method ?? "GET";
		requests.push(`${method} ${url}`);
		const p = web[url];
		if (!p) return new Response("<html><body>Not found</body></html>", { status: 404, headers: { "Content-Type": "text/html" } });
		const headers = { "Content-Type": p.type, "Content-Length": String(new TextEncoder().encode(p.body).byteLength), ...p.headers };
		return new Response(method === "HEAD" ? null : p.body, { status: 200, headers });
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
	requests.length = 0;
});

describe("CryptoJS AES (locked-course.example unlock)", () => {
	it("computes MD5 (RFC 1321 test suite)", () => {
		const vectors: [string, string][] = [
			["", "d41d8cd98f00b204e9800998ecf8427e"],
			["a", "0cc175b9c0f1b6a831c399e269772661"],
			["abc", "900150983cd24fb0d6963f7d28e17f72"],
			["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
			["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
			["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", "d174ab98d277d9f5a5611c2c9f419d9f"],
			["12345678901234567890123456789012345678901234567890123456789012345678901234567890", "57edf4a22be3c955ac49da2e2107b67a"],
			["a".repeat(1_000_000), "7707d6ae4e027c70eea2a935c2296f21"],
		];
		for (const [text, md] of vectors) expect(hex(md5(enc.encode(text))), text.slice(0, 20)).toBe(md);
	});

	it("decrypts values made by openssl and by CryptoJS, and refuses a wrong passphrase", async () => {
		// echo -n magic | openssl enc -aes-256-cbc -md md5 -salt -pass pass:test-token-123 -base64 -A
		expect(await cryptoJsDecrypt("U2FsdGVkX18XhxLSt/puhxblNv9LLiZZOtTm8/B1/YU=", TOKEN)).toBe("magic");
		expect(await cryptoJsDecrypt("U2FsdGVkX18UJggOTi70J9dHSPrK18bfUpiiAnnmTuyXD64H38KJjtszIf0tIaim", TOKEN)).toBe("https://example.org/x?y=1");
		expect(await cryptoJsDecrypt(await encrypt("Grüße aus München", TOKEN), TOKEN)).toBe("Grüße aus München");
		expect(await cryptoJsDecrypt("U2FsdGVkX18XhxLSt/puhxblNv9LLiZZOtTm8/B1/YU=", "wrong")).toBeUndefined();
		expect(await cryptoJsDecrypt("bm90IHNhbHRlZA==", TOKEN)).toBeUndefined();
	});
});

describe("signed download links", () => {
	const env = () => ({ ...fakeEnv().env, COOKIE_ENCRYPTION_KEY: "k".repeat(40), PUBLIC_ORIGIN: "https://worker.example/" }) as unknown as Env;

	it("streams the file for a valid link and refuses changed, expired and foreign links", async () => {
		const e = env();
		await e.FILES.put("files/abc", "PDFDATA", { httpMetadata: { contentType: "application/pdf" }, customMetadata: { name: "Lecture Notes.pdf" } });
		const now = Date.parse("2026-10-22T12:00:00Z");
		const link = await signedDownloadUrl(e, "files/abc", now);
		expect(link.url.startsWith("https://worker.example/files/download?k=files%2Fabc&e=")).toBe(true);
		expect(link.expires).toBe("2026-10-22T13:00:00.000Z");
		const ok = await handleDownload(new Request(link.url), e, now + 60_000);
		expect(ok.status).toBe(200);
		expect(await ok.text()).toBe("PDFDATA");
		expect(ok.headers.get("Content-Type")).toBe("application/pdf");
		expect(ok.headers.get("Content-Disposition")).toContain("Lecture%20Notes.pdf");
		expect((await handleDownload(new Request(link.url), e, now + 3601_000)).status).toBe(410);
		const other = new URL(link.url);
		other.searchParams.set("k", "files/other");
		expect((await handleDownload(new Request(other), e, now)).status).toBe(403);
		other.searchParams.set("k", "secrets/x");
		expect((await handleDownload(new Request(other), e, now)).status).toBe(400);
		expect((await handleDownload(new Request(link.url, { method: "POST" }), e, now)).status).toBe(405);
	});
});

describe("large files", () => {
	/** A body of `size` bytes in chunks of odd sizes, made while it is read. */
	const bodyOf = (size: number, chunk = 3_000_001) => {
		let sent = 0;
		return new ReadableStream<Uint8Array>({
			pull(c) {
				if (sent >= size) return c.close();
				const n = Math.min(chunk, size - sent);
				const b = new Uint8Array(n);
				b[0] = sent % 251;
				sent += n;
				c.enqueue(b);
			},
		});
	};

	it("streams a file into R2 in equal parts and keeps the bytes", async () => {
		const { env, objects, uploads } = fakeEnv();
		const size = 20 * 1024 * 1024 + 3;
		const n = await streamToR2(env, "files/big", bodyOf(size), { httpMetadata: { contentType: "application/pdf" } });
		expect(n).toBe(size);
		expect(uploads[0].parts).toEqual([8 * 1024 * 1024, 8 * 1024 * 1024, 4 * 1024 * 1024 + 3]);
		expect(objects.get("files/big")?.bytes.byteLength).toBe(size);
		expect(objects.get("files/big")?.bytes[3_000_001]).toBe(3_000_001 % 251);
	});

	it("stores a 56 MB file of unknown size, and keeps only the link above 100 MB", async () => {
		const { env, objects, uploads } = fakeEnv();
		const open = (size: number) => async () => new Response(bodyOf(size, 4 * 1024 * 1024), { headers: { "Content-Type": "application/pdf" } });
		const f = await storeResponse(env, { name: "Large Lecture Slides.pdf", url: "https://m/1", open: open(56_539_312), stableKey: "moodle:rev:1" });
		expect(f.size).toBe(56_539_312);
		expect(f.r2_key).toMatch(/^files\//);
		expect(objects.get(f.r2_key as string)?.bytes.byteLength).toBe(56_539_312);
		const big = await storeResponse(env, { name: "huge.zip", url: "https://m/2", open: open(101 * 1024 * 1024) });
		expect(big.r2_key).toBeNull();
		expect(big.not_stored).toContain("100 MB");
		expect(uploads[1].aborted).toBe(true);
	});
});

describe("external course websites", () => {
	// Test sites in the shape of config/external-sites.json.
	const locked: SiteConfig = {
		id: "locked",
		name: "Course site with encrypted links",
		moodle_course: 1001,
		start: ["https://locked-course.example/"],
		follow: ["https://locked-course.example/pdf/"],
		unlock: { token_in_items_like: "locked-course.example/#" },
	};
	const db: SiteConfig = {
		id: "db",
		name: "Database course",
		moodle_course: 1002,
		start: ["https://db.example.org/teaching/course/"],
		follow: ["https://db.example.org/teaching/course/", "https://db.example.org/teaching/book/slides/", "https://db.example.org/teaching/book/recordings/index.shtml"],
	};
	beforeAll(() => {
		SITES.push(locked, db);
	});

	it("follows only links under the configured prefixes, without assets, videos and fragments", () => {
		expect(
			followedLinks(db, [
				"https://db.example.org/teaching/course/schema.pdf",
				"https://db.example.org/teaching/course/index.shtml?lang=en#top",
				"https://db.example.org/teaching/book/slides/kapitel1.pdf",
				"https://db.example.org/teaching/book/recordings/lecture_01.mp4",
				"https://db.example.org/downloads/videos/1.mp4",
				"https://db.example.org/layout/style.css",
				"https://db.example.org/~lecturer",
				"https://www.moodle.tum.de/course/view.php?id=1002",
			]),
		).toEqual([
			"https://db.example.org/teaching/course/schema.pdf",
			"https://db.example.org/teaching/course/index.shtml?lang=en",
			"https://db.example.org/teaching/book/slides/kapitel1.pdf",
		]);
		expect(withoutComments("a<!-- <a href='x'>later</a> -->b")).toBe("ab");
	});

	const lockedPage = async () => `<html><head><title>Course</title></head><body><table>
		<tr class="row0"><th>Day</th><th>Date</th><th>Time</th><th>Name</th><th>Event</th><th>Material</th></tr>
		<tr class="row1"><td class="day">Thu</td><td class="date">2026-10-22</td><td class="time">14:15-17:00</td><td class="name">Module 01</td>
			<td class="event"><a href="" v-on:click.stop.prevent="openSession('Module 01', '${await encrypt("https://youtu.be/abc", TOKEN)}', '${await encrypt(`https://pad.example/#${TOKEN}?!ui`, TOKEN)}')">LECTURE</a></td>
			<td class="material"><a href="pdf/Module-01-Agenda.pdf">AGENDA</a></td></tr>
		<!-- <tr class="row2"><td>Fri</td><td>2026-10-23</td><td>14:00</td><td>Module 02</td><td></td><td><a href="pdf/Module-02-Agenda.pdf">AGENDA</a></td></tr> -->
		<tr class="row2"><td>Exam</td><td>2027-02-10</td><td>10:00</td><td>Exam</td><td>Written exam, 90 minutes</td><td><a href="https://other.example/x.pdf">x</a></td></tr>
		</table><script>isValidToken () { return (this.grantAccess("${await encrypt("magic", TOKEN)}") === "magic") }</script></body></html>`;

	it("reads locked-course.example with the token from a stored item, stores the unlocked links without the token, and stores the PDFs", async () => {
		const { env, objects } = fakeEnv();
		await ensureSchema(env.DB);
		await applyScope(env, ctxFor(env).budget, {
			scope: "mail:INBOX",
			complete: false,
			entries: [{ key: "mail:INBOX:1:1", item: { key: "mail:INBOX:1:1", source: "mail", title: "Course", url: "u", content: { text: `Access: https://locked-course.example/#${TOKEN} [1]` } } }],
		});
		web = {
			"https://locked-course.example/": { type: "text/html; charset=utf-8", body: await lockedPage(), headers: { ETag: '"p1"' } },
			"https://locked-course.example/pdf/Module-01-Agenda.pdf": { type: "application/pdf", body: "%PDF-1.7 agenda", headers: { ETag: '"a1"', "Last-Modified": "Thu, 22 Oct 2026 11:20:54 GMT" } },
		};
		stubFetch();
		await unitSite(ctxFor(env), "locked");
		expect(requests).toEqual(["GET https://locked-course.example/", "HEAD https://locked-course.example/pdf/Module-01-Agenda.pdf", "GET https://locked-course.example/pdf/Module-01-Agenda.pdf"]);

		const page = await env.DB.prepare("SELECT content FROM items WHERE key = 'site:locked:https://locked-course.example/'").first<{ content: string }>();
		const c = JSON.parse(page?.content ?? "{}");
		expect(c.unlocked.state).toBe("unlocked");
		expect(c.unlocked.rows).toEqual([{ cells: ["Thu", "2026-10-22", "14:15-17:00", "Module 01", "LECTURE", "AGENDA"], links: ["https://youtu.be/abc", `https://pad.example/#${TOKEN_MASK}?!ui`] }]);
		expect(c.page.text).toContain("Written exam, 90 minutes");
		expect(c.page.text).not.toContain("Module 02");
		expect(c.tables[0].rows.length).toBe(2);
		expect(c.moodle_course).toBe(1001);

		const pdf = await env.DB.prepare("SELECT title, json_extract(content, '$.file.r2_key') r2 FROM items WHERE key = 'site:locked:https://locked-course.example/pdf/Module-01-Agenda.pdf'").first<{ title: string; r2: string }>();
		expect(pdf?.title).toBe("Module-01-Agenda.pdf");
		expect(new TextDecoder().decode(objects.get(pdf?.r2 as string)?.bytes)).toBe("%PDF-1.7 agenda");

		// The token is stored only in the item that brought it (the mail), nowhere else.
		const withToken = await env.DB.prepare("SELECT key FROM items WHERE content LIKE ?").bind(`%${TOKEN}%`).all<{ key: string }>();
		expect(withToken.results.map((r) => r.key)).toEqual(["mail:INBOX:1:1"]);
		const deltas = await env.DB.prepare("SELECT count(*) n FROM deltas WHERE item_key LIKE 'site:%' AND (content LIKE ?1 OR changes LIKE ?1)").bind(`%${TOKEN}%`).first<{ n: number }>();
		expect(deltas?.n).toBe(0);
		for (const [k, o] of objects) expect(new TextDecoder().decode(o.bytes).includes(TOKEN), k).toBe(false);

		// Next run: the PDF is unchanged (same ETag), so only a HEAD request goes out for it.
		requests.length = 0;
		await unitSite(ctxFor(env), "locked");
		expect(requests.filter((r) => r.includes("pdf/"))).toEqual(["HEAD https://locked-course.example/pdf/Module-01-Agenda.pdf"]);
	});

	it("says so when no valid token is stored", async () => {
		const { env } = fakeEnv();
		await ensureSchema(env.DB);
		web = { "https://locked-course.example/": { type: "text/html", body: await lockedPage() } };
		stubFetch();
		await unitSite(ctxFor(env, 1), "locked");
		const c = JSON.parse((await env.DB.prepare("SELECT content FROM items WHERE key = 'site:locked:https://locked-course.example/'").first<{ content: string }>())?.content ?? "{}");
		expect(c.unlocked).toEqual({ state: "no token found in the stored items" });
	});

	it("crawls the database course site, slides included, and forgets a site removed from the config", async () => {
		const { env } = fakeEnv();
		await ensureSchema(env.DB);
		const g = "https://db.example.org/teaching/course/";
		const f = "https://db.example.org/teaching/book/slides/";
		web = {
			[g]: { type: "text/html", body: `<body><a href="schema.pdf">Schema</a><a href="${f}">Folien</a><a href="/~lecturer">Lecturer</a><a href="../book/recordings/lecture_01.mp4">Video</a></body>` },
			[`${g}schema.pdf`]: { type: "application/pdf", body: "%PDF schema" },
			[f]: { type: "text/html", body: `<body><a href="kapitel1.pdf">Kapitel 1</a></body>` },
			[`${f}kapitel1.pdf`]: { type: "application/pdf", body: "%PDF k1" },
		};
		stubFetch();
		await unitSite(ctxFor(env), "db");
		const keys = (await env.DB.prepare("SELECT key FROM items WHERE scope = 'site:db' ORDER BY key").all<{ key: string }>()).results.map((r) => r.key);
		expect(keys).toEqual([`site:db:${f}`, `site:db:${f}kapitel1.pdf`, `site:db:${g}`, `site:db:${g}schema.pdf`]);
		expect(requests.some((r) => r.includes("~lecturer") || r.includes(".mp4"))).toBe(false);

		// A site that is no longer in the config is forgotten without "removed" deltas.
		await env.DB.prepare("UPDATE items SET scope = 'site:old', key = 'site:old:' || key WHERE key = ?").bind(`site:db:${g}`).run();
		await env.DB.prepare("UPDATE deltas SET item_key = 'site:old:' || item_key WHERE item_key = ?").bind(`site:db:${g}`).run();
		expect(await forgetRemovedSites(env)).toBe(1);
		expect((await env.DB.prepare("SELECT count(*) n FROM items WHERE scope = 'site:old'").first<{ n: number }>())?.n).toBe(0);
		expect((await env.DB.prepare("SELECT count(*) n FROM deltas WHERE item_key LIKE 'site:old:%'").first<{ n: number }>())?.n).toBe(0);
		expect((await env.DB.prepare("SELECT count(*) n FROM items WHERE scope = 'site:db'").first<{ n: number }>())?.n).toBe(3);
	});
});
