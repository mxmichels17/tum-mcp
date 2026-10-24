import PostalMime from "postal-mime";
import { describe, expect, it } from "vitest";
import { buildMessage, encodeWord, parseAddress } from "../src/lib/mime-build";
import { dotStuff, smtpSession } from "../src/lib/smtp";
import { normalizeFlag } from "../src/platforms/mail";
import { fakeConnection } from "./helpers";

const dec = new TextDecoder();

describe("mime-build", () => {
	it("builds a message that postal-mime parses back", async () => {
		const { raw, messageId } = buildMessage({
			from: { name: "Max Müller", address: "max@tum.de" },
			to: [parseAddress("Prof. Dr. X <x@cit.tum.de>")],
			cc: [parseAddress("y@tum.de")],
			subject: "Frage zur Prüfung – Übungsblatt 3",
			text: "Hallo,\nwann ist die Prüfung?\n.\nGrüße",
			inReplyTo: "<abc@tum.de>",
			references: ["<abc@tum.de>"],
			attachments: [{ filename: "Lösung.pdf", mimeType: "application/pdf", content: new Uint8Array([37, 80, 68, 70]) }],
		});
		expect(/[^\x00-\x7f]/.test(dec.decode(raw))).toBe(false);
		const e = await PostalMime.parse(raw);
		expect(e.subject).toBe("Frage zur Prüfung – Übungsblatt 3");
		expect(e.from).toMatchObject({ name: "Max Müller", address: "max@tum.de" });
		expect(e.to?.[0]).toMatchObject({ name: "Prof. Dr. X", address: "x@cit.tum.de" });
		expect(e.messageId).toBe(messageId);
		expect(e.inReplyTo).toBe("<abc@tum.de>");
		expect(e.text?.replace(/\r\n/g, "\n")).toBe("Hallo,\nwann ist die Prüfung?\n.\nGrüße");
		expect(e.attachments).toHaveLength(1);
		expect(e.attachments[0].filename).toBe("Lösung.pdf");
		expect(new Uint8Array(e.attachments[0].content as ArrayBuffer)).toEqual(new Uint8Array([37, 80, 68, 70]));
	});

	it("rejects invalid addresses and header injection", () => {
		expect(() => parseAddress("not an address")).toThrow();
		const { raw } = buildMessage({ from: { address: "a@tum.de" }, to: [{ address: "b@tum.de" }], subject: "x\r\nBcc: evil@x.de", text: "" });
		expect(dec.decode(raw)).not.toMatch(/^Bcc:/m);
		expect(encodeWord("plain")).toBe("plain");
	});
});

describe("smtp", () => {
	it("dot-stuffs and terminates", () => {
		expect(dec.decode(dotStuff(new TextEncoder().encode(".a\r\nb\r\n..c")))).toBe("..a\r\nb\r\n...c\r\n.\r\n");
	});

	it("runs EHLO, STARTTLS, AUTH, MAIL, RCPT, DATA", async () => {
		const tlsLog: string[] = [];
		let inData = false;
		const plain = fakeConnection((chunk, send) => {
			const line = dec.decode(chunk).trim();
			if (line.startsWith("EHLO")) send("250-postout.lrz.de\r\n250-STARTTLS\r\n250 8BITMIME\r\n");
			else if (line === "STARTTLS") send("220 Ready to start TLS\r\n");
		});
		plain.send("220 postout.lrz.de ESMTP\r\n");
		const tls = fakeConnection((chunk, send) => {
			const text = dec.decode(chunk);
			tlsLog.push(text);
			if (inData) {
				if (text.endsWith("\r\n.\r\n")) {
					inData = false;
					send("250 2.0.0 Ok: queued\r\n");
				}
				return;
			}
			const line = text.trim();
			if (line.startsWith("EHLO")) send("250-postout.lrz.de\r\n250 AUTH PLAIN LOGIN\r\n");
			else if (line.startsWith("AUTH PLAIN")) send("235 2.7.0 Authentication successful\r\n");
			else if (line.startsWith("MAIL FROM")) send("250 2.1.0 Ok\r\n");
			else if (line.startsWith("RCPT TO")) send("250 2.1.5 Ok\r\n");
			else if (line === "DATA") {
				inData = true;
				send("354 End data with <CR><LF>.<CR><LF>\r\n");
			} else if (line === "QUIT") send("221 Bye\r\n");
		});
		await smtpSession(plain.io, {
			user: "ge12abc",
			password: "pw",
			from: "max@tum.de",
			recipients: ["x@tum.de"],
			message: new TextEncoder().encode("Subject: t\r\n\r\nhi\r\n"),
			startTls: () => tls.io,
		});
		expect(plain.written()).toContain("STARTTLS");
		expect(plain.written()).not.toContain("AUTH");
		expect(tlsLog.join("")).toContain(`AUTH PLAIN ${btoa("\0ge12abc\0pw")}`);
		expect(tlsLog.join("")).toContain("RCPT TO:<x@tum.de>");
		expect(tlsLog.join("")).toContain("Subject: t\r\n\r\nhi\r\n.\r\n");
	});

	it("reports a failed AUTH as auth error", async () => {
		const c = fakeConnection((chunk, send) => {
			const line = dec.decode(chunk).trim();
			if (line.startsWith("EHLO")) send("250 ok\r\n");
			else if (line.startsWith("AUTH")) send("535 5.7.8 Authentication failed\r\n");
		});
		c.send("220 hi\r\n");
		await expect(smtpSession(c.io, { user: "u", password: "p", from: "", recipients: [], message: new Uint8Array() })).rejects.toMatchObject({
			kind: "auth",
			code: 535,
		});
	});
});

describe("mail flags", () => {
	it("maps names and refuses \\Deleted", () => {
		expect(normalizeFlag("seen")).toBe("\\Seen");
		expect(normalizeFlag("\\flagged")).toBe("\\Flagged");
		expect(normalizeFlag("$Label1")).toBe("$Label1");
		expect(() => normalizeFlag("\\Deleted")).toThrow();
		expect(() => normalizeFlag("a b")).toThrow();
	});
});
