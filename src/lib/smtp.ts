// Minimal SMTP submission client (RFC 5321, RFC 3207 STARTTLS, RFC 4954 AUTH PLAIN).

import { ByteReader, type Duplex, latin1, toBase64, utf8 } from "./bytes";

export class SmtpError extends Error {
	constructor(
		message: string,
		public code: number,
		public kind: "auth" | "protocol" | "rejected",
	) {
		super(message);
	}
}

export interface SmtpReply {
	code: number;
	lines: string[];
}

export interface SmtpSendOptions {
	user: string;
	password: string;
	from: string;
	recipients: string[];
	/** Full RFC 5322 message with CRLF line endings. */
	message: Uint8Array;
	/** Upgrades the plain connection to TLS. Omit only for tests or implicit TLS. */
	startTls?: () => Duplex;
	heloName?: string;
}

/** Dot-stuffing (RFC 5321, section 4.5.2) and the terminating "<CRLF>.<CRLF>". */
export function dotStuff(message: Uint8Array): Uint8Array {
	const out: number[] = [];
	let lineStart = true;
	for (let i = 0; i < message.length; i++) {
		const c = message[i];
		if (lineStart && c === 0x2e) out.push(0x2e);
		out.push(c);
		lineStart = c === 0x0a;
	}
	if (!(message.length >= 2 && message[message.length - 2] === 0x0d && message[message.length - 1] === 0x0a)) {
		out.push(0x0d, 0x0a);
	}
	out.push(0x2e, 0x0d, 0x0a);
	return new Uint8Array(out);
}

class SmtpConnection {
	reader: ByteReader;
	writer: WritableStreamDefaultWriter<Uint8Array>;

	constructor(public io: Duplex) {
		this.reader = new ByteReader(io.readable);
		this.writer = io.writable.getWriter();
	}

	async reply(): Promise<SmtpReply> {
		const lines: string[] = [];
		for (;;) {
			const line = latin1(await this.reader.readLine());
			const code = Number(line.slice(0, 3));
			lines.push(line.slice(4));
			if (line[3] !== "-") return { code, lines };
		}
	}

	async cmd(line: string): Promise<SmtpReply> {
		await this.writer.write(utf8(`${line}\r\n`));
		return this.reply();
	}

	release() {
		this.reader.release();
		try {
			this.writer.releaseLock();
		} catch {
			// ignore
		}
	}
}

function expect(r: SmtpReply, codes: number[], step: string): void {
	if (!codes.includes(r.code)) {
		const kind = step === "AUTH" ? "auth" : r.code >= 500 && step !== "greeting" ? "rejected" : "protocol";
		throw new SmtpError(`SMTP ${step} failed: ${r.code} ${r.lines.join(" ")}`, r.code, kind);
	}
}

/** Connects, authenticates and optionally sends. Without recipients it only tests the login. */
export async function smtpSession(io: Duplex, opts: SmtpSendOptions): Promise<void> {
	const helo = opts.heloName ?? "[127.0.0.1]";
	let conn = new SmtpConnection(io);
	try {
		expect(await conn.reply(), [220], "greeting");
		let ehlo = await conn.cmd(`EHLO ${helo}`);
		expect(ehlo, [250], "EHLO");
		if (opts.startTls) {
			if (!ehlo.lines.some((l) => /^STARTTLS\b/i.test(l))) {
				throw new SmtpError("Server does not offer STARTTLS", 0, "protocol");
			}
			expect(await conn.cmd("STARTTLS"), [220], "STARTTLS");
			conn.release();
			conn = new SmtpConnection(opts.startTls());
			ehlo = await conn.cmd(`EHLO ${helo}`);
			expect(ehlo, [250], "EHLO");
		}
		const auth = toBase64(utf8(`\0${opts.user}\0${opts.password}`));
		expect(await conn.cmd(`AUTH PLAIN ${auth}`), [235], "AUTH");

		if (opts.recipients.length) {
			expect(await conn.cmd(`MAIL FROM:<${opts.from}>`), [250], "MAIL FROM");
			for (const r of opts.recipients) {
				expect(await conn.cmd(`RCPT TO:<${r}>`), [250, 251], `RCPT TO <${r}>`);
			}
			expect(await conn.cmd("DATA"), [354], "DATA");
			await conn.writer.write(dotStuff(opts.message));
			expect(await conn.reply(), [250], "message transfer");
		}
		try {
			await conn.cmd("QUIT");
		} catch {
			// server may close first
		}
	} finally {
		conn.release();
		// Not awaited: closing a socket whose connect never finished can hang.
		const io = conn.io;
		void Promise.resolve()
			.then(() => io.close?.())
			.catch(() => undefined);
	}
}
