import { describe, expect, it } from "vitest";
import { ImapClient, imapDate, imapString } from "../src/lib/imap";
import { parseResponse, valueToString } from "../src/lib/imap-parse";
import { decodeMailboxName, encodeMailboxName } from "../src/lib/utf7";
import { imapServer } from "./helpers";

const enc = new TextEncoder();

describe("imap-parse", () => {
	it("parses atoms, quoted strings, NIL, lists and literals", () => {
		const v = parseResponse(enc.encode('* 3 FETCH (UID 42 FLAGS (\\Seen $Label1) INTERNALDATE "17-Oct-2026 10:00:00 +0200" BODY[HEADER.FIELDS (FROM SUBJECT)] {12}\r\nSubject: Hi\n X NIL)'));
		expect(v[0]).toBe("*");
		expect(v[1]).toBe("3");
		expect(v[2]).toBe("FETCH");
		const list = v[3] as unknown[];
		expect(list[0]).toBe("UID");
		expect(list[1]).toBe("42");
		expect(list[3]).toEqual(["\\Seen", "$Label1"]);
		expect(list[5]).toBe("17-Oct-2026 10:00:00 +0200");
		expect(list[6]).toBe("BODY[HEADER.FIELDS (FROM SUBJECT)]");
		expect(valueToString(list[7] as Uint8Array)).toBe("Subject: Hi\n");
		expect(list[8]).toBe("X");
		expect(list[9]).toBeNull();
	});

	it("unescapes quoted strings", () => {
		const v = parseResponse(enc.encode('* LIST (\\HasNoChildren) "/" "a \\"b\\" \\\\c"'));
		expect(v[4]).toBe('a "b" \\c');
	});
});

describe("modified UTF-7", () => {
	it("round-trips German folder names", () => {
		for (const name of ["INBOX", "Gelöschte Objekte", "Entwürfe", "A&B", "日本語"]) {
			expect(decodeMailboxName(encodeMailboxName(name))).toBe(name);
		}
		expect(encodeMailboxName("Gelöschte Objekte")).toBe("Gel&APY-schte Objekte");
		expect(encodeMailboxName("A&B")).toBe("A&-B");
	});
});

describe("helpers", () => {
	it("formats IMAP dates and strings", () => {
		expect(imapDate(new Date("2026-02-01T00:00:00Z"))).toBe("1-Feb-2026");
		expect(imapString('pa"ss')).toBe('"pa\\"ss"');
		expect(imapString("Passwört")).toEqual({ literal: enc.encode("Passwört") });
	});
});

describe("ImapClient against a scripted server", () => {
	const message = "From: Alice <alice@tum.de>\r\nSubject: Hallo\r\n\r\nBody text\r\n";

	function server() {
		const seen: string[] = [];
		const conn = imapServer((tag, cmd, literals) => {
			seen.push(cmd + (literals.length ? ` [${literals.map((l) => new TextDecoder().decode(l)).join("|")}]` : ""));
			if (cmd.startsWith("LOGIN")) {
				if (cmd.includes("wrong") || literals.some((l) => new TextDecoder().decode(l) === "wrong")) return `${tag} NO [AUTHENTICATIONFAILED] Authentication failed.\r\n`;
				return `${tag} OK [CAPABILITY IMAP4rev1 MOVE UIDPLUS SPECIAL-USE] Logged in\r\n`;
			}
			if (cmd.startsWith("LIST")) {
				return [
					'* LIST (\\HasNoChildren) "/" INBOX',
					'* LIST (\\HasNoChildren \\Sent) "/" "Sent"',
					'* LIST (\\HasNoChildren \\Trash) "/" "Gel&APY-schte Objekte"',
					'* LIST (\\HasNoChildren) "/" {12}\r\nEntw&APw-rfe',
					`${tag} OK List completed`,
				].join("\r\n") + "\r\n";
			}
			if (cmd.startsWith("SELECT") || cmd.startsWith("EXAMINE")) {
				return `* 2 EXISTS\r\n* OK [UIDVALIDITY 1234] UIDs valid\r\n${tag} OK [READ-WRITE] Select completed\r\n`;
			}
			if (cmd.startsWith("UID SEARCH")) return `* SEARCH 7 9\r\n${tag} OK Search completed\r\n`;
			if (cmd.startsWith("UID FETCH")) {
				const body = enc.encode(message);
				return `* 1 FETCH (UID 9 FLAGS (\\Seen) BODY[] {${body.length}}\r\n${message})\r\n${tag} OK Fetch completed\r\n`;
			}
			if (cmd.startsWith("UID MOVE")) return `* OK [COPYUID 1 9 100] Moved\r\n* 1 EXPUNGE\r\n${tag} OK Move completed\r\n`;
			if (cmd.startsWith("APPEND")) return `${tag} OK [APPENDUID 1 101] Append completed\r\n`;
			if (cmd.startsWith("LOGOUT")) return `* BYE Logging out\r\n${tag} OK Logout completed\r\n`;
			return `${tag} BAD Unknown command\r\n`;
		});
		conn.send("* OK [CAPABILITY IMAP4rev1 LITERAL+ AUTH=PLAIN] Dovecot ready.\r\n");
		return { ...conn, seen };
	}

	it("logs in, lists, searches, fetches, moves and appends", async () => {
		const s = server();
		const c = new ImapClient(s.io);
		await c.greeting();
		await c.login("ge12abc", "Passwört");
		expect(s.seen[0]).toBe('LOGIN "ge12abc" <LITERAL> [Passwört]');
		expect(c.capabilities.has("MOVE")).toBe(true);

		const boxes = await c.list();
		expect(s.seen[1]).toBe('LIST "" "*" RETURN (SPECIAL-USE)');
		expect(boxes.map((b) => b.name)).toEqual(["INBOX", "Sent", "Gelöschte Objekte", "Entwürfe"]);
		expect(boxes[1].flags).toContain("\\Sent");

		expect(await c.select("Gelöschte Objekte", true)).toEqual({ exists: 2, uidValidity: 1234 });
		expect(s.seen[2]).toBe('EXAMINE "Gel&APY-schte Objekte"');

		expect(await c.uidSearch(["FROM", imapString("alice")])).toEqual([7, 9]);
		expect(await c.uidSearch(["SUBJECT", imapString("Prüfung")])).toEqual([7, 9]);
		expect(s.seen[4]).toBe("UID SEARCH CHARSET UTF-8 SUBJECT <LITERAL> [Prüfung]");

		const msgs = await c.uidFetch([9], "(UID FLAGS BODY.PEEK[])");
		expect(msgs).toHaveLength(1);
		expect(msgs[0].uid).toBe(9);
		expect(valueToString(msgs[0].attrs.get("BODY[]"))).toBe(message);

		expect(await c.uidMove([9], "Gelöschte Objekte")).toBeUndefined();
		expect(s.seen[6]).toBe('UID MOVE 9 "Gel&APY-schte Objekte"');

		await c.append("Sent", ["\\Seen"], enc.encode(message));
		expect(s.seen[7]).toBe(`APPEND "Sent" (\\Seen) <LITERAL> [${message}]`);
		await c.logout();
	});

	it("reports failed logins as auth errors", async () => {
		const s = server();
		const c = new ImapClient(s.io);
		await c.greeting();
		await expect(c.login("ge12abc", "wrong")).rejects.toMatchObject({ kind: "auth" });
	});
});
