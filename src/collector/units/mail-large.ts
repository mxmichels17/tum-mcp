// Unit "mail-large": reads mails larger than 25 MB completely, part by part, over several invocations.
// A whole large mail does not fit one invocation: Workers have 128 MB memory, and the Free plan allows
// 10 ms CPU per invocation, while decoding a large base64 attachment takes far longer. So each invocation
// reads at most RAW_BUDGET bytes of the mail with IMAP partial fetches (BODY.PEEK[section]<offset.length>,
// nothing is marked as read), decodes them and writes them to R2 as parts of a multipart upload.
// R2 needs all parts except the last to have the same size, so the decoded bytes that do not fill a part
// wait in R2 for the next invocation. The finished mail goes to R2 (largeDoneKey); the unit "mail" then
// reports it like any other mail.

import PostalMime, { type Email } from "postal-mime";
import { concatBytes, fromBase64, latin1, utf8 } from "../../lib/bytes";
import { htmlToText } from "../../lib/html";
import { type ImapValue, valueToBytes, valueToString } from "../../lib/imap-parse";
import { withImap } from "../../platforms/mail";
import { linkOnly, storeBytes } from "../files";
import { type FileRef, hash64, isVideo, MAX_FILE_BYTES } from "../model";
import { getState, setState } from "../store";
import type { UnitCtx } from "../unit";
import { LARGE_QUEUE, type LargeMailJob, largeDoneKey, mailContent, mailUrl } from "./mail";

/** Leaves up to this encoded size are fetched in one piece and parsed with postal-mime. */
const SMALL_PART = 5 * 1024 * 1024;
/** Encoded bytes read per invocation (memory and CPU of one invocation). */
const RAW_BUDGET = 6 * 1024 * 1024;
/** R2 multipart part size. All parts except the last have exactly this size. */
export const PART_SIZE = 5 * 1024 * 1024;
const TIME_MS = 20_000;

export interface Leaf {
	section: string;
	type: string;
	subtype: string;
	params: Record<string, string>;
	encoding: string;
	size: number;
	disposition: string | null;
	dispParams: Record<string, string>;
}

const str = (v: ImapValue | undefined) => valueToString(v) ?? "";

function pairs(v: ImapValue | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (!Array.isArray(v)) return out;
	for (let i = 0; i + 1 < v.length; i += 2) out[str(v[i]).toLowerCase()] = str(v[i + 1]);
	return out;
}

/** The leaf parts of a BODYSTRUCTURE (RFC 3501 section 7.4.2) with their section numbers. A message/rfc822 part is one leaf. */
export function parseBodyStructure(v: ImapValue, prefix = ""): Leaf[] {
	if (!Array.isArray(v)) return [];
	if (Array.isArray(v[0])) {
		const out: Leaf[] = [];
		for (let i = 0; i < v.length && Array.isArray(v[i]); i++) out.push(...parseBodyStructure(v[i], prefix ? `${prefix}.${i + 1}` : String(i + 1)));
		return out;
	}
	const type = str(v[0]).toLowerCase();
	const subtype = str(v[1]).toLowerCase();
	// Extension data starts after the type-specific fields.
	const ext = type === "text" ? 8 : type === "message" && subtype === "rfc822" ? 10 : 7;
	const disp = v[ext + 1];
	return [
		{
			section: prefix || "1",
			type,
			subtype,
			params: pairs(v[2]),
			encoding: str(v[5]).toLowerCase(),
			size: Number(str(v[6])) || 0,
			disposition: Array.isArray(disp) ? str(disp[0]).toLowerCase() : null,
			dispParams: Array.isArray(disp) ? pairs(disp[1]) : {},
		},
	];
}

export function leafName(l: Leaf): string {
	return l.dispParams.filename || l.params.name || (l.type === "message" ? "message.eml" : `part-${l.section}`);
}

/** Decodes a transfer encoding chunk by chunk. `carry` holds the bytes of an unfinished unit for the next chunk. */
export function decodeChunk(encoding: string, chunk: Uint8Array, carry: string, final: boolean): { bytes: Uint8Array; carry: string } {
	if (encoding === "base64") {
		const s = carry + latin1(chunk).replace(/[^A-Za-z0-9+/=]/g, "");
		const keep = final ? 0 : s.length % 4;
		const body = s.slice(0, s.length - keep);
		return { bytes: body ? fromBase64(body) : new Uint8Array(0), carry: s.slice(s.length - keep) };
	}
	if (encoding === "quoted-printable") {
		let s = carry + latin1(chunk);
		let next = "";
		if (!final) {
			const at = s.lastIndexOf("=", s.length - 1);
			if (at >= 0 && at >= s.length - 3) {
				next = s.slice(at);
				s = s.slice(0, at);
			}
		}
		const t = s.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(Number.parseInt(h, 16)));
		const out = new Uint8Array(t.length);
		for (let i = 0; i < t.length; i++) out[i] = t.charCodeAt(i) & 0xff;
		return { bytes: out, carry: next };
	}
	return { bytes: chunk, carry: "" };
}

