// Minimal IMAP4rev1 client (RFC 3501) for Workers. It runs over any Duplex, so the
// protocol logic is testable without sockets. Only the commands the mail tools need.

import { ByteReader, concatBytes, type Duplex, latin1, utf8 } from "./bytes";
import { fetchAttributes, type ImapValue, parseResponse, valueToString } from "./imap-parse";
import { decodeMailboxName, encodeMailboxName } from "./utf7";

export type ImapErrorKind = "auth" | "no" | "bad" | "protocol";

export class ImapError extends Error {
	constructor(
		message: string,
		public kind: ImapErrorKind,
	) {
		super(message);
	}
}

interface Literal {
	literal: Uint8Array;
}

type Arg = string | Literal;

export interface CommandResult {
	untagged: Uint8Array[];
	status: "OK" | "NO" | "BAD";
	text: string;
}

export interface MailboxInfo {
	name: string;
	encodedName: string;
	delimiter: string | null;
	flags: string[];
}

export interface FetchedMessage {
	seq: number;
	uid: number;
	attrs: Map<string, ImapValue>;
}

const LITERAL_RE = /\{(\d+)\+?\}$/;

/** Quotes an IMAP string argument. Non-ASCII or control characters go as a literal. */
export function imapString(s: string): Arg {
	if (/^[\x20-\x7e]*$/.test(s)) return `"${s.replace(/[\\"]/g, "\\$&")}"`;
	return { literal: utf8(s) };
}

export function mailboxArg(name: string): Arg {
	return imapString(encodeMailboxName(name));
}

/** Formats a date as IMAP date (e.g. 1-Feb-2026) for SEARCH SINCE/BEFORE. */
export function imapDate(d: Date): string {
	const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
	return `${d.getUTCDate()}-${m}-${d.getUTCFullYear()}`;
}

export function uidSet(uids: number[]): string {
	if (!uids.length) throw new ImapError("No UIDs given", "bad");
	for (const u of uids) {
		if (!Number.isInteger(u) || u <= 0) throw new ImapError(`Invalid UID: ${u}`, "bad");
	}
	return uids.join(",");
}

export class ImapClient {
	private reader: ByteReader;
	private writer: WritableStreamDefaultWriter<Uint8Array>;
	private tagCounter = 0;
	capabilities = new Set<string>();

	constructor(private io: Duplex) {
		this.reader = new ByteReader(io.readable);
		this.writer = io.writable.getWriter();
	}

	/** Reads one full response; literals are inlined into the returned bytes. */
	private async readResponse(): Promise<Uint8Array> {
		const parts: Uint8Array[] = [];
		let line = await this.reader.readLine();
		for (;;) {
			parts.push(line);
			const m = LITERAL_RE.exec(latin1(line.subarray(Math.max(0, line.length - 24))));
			if (!m) break;
			parts.push(utf8("\r\n"));
			parts.push(await this.reader.readBytes(Number(m[1])));
			line = await this.reader.readLine();
		}
		return parts.length === 1 ? parts[0] : concatBytes(parts);
	}

	async greeting(): Promise<void> {
		const r = latin1(await this.readResponse());
		if (r.startsWith("* BYE")) throw new ImapError(`Server refused connection: ${r}`, "protocol");
		if (!r.startsWith("* OK") && !r.startsWith("* PREAUTH")) {
			throw new ImapError(`Unexpected greeting: ${r.slice(0, 200)}`, "protocol");
		}
		this.parseCapabilityText(r);
	}

