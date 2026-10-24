import { describe, expect, it } from "vitest";
import { parseTables } from "../src/lib/html-table";
import { closestEntries, findEntry, nameColumn, ranksByScore, similarity } from "../src/platforms/its-scoreboard";
import { userIdFromHtml } from "../src/platforms/moodle";
import { forumIdsFromPage, icsDate, parseIcs, parseRss, rssUrl } from "../src/platforms/moodle-feeds";

describe("iCal", () => {
	it("parses Moodle events with folding, escapes and time zones", () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"BEGIN:VEVENT",
			"UID:123@www.moodle.tum.de",
			"SUMMARY:Übungsblatt 3 ist fällig",
			"DESCRIPTION:Bitte als PDF\\, max. 2 Seiten\\nabgeben",
			"CATEGORIES:IN0001",
			"DTSTART:20261103T225900Z",
			"DTEND:20261103T225900Z",
			"END:VEVENT",
			"BEGIN:VEVENT",
			"SUMMARY:Vorlesung mit sehr langem",
			"  Titel",
			"DTSTART;TZID=Europe/Berlin:20260720T100000",
			"DTEND;TZID=Europe/Berlin:20260720T113000",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");
		const [a, b] = parseIcs(ics);
		expect(a).toMatchObject({ summary: "Übungsblatt 3 ist fällig", course: "IN0001", start: "2026-11-03T22:59:00.000Z", deadline: true });
		expect(a.description).toBe("Bitte als PDF, max. 2 Seiten\nabgeben");
		expect(b.summary).toBe("Vorlesung mit sehr langem Titel");
		expect(b.start).toBe("2026-07-20T08:00:00.000Z"); // CEST = UTC+2
		expect(b.deadline).toBe(false);
		expect(icsDate("20261220T100000", { TZID: "Europe/Berlin" }).iso).toBe("2026-12-20T09:00:00.000Z"); // CET = UTC+1
		expect(icsDate("20261220", {})).toEqual({ iso: "2026-12-20", allDay: true });
	});
});

describe("RSS", () => {
	it("parses items and the Moodle error feed", () => {
		const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>IN0001: Ankündigungen</title><item><title>Raumänderung</title><link>https://www.moodle.tum.de/mod/forum/discuss.php?d=5</link><pubDate>Mon, 12 Oct 2026 10:00:00 GMT</pubDate><description>&lt;p&gt;Die Vorlesung findet in MW 2001 statt.&lt;/p&gt;</description></item></channel></rss>`;
		const r = parseRss(feed);
		expect(r.title).toBe("IN0001: Ankündigungen");
		expect(r.items[0]).toMatchObject({ title: "Raumänderung", published: "2026-10-12T10:00:00.000Z", text: "Die Vorlesung findet in MW 2001 statt." });
		const err = parseRss(`<rss><channel><title>TUM-Moodle</title><description>Fehler: RSS-Fehler</description></channel></rss>`);
		expect(err.items).toEqual([]);
		expect(err.error).toMatch(/Fehler/);
	});

	it("finds forum IDs on a forum page and builds the feed URL", () => {
		expect(forumIdsFromPage('<a href="https://www.moodle.tum.de/rss/file.php/4711/0123456789abcdef0123456789abcdef/mod_forum/99/rss.xml">RSS</a>')).toEqual({ contextid: 4711, forumid: 99, rssLink: true });
		expect(forumIdsFromPage('M.cfg = {"contextid":4711,"sesskey":"x"}; <div data-forumid="99">')).toEqual({ contextid: 4711, forumid: 99, rssLink: false });
		expect(rssUrl("abc", 4711, 99)).toBe("https://www.moodle.tum.de/rss/file.php/4711/abc/mod_forum/99/rss.xml");
	});

	it("detects the Moodle RSS error item", () => {
		const r = parseRss(`<rss><channel><title>TUM-Moodle</title><item><title>RSS Error</title><link>https://www.moodle.tum.de</link><description>Fehler beim Lesen der RSS-Daten</description></item></channel></rss>`);
		expect(r.items).toEqual([]);
		expect(r.error).toBe("Fehler beim Lesen der RSS-Daten");
	});

	it("finds the Moodle user ID", () => {
		expect(userIdFromHtml('<a href="https://www.moodle.tum.de/user/profile.php">Profil</a><a href="https://www.moodle.tum.de/mod/forum/user.php?id=98765">Forum</a>')).toBe(98765);
		expect(userIdFromHtml('<a href="https://www.moodle.tum.de/user/profile.php?id=123456">Profil</a>')).toBe(123456);
		expect(userIdFromHtml('<div data-userid="777">')).toBe(777);
		expect(userIdFromHtml("nothing")).toBeUndefined();
	});
});

describe("scoreboard tables", () => {
	const html = `<table><thead><tr><th>Rang</th><th>Name</th><th>Punkte</th></tr></thead><tbody>
		<tr><td>1</td><td>Alice A.</td><td>120</td></tr><tr><td>2</td><td><b>Max M.</b></td><td>110</td></tr></tbody></table>`;
	it("parses headers and rows and finds my rank", () => {
		const [t] = parseTables(html);
		expect(t.headers).toEqual(["Rang", "Name", "Punkte"]);
		expect(t.rows).toEqual([
			["1", "Alice A.", "120"],
			["2", "Max M.", "110"],
		]);
		expect(findEntry(t, "max m.")).toEqual({ index: 1, rank: "2", entry: { Rang: "2", Name: "Max M.", Punkte: "110" } });
		expect(findEntry(t, "nobody")).toBeUndefined();
	});

	it("uses the team column, ranks by score and lists the closest names", () => {
		const [t] = parseTables(`<table><tr><th>#</th><th>Score</th><th>Team</th><th>#t00</th></tr>
			<tr><td>1</td><td>4</td><td>Team 2</td><td></td></tr><tr><td>2</td><td>14</td><td>BurningSec</td><td></td></tr>
			<tr><td>3</td><td>23</td><td>sudo apt get flag</td><td></td></tr><tr><td>4</td><td>14</td><td>Team 12</td><td></td></tr></table>`);
		expect(t.headers[nameColumn(t)]).toBe("Team");
		expect(ranksByScore(t)).toEqual([4, 2, 1, 2]);
		expect(findEntry(t, "burningsec")?.index).toBe(1);
		expect(findEntry(t, "Max M.")).toBeUndefined();
		const close = closestEntries(t, "Burning Sec", 2);
		expect(close[0].name).toBe("BurningSec");
		expect(close).toHaveLength(2);
		expect(similarity("Team 1", "Team 12")).toBeGreaterThan(similarity("Team 1", "BurningSec"));
	});
});
