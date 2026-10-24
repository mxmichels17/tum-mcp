import { describe, expect, it } from "vitest";
import { itemHash } from "../src/collector/model";
import { applyScope, type Budget, deltaRows, ensureSchema, getState } from "../src/collector/store";
import type { UnitCtx } from "../src/collector/unit";
import { isFileTextChange, MAINTENANCE_DONE, stripFileTexts, unitMaintenance } from "../src/collector/units/maintenance";
import { moodleCourseInScope } from "../src/collector/units/moodle";
import { fakeEnv } from "./fake-store";

const budget = (): Budget => ({ canLoad: () => true, loaded: () => {}, used: () => 0 });
const ctxFor = (env: Env): UnitCtx => ({ env, budget: budget(), note: () => {}, writesLeft: () => 1e9, apply: (r) => applyScope(env, budget(), r) });

describe("PDF text clean-up (0.7.6)", () => {
	it("removes text and text_error only from file entries", () => {
		const content = {
			text: "Mail body stays",
			attachments: [{ name: "a.pdf", mime_type: "application/pdf", size: 3, url: "u", r2_key: "files/x", text: "AI text", text_error: null }],
			posts: [{ files: [{ name: "b.pdf", mime_type: "application/pdf", size: 1, url: "v", r2_key: null, not_stored: "video", text_error: "x" }] }],
		};
		const r = stripFileTexts(content);
		expect(r.changed).toBe(true);
		expect(r.value).toEqual({
			text: "Mail body stays",
			attachments: [{ name: "a.pdf", mime_type: "application/pdf", size: 3, url: "u", r2_key: "files/x" }],
			posts: [{ files: [{ name: "b.pdf", mime_type: "application/pdf", size: 1, url: "v", r2_key: null, not_stored: "video" }] }],
		});
		expect(stripFileTexts({ text: "x", page: { text: "y" } }).changed).toBe(false);
		expect(isFileTextChange({ field: "content.attachments[0].text", old: "a", new: "b" })).toBe(true);
		expect(isFileTextChange({ field: "content.posts[1].files[0].text_error", old: null, new: "e" })).toBe(true);
		expect(isFileTextChange({ field: "content.file.text", old: "a", new: null })).toBe(true);
		expect(isFileTextChange({ field: "content.text", old: "a", new: "b" })).toBe(false);
	});

	it("cleans R2, items and undelivered deltas without new deltas, and a re-read of the item finds no change", async () => {
		const { env, objects } = fakeEnv();
		await ensureSchema(env.DB);
		const file = { name: "Blatt.pdf", mime_type: "application/pdf", size: 10, url: "https://x/Blatt.pdf", r2_key: "files/abc", text: "made-up text" };
		const before = { key: "moodle:cm:1", source: "moodle", title: "Blatt", url: "https://x/cm/1", content: { course_id: 1, file } };
		await applyScope(env, budget(), { scope: "moodle:course:1", complete: true, entries: [{ key: before.key, item: before }] });
		await env.FILES.put("files/abc", "pdf");
		await env.FILES.put("files/abc.txt", "made-up text");

		await unitMaintenance(ctxFor(env));
		expect([...objects.keys()].sort()).toEqual(["files/abc"]);
		const [d] = await deltaRows(env.DB, 0, 10);
		expect(JSON.parse(d.content).file).toEqual({ name: "Blatt.pdf", mime_type: "application/pdf", size: 10, url: "https://x/Blatt.pdf", r2_key: "files/abc" });
		expect(await getState(env.DB, MAINTENANCE_DONE)).toBe(true);

		// The next read gives the file without text: same hash, no delta.
		const { text: _t, ...plain } = file;
		const after = { ...before, content: { course_id: 1, file: plain } };
		const r = await applyScope(env, budget(), { scope: "moodle:course:1", complete: true, entries: [{ key: after.key, item: after }] });
		expect(r).toMatchObject({ new: 0, changed: 0, removed: 0 });
		expect((await deltaRows(env.DB, 0, 10)).length).toBe(1);
		const row = await env.DB.prepare("SELECT hash FROM items WHERE key = ?").bind(before.key).first<{ hash: string }>();
		expect(row?.hash).toBe(itemHash(after));
	});
});

describe("Moodle course list (config/moodle-courses.json)", () => {
	const scope = { course_ids: [1001, 1002], name_contains: ["Example Course"] };
	it("takes courses by id or by a text in the name, case ignored", () => {
		expect(moodleCourseInScope({ id: 1001, fullname: "Exchange Program" }, scope)).toBe(true);
		expect(moodleCourseInScope({ id: "1002", fullname: "x" }, scope)).toBe(true);
		expect(moodleCourseInScope({ id: 1, fullname: "EXAMPLE COURSE (WI000123)" }, scope)).toBe(true);
		expect(moodleCourseInScope({ id: 2, fullname: "Course", shortname: "WI-example course-26" }, scope)).toBe(true);
		expect(moodleCourseInScope({ id: 1003, fullname: "Other Course" }, scope)).toBe(false);
	});
});
