import type { Duplex } from "../src/lib/bytes";

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * In-memory duplex. `onData` receives every chunk the client writes and can answer
 * with `send`. Lets the protocol clients run against a scripted fake server.
 */
export function fakeConnection(onData: (chunk: Uint8Array, send: (s: string | Uint8Array) => void) => void): {
	io: Duplex;
	send: (s: string | Uint8Array) => void;
	written: () => string;
} {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	let log = "";
	const readable = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
	});
	const send = (s: string | Uint8Array) => controller.enqueue(typeof s === "string" ? enc.encode(s) : s);
	const writable = new WritableStream<Uint8Array>({
		write(chunk) {
			log += dec.decode(chunk);
			onData(chunk, send);
		},
	});
	return { io: { readable, writable, close: () => undefined }, send, written: () => log };
}

/** Collects client bytes into CRLF lines and IMAP literals, then calls `onCommand`. */
export function imapServer(handler: (tag: string, command: string, literals: Uint8Array[]) => string) {
	let buf = new Uint8Array(0);
	let pendingLine = "";
	let literalLeft = 0;
	let literalParts: number[] = [];
	const literals: Uint8Array[] = [];
	return fakeConnection((chunk, send) => {
		const merged = new Uint8Array(buf.length + chunk.length);
		merged.set(buf);
		merged.set(chunk, buf.length);
		buf = merged;
		for (;;) {
			if (literalLeft > 0) {
				const take = Math.min(literalLeft, buf.length);
				literalParts.push(...buf.subarray(0, take));
				buf = buf.subarray(take);
				literalLeft -= take;
				if (literalLeft > 0) return;
				literals.push(new Uint8Array(literalParts));
				literalParts = [];
				pendingLine += "<LITERAL>";
				continue;
			}
			const i = buf.indexOf(0x0a);
			if (i < 0) return;
			const line = dec.decode(buf.subarray(0, i)).replace(/\r$/, "");
			buf = buf.subarray(i + 1);
			const m = /\{(\d+)\}$/.exec(line);
			if (m) {
				pendingLine += line.slice(0, m.index);
				literalLeft = Number(m[1]);
				send("+ Ready for literal data\r\n");
				continue;
			}
			const full = pendingLine + line;
			pendingLine = "";
			const sp = full.indexOf(" ");
			const tag = full.slice(0, sp);
			const command = full.slice(sp + 1);
			send(handler(tag, command, literals.splice(0)));
		}
	});
}
