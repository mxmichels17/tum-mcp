// Tokenizer for IMAP response data (RFC 3501, section 4 and 9).
// A response is the full logical line with literals inlined as "{n}\r\n<n bytes>".

import { decodeUtf8, latin1 } from "./bytes";

/** atom or quoted string: string, literal: Uint8Array, NIL: null, parenthesized list: array */
export type ImapValue = string | Uint8Array | null | ImapValue[];

const SP = 0x20;
const LPAREN = 0x28;
const RPAREN = 0x29;
const DQUOTE = 0x22;
const BACKSLASH = 0x5c;
const LBRACE = 0x7b;
const RBRACE = 0x7d;
const LBRACKET = 0x5b;
const RBRACKET = 0x5d;
const CR = 0x0d;
const LF = 0x0a;

export function parseResponse(b: Uint8Array): ImapValue[] {
	const p = new Parser(b);
	return p.parseSequence(false);
}

class Parser {
	pos = 0;
	constructor(private b: Uint8Array) {}

	parseSequence(inList: boolean): ImapValue[] {
		const out: ImapValue[] = [];
		while (this.pos < this.b.length) {
			const c = this.b[this.pos];
			if (c === SP || c === CR || c === LF) {
				this.pos++;
				continue;
			}
			if (c === RPAREN) {
				if (inList) {
					this.pos++;
					return out;
				}
				this.pos++;
				continue;
			}
			out.push(this.parseValue());
		}
		return out;
	}

	parseValue(): ImapValue {
		const c = this.b[this.pos];
		if (c === LPAREN) {
			this.pos++;
			return this.parseSequence(true);
		}
		if (c === DQUOTE) return this.parseQuoted();
		if (c === LBRACE) {
			const lit = this.tryLiteral();
			if (lit) return lit;
		}
		const atom = this.parseAtom();
		return atom.toUpperCase() === "NIL" ? null : atom;
	}

	parseQuoted(): string {
		this.pos++;
		const bytes: number[] = [];
		while (this.pos < this.b.length) {
			const c = this.b[this.pos++];
			if (c === BACKSLASH && this.pos < this.b.length) {
				bytes.push(this.b[this.pos++]);
			} else if (c === DQUOTE) {
				break;
			} else {
				bytes.push(c);
			}
		}
		return decodeUtf8(new Uint8Array(bytes));
	}

	tryLiteral(): Uint8Array | null {
		let i = this.pos + 1;
		let n = 0;
		let digits = 0;
		while (i < this.b.length && this.b[i] >= 0x30 && this.b[i] <= 0x39) {
			n = n * 10 + (this.b[i] - 0x30);
			i++;
			digits++;
		}
		if (digits === 0) return null;
		if (this.b[i] === 0x2b) i++; // LITERAL+ marker
		if (this.b[i] !== RBRACE) return null;
		i++;
		if (this.b[i] === CR) i++;
		if (this.b[i] === LF) i++;
		const data = this.b.slice(i, i + n);
		this.pos = i + n;
		return data;
	}

	parseAtom(): string {
		const start = this.pos;
		let depth = 0;
		while (this.pos < this.b.length) {
			const c = this.b[this.pos];
			if (c === LBRACKET) depth++;
			else if (c === RBRACKET) depth = Math.max(0, depth - 1);
			else if (depth === 0 && (c === SP || c === LPAREN || c === RPAREN || c === CR || c === LF)) break;
			this.pos++;
		}
		if (this.pos === start) {
			// unexpected character, skip it to guarantee progress
			this.pos++;
			return latin1(this.b.subarray(start, this.pos));
		}
		return latin1(this.b.subarray(start, this.pos));
	}
}

export function valueToString(v: ImapValue | undefined): string | null {
	if (v === null || v === undefined) return null;
	if (typeof v === "string") return v;
	if (v instanceof Uint8Array) return decodeUtf8(v);
	return null;
}

export function valueToBytes(v: ImapValue | undefined): Uint8Array | null {
	if (v === null || v === undefined) return null;
	if (v instanceof Uint8Array) return v;
	if (typeof v === "string") return new TextEncoder().encode(v);
	return null;
}

/** Turns a FETCH attribute list into a map with upper-cased keys. */
export function fetchAttributes(list: ImapValue[]): Map<string, ImapValue> {
	const m = new Map<string, ImapValue>();
	for (let i = 0; i + 1 < list.length; i += 2) {
		const k = list[i];
		if (typeof k === "string") m.set(k.toUpperCase(), list[i + 1]);
	}
	return m;
}