interface Streaming {
	section: string;
	offset: number;
	carry: string;
	uploadId: string;
	r2Key: string;
	parts: { partNumber: number; etag: string }[];
	total: number;
}

interface Progress {
	leaves?: Leaf[];
	next: number;
	current?: Streaming;
	failures?: number;
}

/** After this many failed invocations the mail is reported with the error instead of its body. */
const MAX_FAILURES = 5;

interface Result {
	header?: string;
	text: string[];
	html: string[];
	files: FileRef[];
}

const progressKey = (key: string) => `mail:large:job:${key}`;
const resultKey = (key: string) => `mailbig/${hash64(key)}/result.json`;
const restKey = (key: string, section: string) => `mailbig/${hash64(key)}/rest-${section}`;

function sectionBytes(attrs: Map<string, ImapValue>, name: string): Uint8Array | null {
	for (const [k, v] of attrs) if (k === name.toUpperCase() || k.startsWith(`${name.toUpperCase()}<`)) return valueToBytes(v);
	return null;
}

export async function unitMailLarge(ctx: UnitCtx): Promise<void> {
	const { env } = ctx;
	const queue = (await getState<LargeMailJob[]>(env.DB, LARGE_QUEUE)) ?? [];
	const job = queue[0];
	if (!job) return;
	const started = Date.now();
	const p: Progress = (await getState<Progress>(env.DB, progressKey(job.key))) ?? { next: 0 };
	const stored = await env.FILES.get(resultKey(job.key));
	const res: Result = stored ? (JSON.parse(await stored.text()) as Result) : { text: [], html: [], files: [] };
	const url = mailUrl(job.folder, job.uidValidity, job.uid);
	const drop = async (why: string) => {
		ctx.note(`${job.key}: ${why}`);
		await setState(env.DB, LARGE_QUEUE, queue.slice(1));
		await env.DB.prepare("DELETE FROM state WHERE key = ?").bind(progressKey(job.key)).run();
	};

	try {
		await readJob(ctx, job, queue, p, res, url, started, drop);
	} catch (e) {
		p.failures = (p.failures ?? 0) + 1;
		const why = e instanceof Error ? e.message : String(e);
		if (p.failures < MAX_FAILURES) {
			await setState(env.DB, progressKey(job.key), p);
			throw e;
		}
		await env.FILES.put(largeDoneKey(job.key), JSON.stringify({ title: "", content: { folder: job.folder, uid: job.uid, uid_validity: job.uidValidity, size: job.size, not_read: `failed ${p.failures} times: ${why}` }, html: null }));
		await drop(`given up after ${p.failures} failures: ${why}`);
	}
}

