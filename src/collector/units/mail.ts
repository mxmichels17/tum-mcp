// Mail unit: every mail in every mail folder, read only (BODY.PEEK, nothing is marked as read).
// One listing per folder (UID SEARCH ALL), so a mail that is moved or deleted shows up as removed.
// A mail never changes, so only new UIDs are read. Attachments go to R2, PDFs also as text.
// Scope: only mails from MAIL_SINCE on (scope.ts).
// Mails larger than 25 MB are read part by part over several invocations by the unit "mail-large"
// (see mail-large.ts); this unit returns them when that unit has finished.

import type { Email } from "postal-mime";
import { htmlToText } from "../../lib/html";
import { valueToString } from "../../lib/imap-parse";
import { addrText, bodySection, flattenAddresses, parseMessage, withImap } from "../../platforms/mail";
import { storeBytes } from "../files";
import { type Content, type Entry, type FileRef, hash64, type Json } from "../model";
import { Deferred, getState, setState } from "../store";
import { imapSince, MAIL_SINCE } from "../scope";
import { errText, item, type UnitCtx } from "../unit";

/** Mails up to this size are read in one piece. Larger ones go to the unit "mail-large". */
export const MAX_READ_BYTES = 25 * 1024 * 1024;

export function mailUrl(folder: string, uidValidity: number, uid: number): string {
	return `imap://xmail.mwn.de/${encodeURIComponent(folder)};UIDVALIDITY=${uidValidity}/;UID=${uid}`;
}

const addrs = (a: Parameters<typeof flattenAddresses>[0]) => flattenAddresses(a).map(addrText);

/** Content of one mail. The same fields for mails read in one piece and mails read in parts. */
export function mailContent(m: { folder: string; uid: number; uidValidity: number; size: number }, header: Email, body: { text: string | null; html: boolean; textFromHtml: boolean }, attachments: FileRef[]): Content {
	return {
		folder: m.folder,
		uid: m.uid,
		uid_validity: m.uidValidity,
		size: m.size,
		message_id: header.messageId ?? null,
		in_reply_to: header.inReplyTo ?? null,
		references: header.references ?? null,
		date: header.date ?? null,
		from: addrs(header.from),
		sender: addrs(header.sender),
		reply_to: addrs(header.replyTo),
		to: addrs(header.to),
		cc: addrs(header.cc),
		bcc: addrs(header.bcc),
		subject: header.subject ?? null,
		text: body.text,
		text_from_html: body.textFromHtml,
		headers: (header.headers ?? []).map((h) => ({ key: h.key, value: h.value })),
		attachments: attachments.map((f) => ({ ...f })) as unknown as Json,
	};
}

export interface LargeMailJob {
	key: string;
	folder: string;
	uidValidity: number;
	uid: number;
	size: number;
}

export const LARGE_QUEUE = "mail:large:queue";
export const largeDoneKey = (key: string) => `mailbig/${hash64(key)}/done.json`;

export async function unitMail(ctx: UnitCtx): Promise<void> {
	const { env } = ctx;
	await withImap(env, async (c) => {
		const boxes = (await c.list()).filter((b) => !b.flags.some((f) => /\\noselect|\\nonexistent/i.test(f)));
		for (const box of boxes) {
			let sel: Awaited<ReturnType<typeof c.select>>;
			try {
				sel = await c.select(box.name, true);
			} catch (e) {
				ctx.note(`${box.name}: ${errText(e)}`);
				continue;
			}
			const v = sel.uidValidity ?? 0;
			// Scope: mails from MAIL_SINCE on (internal date of the server). Older ones are not read and not reported.
			const all = sel.exists ? await c.uidSearch(["ALL"]) : [];
			const uids = sel.exists ? (await c.uidSearch(["SINCE", imapSince()])).sort((a, b) => b - a) : [];
			const inScope = new Set(uids);
			const outOfScope = all.filter((u) => !inScope.has(u)).map((u) => `mail:${box.name}:${v}:${u}`);
			const entries: Entry[] = uids.map((uid) => {
				const key = `mail:${box.name}:${v}:${uid}`;
				const url = mailUrl(box.name, v, uid);
				return {
					key,
					// A mail with this UID never changes.
					sig: "1",
					load: async () => {
						const size = Number(valueToString((await c.uidFetch([uid], "(UID RFC822.SIZE)"))[0]?.attrs.get("RFC822.SIZE")) ?? 0);
						if (size > MAX_READ_BYTES) {
							const done = await env.FILES.get(largeDoneKey(key));
							if (done) {
								const r = JSON.parse(await done.text()) as { title: string; content: Content; html: string | null };
								return item("mail", key, r.title, url, r.content, r.html ?? undefined);
							}
							const queue = (await getState<LargeMailJob[]>(env.DB, LARGE_QUEUE)) ?? [];
							if (!queue.some((j) => j.key === key)) await setState(env.DB, LARGE_QUEUE, [...queue, { key, folder: box.name, uidValidity: v, uid, size }]);
							throw new Deferred();
						}
						const fetched = await c.uidFetch([uid], "(UID BODY.PEEK[])");
						const raw = fetched[0] ? bodySection(fetched[0]) : null;
						if (!raw) throw new Error("message not found");
						const email = await parseMessage(raw);
						const files: FileRef[] = [];
						for (const [i, a] of (email.attachments ?? []).entries()) {
							const bytes = a.content instanceof ArrayBuffer ? new Uint8Array(a.content) : typeof a.content === "string" ? new TextEncoder().encode(a.content) : new Uint8Array(a.content);
							const ref = await storeBytes(env, { name: a.filename ?? `attachment-${i + 1}`, mime: a.mimeType ?? null, url: `${url};attachment=${i}`, bytes });
							files.push({ ...ref, ...(a.disposition ? { disposition: a.disposition } : {}), ...(a.contentId ? { content_id: a.contentId } : {}) } as FileRef);
						}
						const text = email.text ?? (email.html ? htmlToText(email.html) : "");
						return item("mail", key, email.subject?.trim() ?? "", url, mailContent({ folder: box.name, uid, uidValidity: v, size }, email, { text, html: !!email.html, textFromHtml: !email.text && !!email.html }, files), email.html ?? undefined);
					},
				};
			});
			await ctx.apply({
				scope: `mail:${box.name}`,
				complete: true,
				entries,
				outOfScope,
				// A stored mail that is gone and was older than the limit is forgotten, not reported as removed.
				outOfScopeContent: (c) => typeof c.date === "string" && Date.parse(c.date) < Date.parse(`${MAIL_SINCE}T00:00:00+02:00`),
			});
		}
	});
}
