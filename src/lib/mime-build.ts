// Builds RFC 5322 / MIME messages (text/plain body plus optional attachments).
// Everything is 7-bit: headers use RFC 2047 encoded words, bodies use base64.

import { toBase64, utf8 } from "./bytes";

export interface MailAddress {
	name?: string;
	address: string;
}

export interface OutgoingAttachment {
	filename: string;
	mimeType: string;
	content: Uint8Array;
}

export interface OutgoingMessage {
	from: MailAddress;
	to: MailAddress[];
	cc?: MailAddress[];
	subject: string;
	text: string;
	inReplyTo?: string;
	references?: string[];
	attachments?: OutgoingAttachment[];
	date?: Date;
	messageId?: string;
}

const ADDRESS_RE = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;

export function isValidAddress(a: string): boolean {
	return ADDRESS_RE.test(a);
}

/** Parses "Name <a@b.c>" or "a@b.c". */
export function parseAddress(input: string): MailAddress {
	const s = input.trim();
	const m = /^(.*)<([^<>]+)>$/.exec(s);
	const address = (m ? m[2] : s).trim();
	const name = m ? m[1].trim().replace(/^"(.*)"$/, "$1") : undefined;
	if (!isValidAddress(address)) throw new Error(`Invalid email address: ${input}`);
	return name ? { name, address } : { address };
}

function hasNonAscii(s: string): boolean {
	return /[^\x20-\x7e]/.test(s);
}

/** RFC 2047 B-encoding, split so each encoded word stays below 76 characters. */
export function encodeWord(s: string): string {
	if (!hasNonAscii(s)) return s;
	const words: string[] = [];
	let chunk: number[] = [];
	for (const ch of s) {
		const bytes = utf8(ch);
		if (chunk.length + bytes.length > 45) {
			words.push(`=?UTF-8?B?${toBase64(new Uint8Array(chunk))}?=`);
			chunk = [];
		}
		chunk.push(...bytes);
	}
	if (chunk.length) words.push(`=?UTF-8?B?${toBase64(new Uint8Array(chunk))}?=`);
	return words.join("\r\n ");
}

export function formatAddress(a: MailAddress): string {
	if (!a.name) return a.address;
	const name = hasNonAscii(a.name)
		? encodeWord(a.name)
		: /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]*$/.test(a.name)
			? a.name
			: `"${a.name.replace(/[\\"]/g, "\\$&")}"`;
	return `${name} <${a.address}>`;
}

function formatAddressList(list: MailAddress[]): string {
	return list.map(formatAddress).join(",\r\n ");
}

/** RFC 5322 date, always in UTC. */
export function formatDate(d: Date): string {
	const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
	const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	const p = (n: number) => String(n).padStart(2, "0");
	return `${days[d.getUTCDay()]}, ${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

function base64Lines(b: Uint8Array): string {
	return (toBase64(b).match(/.{1,76}/g) ?? []).join("\r\n");
}

function normalizeNewlines(s: string): string {
	return s.replace(/\r\n|\r|\n/g, "\r\n");
}

function filenameParams(filename: string): string {
	const safe = filename.replace(/[\r\n"\\]/g, "_");
	if (!hasNonAscii(safe)) return `filename="${safe}"`;
	// RFC 2231 form for standard clients plus an RFC 2047 encoded word, which Outlook reads.
	const encoded = encodeURIComponent(safe).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
	return `filename*=UTF-8''${encoded};\r\n filename="${encodeWord(safe).replace(/\r\n /g, " ")}"`;
}

function sanitizeHeader(s: string): string {
	return s.replace(/[\r\n]+/g, " ");
}

export function newMessageId(from: string): string {
	const domain = from.split("@")[1] ?? "localhost";
	return `<${crypto.randomUUID()}@${domain}>`;
}

export function buildMessage(msg: OutgoingMessage): { raw: Uint8Array; messageId: string } {
	const messageId = msg.messageId ?? newMessageId(msg.from.address);
	const headers: string[] = [
		`From: ${formatAddress(msg.from)}`,
		`To: ${formatAddressList(msg.to)}`,
	];
	if (msg.cc?.length) headers.push(`Cc: ${formatAddressList(msg.cc)}`);
	headers.push(
		`Subject: ${encodeWord(sanitizeHeader(msg.subject))}`,
		`Date: ${formatDate(msg.date ?? new Date())}`,
		`Message-ID: ${messageId}`,
	);
	if (msg.inReplyTo) headers.push(`In-Reply-To: ${sanitizeHeader(msg.inReplyTo)}`);
	if (msg.references?.length) headers.push(`References: ${msg.references.map(sanitizeHeader).join("\r\n ")}`);
	headers.push("MIME-Version: 1.0");

	const textPart = [
		"Content-Type: text/plain; charset=utf-8",
		"Content-Transfer-Encoding: base64",
		"",
		base64Lines(utf8(normalizeNewlines(msg.text))),
	].join("\r\n");

	let body: string;
	if (!msg.attachments?.length) {
		headers.push("Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64");
		body = base64Lines(utf8(normalizeNewlines(msg.text)));
	} else {
		const boundary = `=_tum-mcp_${crypto.randomUUID().replace(/-/g, "")}`;
		headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
		const parts = [textPart];
		for (const a of msg.attachments) {
			const mime = /^[\w.+-]+\/[\w.+-]+$/.test(a.mimeType) ? a.mimeType : "application/octet-stream";
			parts.push(
				[
					`Content-Type: ${mime}`,
					"Content-Transfer-Encoding: base64",
					`Content-Disposition: attachment; ${filenameParams(a.filename)}`,
					"",
					base64Lines(a.content),
				].join("\r\n"),
			);
		}
		body = `This is a multipart message in MIME format.\r\n\r\n${parts.map((p) => `--${boundary}\r\n${p}\r\n`).join("")}--${boundary}--\r\n`;
	}

	const raw = `${headers.join("\r\n")}\r\n\r\n${body}${body.endsWith("\r\n") ? "" : "\r\n"}`;
	return { raw: utf8(raw), messageId };
}