async function readJob(ctx: UnitCtx, job: LargeMailJob, queue: LargeMailJob[], p: Progress, res: Result, url: string, started: number, drop: (why: string) => Promise<void>): Promise<void> {
	const { env } = ctx;
	let read = 0;
	await withImap(env, async (c) => {
		const sel = await c.select(job.folder, true).catch(() => undefined);
		if (!sel || (sel.uidValidity ?? 0) !== job.uidValidity) return drop("folder gone or UIDVALIDITY changed");
		if (!p.leaves) {
			const f = (await c.uidFetch([job.uid], "(UID BODYSTRUCTURE BODY.PEEK[HEADER])"))[0];
			if (!f) return drop("mail not found");
			p.leaves = parseBodyStructure(f.attrs.get("BODYSTRUCTURE") ?? null);
			res.header = latin1(sectionBytes(f.attrs, "BODY[HEADER]") ?? new Uint8Array(0));
		}
		const leaves = p.leaves;
		const single = leaves.length === 1 && leaves[0].section === "1";
		while (p.next < leaves.length && read < RAW_BUDGET && Date.now() - started < TIME_MS) {
			const l = leaves[p.next];
			const name = leafName(l);
			const fileUrl = `${url};section=${l.section}`;
			if (l.size <= SMALL_PART) {
				// One small part: its MIME header and body as a message of its own, parsed by postal-mime.
				const items = single ? `(UID BODY.PEEK[1])` : `(UID BODY.PEEK[${l.section}.MIME] BODY.PEEK[${l.section}])`;
				const f = (await c.uidFetch([job.uid], items))[0];
				if (!f) return drop("mail not found");
				const head = single ? (res.header ?? "") : latin1(sectionBytes(f.attrs, `BODY[${l.section}.MIME]`) ?? new Uint8Array(0));
				const body = sectionBytes(f.attrs, `BODY[${l.section}]`) ?? new Uint8Array(0);
				read += body.byteLength;
				const part = await PostalMime.parse(concatBytes([utf8(`${head.replace(/(\r?\n)+$/, "")}\r\n\r\n`), body]), { attachmentEncoding: "arraybuffer" });
				if (part.text !== undefined && !part.attachments.length) res.text.push(part.text);
				if (part.html !== undefined && !part.attachments.length) res.html.push(part.html);
				for (const a of part.attachments) {
					const bytes = a.content instanceof ArrayBuffer ? new Uint8Array(a.content) : typeof a.content === "string" ? utf8(a.content) : new Uint8Array(a.content);
					res.files.push({ ...(await storeBytes(env, { name: a.filename ?? name, mime: a.mimeType ?? `${l.type}/${l.subtype}`, url: fileUrl, bytes })), section: l.section } as FileRef);
				}
				p.next++;
				continue;
			}
			const mime = `${l.type}/${l.subtype}`;
			const decodedEstimate = l.encoding === "base64" ? Math.floor((l.size * 3) / 4) : l.size;
			if (isVideo(name) || isVideo(mime)) {
				res.files.push({ ...linkOnly(name, fileUrl, "video (only the link is kept)", decodedEstimate, mime), section: l.section } as FileRef);
				p.next++;
				continue;
			}
			if (decodedEstimate > MAX_FILE_BYTES * 1.02) {
				res.files.push({ ...linkOnly(name, fileUrl, "larger than 100 MB (only the link is kept)", decodedEstimate, mime), section: l.section } as FileRef);
				p.next++;
				continue;
			}
			// A large part: streamed into an R2 multipart upload.
			const r2Key = `files/mail/${hash64(job.key)}/${l.section}`;
			if (!p.current || p.current.section !== l.section) {
				const up = await env.FILES.createMultipartUpload(r2Key, { httpMetadata: { contentType: mime }, customMetadata: { name, url: fileUrl } });
				p.current = { section: l.section, offset: 0, carry: "", uploadId: up.uploadId, r2Key, parts: [], total: 0 };
			}
			const cur = p.current;
			const up = env.FILES.resumeMultipartUpload(r2Key, cur.uploadId);
			const want = Math.min(RAW_BUDGET - read, l.size - cur.offset);
			const f = (await c.uidFetch([job.uid], `(UID BODY.PEEK[${l.section}]<${cur.offset}.${Math.max(1, want)}>)`))[0];
			if (!f) return drop("mail not found");
			const chunk = sectionBytes(f.attrs, `BODY[${l.section}]`) ?? new Uint8Array(0);
			read += chunk.byteLength;
			const final = cur.offset + chunk.byteLength >= l.size || chunk.byteLength === 0;
			const dec = decodeChunk(l.encoding, chunk, cur.carry, final);
			const restObj = await env.FILES.get(restKey(job.key, l.section));
			let buf = restObj ? concatBytes([new Uint8Array(await restObj.arrayBuffer()), dec.bytes]) : dec.bytes;
			while (buf.byteLength >= PART_SIZE) {
				const part = await up.uploadPart(cur.parts.length + 1, buf.slice(0, PART_SIZE));
				cur.parts.push({ partNumber: part.partNumber, etag: part.etag });
				cur.total += PART_SIZE;
				buf = buf.slice(PART_SIZE);
			}
			cur.offset += chunk.byteLength;
			cur.carry = dec.carry;
			if (!final) {
				await env.FILES.put(restKey(job.key, l.section), buf);
				continue;
			}
			if (buf.byteLength || !cur.parts.length) {
				const part = await up.uploadPart(cur.parts.length + 1, buf);
				cur.parts.push({ partNumber: part.partNumber, etag: part.etag });
				cur.total += buf.byteLength;
			}
			await up.complete(cur.parts);
			await env.FILES.delete(restKey(job.key, l.section));
			const ref: FileRef = { name, mime_type: mime, size: cur.total, url: fileUrl, r2_key: r2Key };
			res.files.push({ ...ref, section: l.section } as FileRef);
			p.current = undefined;
			p.next++;
		}

		if (p.next < leaves.length) {
			await env.FILES.put(resultKey(job.key), JSON.stringify(res));
			await setState(env.DB, progressKey(job.key), p);
			ctx.note(`${job.key}: part ${p.next + 1} of ${leaves.length} next`);
			return;
		}
		// Done: the mail in the same form as a mail read in one piece.
		const header: Email = await PostalMime.parse(`${res.header ?? ""}\r\n`);
		const html = res.html.length ? res.html.join("\n") : null;
		const text = res.text.length ? res.text.join("\n\n") : html ? htmlToText(html) : "";
		const content = mailContent({ folder: job.folder, uid: job.uid, uidValidity: job.uidValidity, size: job.size }, header, { text, html: !!html, textFromHtml: !res.text.length && !!html }, res.files);
		await env.FILES.put(largeDoneKey(job.key), JSON.stringify({ title: header.subject?.trim() ?? "", content: { ...content, read_in_parts: true }, html }));
		await env.FILES.delete(resultKey(job.key));
		await setState(env.DB, LARGE_QUEUE, queue.slice(1));
		await env.DB.prepare("DELETE FROM state WHERE key = ?").bind(progressKey(job.key)).run();
		ctx.note(`${job.key}: read completely (${leaves.length} parts)`);
	});
}
