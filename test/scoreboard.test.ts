import { describe, expect, it, vi } from "vitest";
import type { ScopeResult } from "../src/collector/model";
import { applyScope, type Budget, deltaRows, ensureSchema } from "../src/collector/store";
import type { UnitCtx } from "../src/collector/unit";
import { blankTeamCode, readableLinks, unitScoreboard } from "../src/collector/units/scoreboard";
import { safeScoreboardUrl } from "../src/platforms/its-scoreboard";
import { fakeEnv } from "./fake-store";

const S = "https://scoreboard.sec.in.tum.de";
const a = (href: string, text = href) => `<a href="${href}">${text}</a>`;
let site: Record<string, { type: string; body: string }> = {};
const fetched: string[] = [];

vi.mock("../src/platforms/its-scoreboard", async (orig) => {
	const real = await orig<typeof import("../src/platforms/its-scoreboard")>();
	return {
		...real,
		scoreboardFetch: async (_env: Env, path: string) => {
			const url = new URL(path, S);
			if (!real.safeScoreboardUrl(url)) throw new Error(`refused ${path}`);
			fetched.push(path);
			const p = site[path] ?? { type: "text/html", body: "<body>Not found</body>" };
			return { url, res: new Response(p.body, { status: site[path] ? 200 : 404, headers: { "Content-Type": p.type } }) };
		},
	};
});

function ctxFor(env: Env, max = 20): UnitCtx {
	let loads = 0;
	const budget: Budget = { canLoad: () => loads < max, loaded: () => void loads++, used: () => 0 };
	return { env, budget, note: () => {}, writesLeft: () => 1e9, apply: (r: ScopeResult) => applyScope(env, budget, r) };
}

describe("ITS scoreboard: read only", () => {
	it("refuses action links and other hosts", () => {
		const ok = (p: string) => safeScoreboardUrl(new URL(p, S));
		for (const p of ["/scoreboard", "/tasks", "/tasks/t04w1", "/materialien", "/booking", "/tutorials/attend", "/team", "/sshkeys", "/static/ue01.pdf", "/tasks?week=2"]) expect(ok(p), p).toBe(true);
		for (const p of ["/logout", "/team/join/5", "/team/leave", "/team/register", "/booking/book/3", "/sshkeys/add", "/sshkeys/delete/2", "/tasks/t01/submit", "/shib-login", "/team?token=abc", "/x?action=delete", "/tutorials/attend/confirm"]) expect(ok(p), p).toBe(false);
		expect(safeScoreboardUrl(new URL("https://login.tum.de/idp"))).toBe(false);
		expect(blankTeamCode({ text: "Create a team now by sending the following code to your desired teammate. The code is valid for 60 minutes:\nABCDEFGHJKLMN\nIf you have received a code" }).text).toBe(
			"Create a team now by sending the following code to your desired teammate. The code is valid for 60 minutes:\n[one-time team code, not stored]\nIf you have received a code",
		);
		expect(readableLinks([`${S}/tasks#top`, `${S}/static/style.css`, `${S}/logout`, "https://www.tum.de/", "/materialien/ue1.pdf"])).toEqual(["/tasks", "/materialien/ue1.pdf"]);
	});

	it("reads every linked page and file, never an action link, and reports a page that is no longer linked as removed", async () => {
		site = {
			"/scoreboard": { type: "text/html", body: `<body>${a("/scoreboard")}${a("/tasks", "Tasks")}${a("/materialien")}${a("/team")}${a("/logout", "Logout")}<table><tr><th>#</th><th>Team</th></tr><tr><td>1</td><td>A</td></tr></table></body>` },
			"/tasks": { type: "text/html", body: `<body>${a("/tasks/t00", "t00 Warmup")}${a("/tasks/t01", "t01 Buffer")}${a("/tasks/t01/submit", "Submit")}</body>` },
			"/tasks/t00": { type: "text/html", body: "<body><h1>t00</h1><p>Deadline 30.10.2026 23:59, 10 points</p></body>" },
			"/tasks/t01": { type: "text/html", body: `<body><h1>t01</h1>${a("/tasks/t01/dl", "t01.zip")}</body>` },
			"/tasks/t01/dl": { type: "application/zip", body: "PK..." },
			"/materialien": { type: "text/html", body: `<body>${a("/files/folien1.pdf", "Folien 1")}</body>` },
			"/files/folien1.pdf": { type: "application/pdf", body: "%PDF-1.4" },
			"/team": { type: "text/html", body: "<body><p>You are not in a team yet.</p><form method=post action=/team/register><input name=name></form></body>" },
		};
		const { env } = fakeEnv();
		await ensureSchema(env.DB);
		await unitScoreboard(ctxFor(env));
		expect(fetched.sort()).toEqual(["/files/folien1.pdf", "/materialien", "/scoreboard", "/tasks", "/tasks/t00", "/tasks/t01", "/tasks/t01/dl", "/team"].sort());
		const items = await env.DB.prepare("SELECT key, json_extract(content, '$.kind') kind, json_extract(content, '$.file.r2_key') r2 FROM items ORDER BY key").all<{ key: string; kind: string; r2: string | null }>();
		expect(items.results.map((r) => [r.key, r.kind])).toEqual([
			["its_scoreboard:page", null],
			["its_scoreboard:url:/files/folien1.pdf", "file"],
			["its_scoreboard:url:/materialien", "page"],
			["its_scoreboard:url:/tasks", "page"],
			["its_scoreboard:url:/tasks/t00", "page"],
			["its_scoreboard:url:/tasks/t01", "page"],
			["its_scoreboard:url:/tasks/t01/dl", "file"],
			["its_scoreboard:url:/team", "page"],
		]);
		expect(items.results.find((r) => r.key.endsWith(".pdf"))?.r2).toMatch(/^files\//);
		const dl = await env.DB.prepare("SELECT title FROM items WHERE key = 'its_scoreboard:url:/tasks/t01/dl'").first<{ title: string }>();
		expect(dl?.title).toBe("t01.zip");
		const first = (await deltaRows(env.DB, 0, 50)).length;
		expect(first).toBe(8);

		// Task t00 is no longer linked, task t01 changed its text.
		site["/tasks"] = { type: "text/html", body: `<body>${a("/tasks/t01", "t01 Buffer")}</body>` };
		site["/tasks/t01"] = { type: "text/html", body: `<body><h1>t01</h1><p>Hint: use gdb</p>${a("/tasks/t01/dl", "t01.zip")}</body>` };
		for (let run = 0; run < 2; run++) await unitScoreboard(ctxFor(env));
		const later = await deltaRows(env.DB, first, 50);
		expect(later.map((d) => [d.type, d.item_key]).sort()).toEqual([
			["changed", "its_scoreboard:url:/tasks"],
			["changed", "its_scoreboard:url:/tasks/t01"],
			["removed", "its_scoreboard:url:/tasks/t00"],
		]);
		expect(fetched.some((p) => /logout|submit|register/.test(p))).toBe(false);
	});
});
