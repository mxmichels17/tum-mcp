import { describe, expect, it } from "vitest";
import { cellText, keyValueRows, parseForms, parseTables } from "../src/lib/html-table";
import { authorName, parseCoursePage, parseCourseState, parseForumPage } from "../src/platforms/moodle-web";

describe("Moodle course page", () => {
	const html = `<ul class="topics">
	<li id="section-0" class="section course-section main" data-sectionname="Allgemeines" data-number="0">
	  <ul data-for="cmlist">
	    <li class="activity activity-wrapper forum modtype_forum" id="module-3000001" data-for="cmitem">
	      <a href="https://www.moodle.tum.de/mod/forum/view.php?id=3000001" class="aalink"><span class="instancename">Ankündigungen <span class="accesshide"> Forum</span></span></a>
	    </li>
	  </ul>
	</li>
	<li id="section-1" class="section course-section main" data-sectionname="14. Oktober - 20. Oktober" data-number="1">
	  <ul data-for="cmlist">
	    <li class="activity assign modtype_assign" id="module-3000002">
	      <a href="https://www.moodle.tum.de/mod/assign/view.php?id=3000002"><span class="instancename">Übungsblatt 1 <span class="accesshide">Aufgabe</span></span></a>
	      <div data-region="activity-dates" class="activity-dates"><div class="description-inner"><div><strong>Geöffnet:</strong> Montag, 14. Oktober 2026, 00:00</div><div><strong>Fällig:</strong> Montag, 21. Oktober 2026, 23:59</div></div></div>
	    </li>
	  </ul>
	</li></ul>`;
	it("reads sections, activities and dates", () => {
		const s = parseCoursePage(html);
		expect(s).toHaveLength(2);
		expect(s[0].modules[0]).toMatchObject({ cmid: 3000001, type: "forum", name: "Ankündigungen" });
		expect(s[1].name).toBe("14. Oktober - 20. Oktober");
		expect(s[1].modules[0]).toMatchObject({ cmid: 3000002, type: "assign", name: "Übungsblatt 1" });
		expect(s[1].modules[0].dates).toEqual(["Geöffnet: Montag, 14. Oktober 2026, 00:00", "Fällig: Montag, 21. Oktober 2026, 23:59"]);
	});

	it("reads the course index state", () => {
		const state = JSON.stringify({
			section: [{ id: 10, number: 0, title: "Allgemeines", cmlist: ["5"] }, { id: 11, number: 1, title: "Woche 1", cmlist: ["6", "7"] }],
			cm: [
				{ id: "5", name: "Ankündigungen", module: "forum", url: "https://www.moodle.tum.de/mod/forum/view.php?id=5" },
				{ id: "6", name: "Module 1 Submission", module: "assign", url: "https://www.moodle.tum.de/mod/assign/view.php?id=6" },
				{ id: "7", name: "Hidden", module: "page", uservisible: false },
			],
		});
		const s = parseCourseState(state);
		expect(s[1].modules).toEqual([{ cmid: 6, type: "assign", name: "Module 1 Submission", url: "https://www.moodle.tum.de/mod/assign/view.php?id=6", dates: [] }]);
	});
});

describe("Moodle forum page", () => {
	it("reads discussions and the forum ID", () => {
		const html = `<a href="https://www.moodle.tum.de/mod/forum/post.php?forum=2001">Neues Thema</a>
		<table class="table discussion-list"><tbody>
		<tr class="discussion" data-region="discussion-list-item" data-discussionid="100001">
		  <th class="topic p-0"><a class="w-100 h-100 d-block" href="https://www.moodle.tum.de/mod/forum/discuss.php?d=100001" title="Frage zum Übungsblatt">Frage zum Übungsblatt</a></th>
		  <td class="author align-middle"><div>Erika Musterfrau</div></td>
		  <td class="text-left align-middle fit-content lastpost">14. Okt. 2026</td>
		</tr></tbody></table>`;
		const r = parseForumPage(html);
		expect(r.forum_id).toBe(2001);
		expect(r.discussions).toEqual([{ discussion_id: 100001, subject: "Frage zum Übungsblatt", author: "Erika Musterfrau", last_post: "14. Okt. 2026", replies: undefined }]);
	});
});

describe("forum author", () => {
	it("drops the date next to the author name", () => {
		expect(authorName("<div>Erika Musterfrau 14. Okt. 2026</div>")).toBe("Erika Musterfrau");
		expect(authorName('<div class="d-flex"><span>Erika Musterfrau</span></div><div><time>14. Okt. 2026</time></div>')).toBe("Erika Musterfrau");
		expect(authorName("<div>Jane Doe</div><div>Oct 14, 2026</div>")).toBe("Jane Doe");
		expect(authorName("Max Mustermann")).toBe("Max Mustermann");
	});
});

describe("tables and forms", () => {
	it("cleans cells and keeps th cells in data rows", () => {
		const html = `<table class="generaltable user-grade"><tr><th>Bewertungsaspekt</th><th>Bewertung</th></tr>
		<tr><th class="item"><span class="accesshide">Aufgabe</span><a href="/mod/assign/view.php?id=1">Module 1</a></th><td>15,00 <div class="action-menu"><a href="#">Aktionen</a><div class="dropdown-menu"><a href="/x">Bewertungsanalyse</a></div></div></td></tr></table>`;
		const [t] = parseTables(html);
		expect(t.headers).toEqual(["Bewertungsaspekt", "Bewertung"]);
		expect(t.rows).toEqual([["Module 1", "15,00"]]);
		expect(cellText('<a href="https://x.de">Kurs</a>')).toBe("Kurs");
		expect(keyValueRows("<table><tr><th>Abgabestatus</th><td>Kein Versuch</td></tr><tr><td>Bewertungsstatus</td><td>Nicht bewertet</td></tr></table>")).toEqual({
			Abgabestatus: "Kein Versuch",
			Bewertungsstatus: "Nicht bewertet",
		});
	});

	it("reads all form fields", () => {
		const html = `<form action="/search" method="get"><input name="q"></form>
		<form id="mform1" action="https://www.moodle.tum.de/mod/forum/post.php" method="post">
		<input type="hidden" name="sesskey" value="abc"><input type="hidden" name="forum" value="7">
		<input type="text" name="subject" value=""><textarea name="message[text]">x &amp; y</textarea>
		<select name="groupid"><option value="0">Alle</option><option value="5" selected>G5</option></select>
		<input type="checkbox" name="discussionsubscribe" value="1" checked><input type="checkbox" name="pinned" value="1">
		<input type="submit" name="submitbutton" value="Beitrag senden"><input type="submit" name="cancel" value="Abbrechen"></form>`;
		const forms = parseForms(html, new URL("https://www.moodle.tum.de/mod/forum/post.php?forum=7"));
		expect(forms).toHaveLength(2);
		expect(forms[1].fields).toEqual({ sesskey: "abc", forum: "7", subject: "", "message[text]": "x & y", groupid: "5", discussionsubscribe: "1" });
		expect(forms[1].buttons).toEqual({ submitbutton: "Beitrag senden", cancel: "Abbrechen" });
		expect(forms[1].action.href).toBe("https://www.moodle.tum.de/mod/forum/post.php");
	});
});
