// Byte helpers and a buffered line reader for line-based protocols (IMAP, SMTP).

const encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8");

export function utf8(s: string): Uint8Array {
	return encoder.encode(s);
}

export function decodeUtf8(b: Uint8Array): string {
	return utf8Decoder.decode(b);
}

/** Decodes bytes 1:1 to char codes. Safe for protocol lines that are ASCII by spec. */
export function latin1(b: Uint8Array): string {
	let s = "";
	for (let i = 0; i < b.length; i += 0x8000) {
		s += String.fromCharCode(...b.subarray(i, i + 0x8000));
	}
	return s;
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
	let len = 0;
	for (const p of parts) len += p.length;
	const out = new Uint8Array(len);
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
}

export function toBase64(b: Uint8Array): string {
	let s = "";
	for (let i = 0; i < b.length; i += 0x8000) {
		s += String.fromCharCode(...b.subarray(i, i + 0x8000));
	}
	return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
	const bin = atob(s.replace(/\s+/g, ""));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** A readable/writable byte stream pair, e.g. a TCP socket from cloudflare:sockets. */
export interface Duplex {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
	close?: () => Promise<void> | void;
}

export class ConnectionClosedError extends Error {
	constructor() {
		super("Connection closed by server");
	}
}

/**
 * Buffered reader over a ReadableStream. Grows its buffer geometrically, so reading
 * large literals (whole messages) stays linear.
 */
export class ByteReader {
	private reader: ReadableStreamDefaultReader<Uint8Array>;
	private buf = new Uint8Array(64 * 1024);
	private start = 0;
	private end = 0;
	private scanFrom = 0;
	private eof = false;

	constructor(readable: ReadableStream<Uint8Array>) {
		this.reader = readable.getReader();
	}

	private append(chunk: Uint8Array) {
		const live = this.end - this.start;
		if (this.end + chunk.length > this.buf.length) {
			if (live + chunk.length <= this.buf.length && this.start > 0) {
				this.buf.copyWithin(0, this.start, this.end);
			} else {
				const next = new Uint8Array(Math.max(this.buf.length * 2, live + chunk.length));
				next.set(this.buf.subarray(this.start, this.end));
				this.buf = next;
			}
			this.scanFrom -= this.start;
			this.start = 0;
			this.end = live;
		}
		this.buf.set(chunk, this.end);
		this.end += chunk.length;
	}

	private async fill(): Promise<void> {
		if (this.eof) throw new ConnectionClosedError();
		const { value, done } = await this.reader.read();
		if (done) {
			this.eof = true;
			throw new ConnectionClosedError();
		}
		if (value && value.length) this.append(value);
	}

	/** Reads one line and returns it without the trailing CRLF (a bare LF is accepted too). */
	async readLine(): Promise<Uint8Array> {
		for (;;) {
			for (let i = Math.max(this.start, this.scanFrom); i < this.end; i++) {
				if (this.buf[i] === 0x0a) {
					const lineEnd = i > this.start && this.buf[i - 1] === 0x0d ? i - 1 : i;
					const line = this.buf.slice(this.start, lineEnd);
					this.start = i + 1;
					this.scanFrom = this.start;
					return line;
				}
			}
			this.scanFrom = this.end;
			await this.fill();
		}
	}

	async readBytes(n: number): Promise<Uint8Array> {
		while (this.end - this.start < n) await this.fill();
		const out = this.buf.slice(this.start, this.start + n);
		this.start += n;
		this.scanFrom = this.start;
		return out;
	}

	release() {
		try {
			this.reader.releaseLock();
		} catch {
			// already released
		}
	}
}