	private parseCapabilityText(text: string) {
		const m = /\[CAPABILITY ([^\]]*)\]/i.exec(text);
		if (m) this.setCapabilities(m[1]);
	}

	private setCapabilities(list: string) {
		this.capabilities = new Set(list.trim().toUpperCase().split(/\s+/));
	}

	async command(args: Arg[]): Promise<CommandResult> {
		const tag = `A${++this.tagCounter}`;
		const untagged: Uint8Array[] = [];
		let text = `${tag} `;
		for (let i = 0; i < args.length; i++) {
			const a = args[i];
			if (i > 0) text += " ";
			if (typeof a === "string") {
				text += a;
				continue;
			}
			// Synchronizing literal: send the size, wait for "+", then send the data.
			text += `{${a.literal.length}}\r\n`;
			await this.writer.write(utf8(text));
			text = "";
			for (;;) {
				const r = await this.readResponse();
				if (r[0] === 0x2b) break; // "+"
				const s = latin1(r);
				if (s.startsWith(`${tag} `)) {
					const status = s.slice(tag.length + 1, tag.length + 4).trim();
					throw new ImapError(`Server rejected literal: ${s}`, status === "NO" ? "no" : "bad");
				}
				untagged.push(r);
			}
			await this.writer.write(a.literal);
		}
		await this.writer.write(utf8(`${text}\r\n`));

		for (;;) {
			const r = await this.readResponse();
			if (r[0] === 0x2b) continue;
			const head = latin1(r.subarray(0, Math.min(r.length, 512)));
			if (head.startsWith(`${tag} `)) {
				const rest = head.slice(tag.length + 1);
				const status = rest.slice(0, 3).trim().toUpperCase();
				const result: CommandResult = {
					untagged,
					status: status === "OK" ? "OK" : status === "NO" ? "NO" : "BAD",
					text: rest.slice(3).trim(),
				};
				this.parseCapabilityText(rest);
				return result;
			}
			untagged.push(r);
		}
	}

	async ok(args: Arg[]): Promise<CommandResult> {
		const r = await this.command(args);
		if (r.status !== "OK") {
			const cmd = typeof args[0] === "string" ? args[0] : "command";
			throw new ImapError(`${cmd} failed: ${r.status} ${r.text}`, r.status === "NO" ? "no" : "bad");
		}
		return r;
	}

	async login(user: string, password: string): Promise<void> {
		const r = await this.command(["LOGIN", imapString(user), imapString(password)]);
		if (r.status !== "OK") throw new ImapError(`Login failed: ${r.text}`, "auth");
		if (!/\[CAPABILITY /i.test(r.text)) await this.capability();
	}

	async capability(): Promise<void> {
		const r = await this.ok(["CAPABILITY"]);
		for (const u of r.untagged) {
			const s = latin1(u);
			if (/^\* CAPABILITY /i.test(s)) this.setCapabilities(s.slice(13));
		}
	}

	async list(): Promise<MailboxInfo[]> {
		let r: CommandResult;
		if (this.capabilities.has("SPECIAL-USE")) {
			r = await this.command(["LIST", '""', '"*"', "RETURN", "(SPECIAL-USE)"]);
			if (r.status !== "OK") r = await this.ok(["LIST", '""', '"*"']);
		} else {
			r = await this.ok(["LIST", '""', '"*"']);
		}
		const out: MailboxInfo[] = [];
		for (const u of r.untagged) {
			const v = parseResponse(u);
			if (v[0] !== "*" || typeof v[1] !== "string" || v[1].toUpperCase() !== "LIST") continue;
			const flags = Array.isArray(v[2]) ? v[2].filter((f): f is string => typeof f === "string") : [];
			const delimiter = valueToString(v[3]);
			const encodedName = valueToString(v[4]) ?? "";
			out.push({ name: decodeMailboxName(encodedName), encodedName, delimiter, flags });
		}
		return out;
	}

	async status(mailbox: string): Promise<{ messages?: number; unseen?: number }> {
		const r = await this.ok(["STATUS", mailboxArg(mailbox), "(MESSAGES UNSEEN)"]);
		for (const u of r.untagged) {
			const v = parseResponse(u);
			if (v[0] === "*" && typeof v[1] === "string" && v[1].toUpperCase() === "STATUS" && Array.isArray(v[3])) {
				const attrs = fetchAttributes(v[3]);
				return {
					messages: Number(valueToString(attrs.get("MESSAGES")) ?? NaN),
					unseen: Number(valueToString(attrs.get("UNSEEN")) ?? NaN),
				};
			}
		}
		return {};
	}

	async select(mailbox: string, readOnly = true): Promise<{ exists: number; uidValidity?: number; uidNext?: number }> {
		const r = await this.command([readOnly ? "EXAMINE" : "SELECT", mailboxArg(mailbox)]);
		if (r.status !== "OK") throw new ImapError(`Cannot open folder "${mailbox}": ${r.text}`, "no");
		let exists = 0;
		let uidValidity: number | undefined;
		let uidNext: number | undefined;
		for (const u of r.untagged) {
			const s = latin1(u);
			const m = /^\* (\d+) EXISTS/i.exec(s);
			if (m) exists = Number(m[1]);
			const v = /\[UIDVALIDITY (\d+)\]/i.exec(s);
			if (v) uidValidity = Number(v[1]);
			const n = /\[UIDNEXT (\d+)\]/i.exec(s);
			if (n) uidNext = Number(n[1]);
		}
		return { exists, uidValidity, uidNext };
	}

	/** criteria: already formatted search keys, e.g. ["UNSEEN", "FROM", imapString("x")] */
	async uidSearch(criteria: Arg[]): Promise<number[]> {
		const needsCharset = criteria.some((c) => typeof c !== "string");
		const args: Arg[] = ["UID", "SEARCH"];
		if (needsCharset) args.push("CHARSET", "UTF-8");
		args.push(...(criteria.length ? criteria : ["ALL"]));
		const r = await this.ok(args);
		const uids: number[] = [];
		for (const u of r.untagged) {
			const s = latin1(u);
			if (/^\* SEARCH/i.test(s)) {
				for (const n of s.slice(8).trim().split(/\s+/)) if (n) uids.push(Number(n));
			}
		}
		return uids.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
	}

	async uidFetch(uids: number[], items: string): Promise<FetchedMessage[]> {
		const r = await this.ok(["UID", "FETCH", uidSet(uids), items]);
		const out: FetchedMessage[] = [];
		for (const u of r.untagged) {
			const v = parseResponse(u);
			if (v[0] !== "*" || typeof v[2] !== "string" || v[2].toUpperCase() !== "FETCH" || !Array.isArray(v[3])) continue;
			const attrs = fetchAttributes(v[3]);
			const uid = Number(valueToString(attrs.get("UID")));
			if (!Number.isFinite(uid)) continue;
			out.push({ seq: Number(v[1]), uid, attrs });
		}
		return out;
	}

	async uidStore(uids: number[], mode: "+FLAGS.SILENT" | "-FLAGS.SILENT", flags: string[]): Promise<void> {
		await this.ok(["UID", "STORE", uidSet(uids), mode, `(${flags.join(" ")})`]);
	}

	/** Moves messages. Returns a warning if the server can only copy and flag. */
	async uidMove(uids: number[], destination: string): Promise<string | undefined> {
		if (this.capabilities.has("MOVE")) {
			await this.ok(["UID", "MOVE", uidSet(uids), mailboxArg(destination)]);
			return undefined;
		}
		await this.ok(["UID", "COPY", uidSet(uids), mailboxArg(destination)]);
		await this.uidStore(uids, "+FLAGS.SILENT", ["\\Deleted"]);
		if (this.capabilities.has("UIDPLUS")) {
			await this.ok(["UID", "EXPUNGE", uidSet(uids)]);
			return undefined;
		}
		return "Server has no MOVE or UIDPLUS. Messages were copied and flagged \\Deleted in the source folder, but not expunged.";
	}

	async create(mailbox: string): Promise<void> {
		await this.ok(["CREATE", mailboxArg(mailbox)]);
	}

	async rename(from: string, to: string): Promise<void> {
		await this.ok(["RENAME", mailboxArg(from), mailboxArg(to)]);
	}

	async deleteMailbox(mailbox: string): Promise<void> {
		await this.ok(["DELETE", mailboxArg(mailbox)]);
	}

	async append(mailbox: string, flags: string[], message: Uint8Array): Promise<void> {
		await this.ok(["APPEND", mailboxArg(mailbox), `(${flags.join(" ")})`, { literal: message }]);
	}

	async logout(): Promise<void> {
		try {
			await this.command(["LOGOUT"]);
		} catch {
			// the server may close the connection right after BYE
		}
		await this.close();
	}

	async close(): Promise<void> {
		this.reader.release();
		try {
			this.writer.releaseLock();
		} catch {
			// ignore
		}
		// Not awaited: closing a socket whose connect never finished can hang.
		void Promise.resolve()
			.then(() => this.io.close?.())
			.catch(() => undefined);
	}
}
