import { afterEach, describe, expect, it, vi } from "vitest";
import { publicExams, scanPage } from "../src/platforms/tumonline-exams";

const lang = (v: string) => ({ coType: "model-core.lib.model.langdata", value: v, translations: { translation: [{ lang: "de", value: v }] } });

function exam(id: number, courseId: number, number: string, extra: Record<string, unknown> = {}) {
	return {
		courseId,
		deRegistrationEnd: { coType: "datetime", value: "2026-12-13T23:59:00" },
		courseName: lang(`Course ${number}`),
		courseSemesterShortName: lang("2026 W"),
		displayCourseNumber: number,
		examDate: { coType: "date", value: "2026-12-16" },
		examDateInformation: 'Raum {siehe Aushang} "A"',
		examEnd: { coType: "time", value: "11:00:00" },
		examPersons: [{ identities: [{ id: 73836, firstName: "A", lastName: "B" }] }],
		examStart: { coType: "time", value: "09:00:00" },
		examType: lang("Modulprüfung"),
		examTypeKey: "M",
		id,
		registrationDateEnd: { coType: "datetime", value: "2026-12-06T23:59:00" },
		registrationDateStart: { coType: "datetime", value: "2026-11-15T00:00:00" },
		...extra,
	};
}

/** The server's layout: 3 spaces indent and " : " between key and value. */
function serverJson(offers: unknown[], total: number): string {
	return JSON.stringify({ examOffers: offers, curriculumContextLink: { href: "x" }, totalCount: total }, null, 3).replace(/": /g, '" : ');
}

describe("public TUMonline exam list", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("gives the course name of an entry in every language to the filter", () => {
		const en = { coType: "model-core.lib.model.langdata", value: "Grundlagen: Datenbanken", translations: { translation: [{ lang: "de", value: "Grundlagen: Datenbanken" }, { lang: "en", value: "Fundamentals of Databases" }] } };
		const offers = [exam(1, 950000001, "WZ4012"), exam(2, 950000002, "IN0008", { courseName: en })];
		const seen: string[][] = [];
		const r = scanPage(serverJson(offers, 2), (k) => {
			seen.push(k.names());
			return k.names().includes("Fundamentals of Databases");
		});
		expect(seen).toEqual([["Course WZ4012"], ["Grundlagen: Datenbanken", "Fundamentals of Databases"]]);
		expect(r.picked).toEqual([offers[1]]);
	});

	it("scans a page as text and parses only the picked entries, unchanged", () => {
		const offers = [exam(1, 950000001, "WZ4012"), exam(2053306, 950962467, "WI001141"), exam(3, 950000003, "IN0004")];
		const r = scanPage(serverJson(offers, 3231), (k) => k.number === "WI001141" || k.courseId === "950000003");
		expect(r.total).toBe(3231);
		expect(r.count).toBe(3);
		expect(r.picked).toEqual([offers[1], offers[2]]);
	});

	it("falls back to a full parse for an unknown layout", () => {
		const text = JSON.stringify({ totalCount: 1, examOffers: [{ id: 5, displayCourseNumber: "WI1", courseId: 9 }].map((e) => ({ id: e.id, displayCourseNumber: e.displayCourseNumber, courseId: e.courseId })) });
		// courseId is not the first key here, so the text scan finds no entry start.
		expect(scanPage(text, () => true).picked).toHaveLength(1);
	});

	it("reads every page with literal $ parameters and stops at totalCount", async () => {
		const seen: string[] = [];
		vi.stubGlobal("fetch", async (u: string) => {
			seen.push(u);
			const skip = Number(/\$skip=(\d+)/.exec(u)?.[1]);
			const n = skip === 400 ? 50 : 200;
			const offers = Array.from({ length: n }, (_, i) => exam(skip + i + 1, 950000000 + skip + i, skip + i === 420 ? "WI001141" : `X${skip + i}`));
			return new Response(serverJson(offers, 450));
		});
		const r = await publicExams({ from: "2026-10-20", pick: (k) => k.number === "WI001141" });
		expect(seen).toHaveLength(3);
		expect(seen[0]).toContain("$filter=exExamDateFrom-gte=2026-10-20&$orderBy=exExamDate=ascnl&$skip=0&$top=200&orgId=-1");
		expect(r).toMatchObject({ total: 450, scanned: 450, pages: 3 });
		expect(r.entries.map((e) => e.id)).toEqual([421]);
	});
});
