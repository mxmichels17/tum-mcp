import { describe, expect, it, vi } from "vitest";
import type { ScopeResult } from "../src/collector/model";
import { applyScope, type Budget, ensureSchema, getState, setState } from "../src/collector/store";
import type { UnitCtx } from "../src/collector/unit";
import { unitMoodleCourse } from "../src/collector/units/moodle";
import { fakeEnv } from "./fake-store";

// Course 9: one section per page. Section 1 has a summary and a label that only its own page shows.
const OH_STATE = {
	section: [
		{ id: 900, number: 0, title: "Welcome", cmlist: [90], sectionurl: "https://www.moodle.tum.de/course/view.php?id=9&section=0" },
		{ id: 901, number: 1, title: "Project Work", cmlist: [91], sectionurl: "https://www.moodle.tum.de/course/view.php?id=9&section=1" },
	],
	cm: [
		{ id: 90, name: "Announcements", module: "label" },
		{ id: 91, name: "Hinweis", module: "label" },
	],
};

// A Moodle course with 12 page activities and one forum with 3 discussions, served by a fake client.
const PAGES = Array.from({ length: 12 }, (_, i) => ({ id: 100 + i, name: `Seite ${i}`, module: "page", url: `https://www.moodle.tum.de/mod/page/view.php?id=${100 + i}` }));
const FORUM = { id: 50, name: "Ankündigungen", module: "forum", url: "https://www.moodle.tum.de/mod/forum/view.php?id=50" };
const forumPage = [7, 8, 9].map((d) => `<tr data-discussionid="${d}"><td><a href="https://www.moodle.tum.de/mod/forum/discuss.php?d=${d}">Thema ${d}</a></td></tr>`).join("");
const calls: string[] = [];

const fake = {
	call: async (fn: string, args: Record<string, unknown>) => {
		calls.push(`${fn}:${args.discussionid ?? ""}`);
		if (fn === "core_courseformat_get_state" && args.courseid === 9) return JSON.stringify(OH_STATE);
		if (fn === "core_courseformat_get_state") return JSON.stringify({ section: [{ id: 1, number: 0, title: "Allgemein", cmlist: [50, ...PAGES.map((p) => p.id)] }], cm: [FORUM, ...PAGES] });
		if (fn === "mod_forum_get_discussion_posts") return { posts: [{ id: Number(args.discussionid) * 10, subject: `Thema ${args.discussionid}`, message: "<p>Text</p>" }] };
		throw new Error(`unexpected ${fn}`);
	},
	page: async (path: string) =>
		path.includes("id=9")
			? '<div role="main"><li id="section-0"><ul><li class="activity" id="module-90">Announcements</li></ul></li><a href="https://www.moodle.tum.de/course/view.php?id=9&section=1">Project Work</a></div>'
			: "<html><body><div role=\"main\">Kurs</div></body></html>",
	web: async (url: string) => {
		calls.push(`web:${url}`);
		if (url.includes("id=9&section=1")) return { text: '<div role="main"><li id="section-1"><div class="summarytext">Teams of four, pitch on 4 February.</div><ul><li class="activity" id="module-91"><div class="activity-altcontent">Bring your laptop on 29 October.</div></li></ul></li></div>', url: new URL(url), status: 200 };
		const text = url.includes("/mod/forum/") ? `<div role="main">${forumPage}</div>` : `<div role="main">Inhalt ${url}</div>`;
		return { text, url: new URL(url), status: 200 };
	},
	rawFetch: async () => new Response(""),
	me: async () => 1,
};

vi.mock("../src/platforms/moodle", async (orig) => ({ ...(await orig<typeof import("../src/platforms/moodle")>()), MoodleClient: { create: () => fake } }));

function ctxFor(env: Env, max: number): UnitCtx {
	let loads = 0;
	const budget: Budget = { canLoad: () => loads < max, loaded: () => void loads++, used: () => 0 };
	return { env, budget, note: () => {}, writesLeft: () => 1e9, apply: (r: ScopeResult, b?: Budget) => applyScope(env, b ?? budget, r) };
}

describe("Moodle course unit", () => {
	it("reads new forum discussions before re-reading activity pages, so they finish over the runs", async () => {
		const { env } = fakeEnv();
		await ensureSchema(env.DB);
		await setState(env.DB, "moodle:courses", [{ id: 7, name: "PED" }]);
		// Run 1 reads the forum page (the listing) and pages; later runs re-read pages in rotation.
		for (let run = 0; run < 3; run++) await unitMoodleCourse(ctxFor(env, 10), "7");
		const discussions = calls.filter((c) => c.startsWith("mod_forum_get_discussion_posts")).map((c) => c.split(":")[1]);
		expect(discussions.sort()).toEqual(["7", "8", "9"]);
		expect((await getState<number>(env.DB, "pending:moodle:forum:50")) ?? 0).toBe(0);
		// Every activity page was read at least once.
		for (const p of PAGES) expect(calls).toContain(`web:${p.url}`);
	});

	it("reads the sections of a course with one section per page, with their summary and labels", async () => {
		const { env } = fakeEnv();
		await ensureSchema(env.DB);
		await setState(env.DB, "moodle:courses", [{ id: 9, name: "Opportunity Hunters" }]);
		await unitMoodleCourse(ctxFor(env, 10), "9");
		const section = await env.DB.prepare("SELECT title, json_extract(content, '$.page.text') text FROM items WHERE key = 'moodle:section:901'").first<{ title: string; text: string }>();
		expect(section).toEqual({ title: "Project Work", text: expect.stringContaining("Teams of four, pitch on 4 February.") });
		const label = await env.DB.prepare("SELECT json_extract(content, '$.text') text FROM items WHERE key = 'moodle:cm:91'").first<{ text: string }>();
		expect(label?.text).toBe("Bring your laptop on 29 October.");
		// Section 0 is on the course page and is not read again.
		expect(calls.some((c) => c.includes("id=9&section=0"))).toBe(false);
	});
});
