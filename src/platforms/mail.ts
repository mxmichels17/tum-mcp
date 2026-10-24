// TUM mail via LRZ: IMAP xmail.mwn.de:993 (TLS), SMTP postout.lrz.de:587 (STARTTLS).
// Secrets: TUM_USER (LRZ ID), TUM_PASSWORD, TUM_EMAIL (sender address), TUM_DISPLAY_NAME (optional).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import PostalMime, { type Address, type Email } from "postal-mime";
import { z } from "zod";
import { fromBase64, toBase64 } from "../lib/bytes";
import { htmlToText } from "../lib/html";
import { guessMimeType } from "../lib/mime-types";
import { type FetchedMessage, ImapClient, ImapError, imapDate, imapString, type MailboxInfo } from "../lib/imap";
import { type ImapValue, valueToBytes, valueToString } from "../lib/imap-parse";
import { buildMessage, type MailAddress, type OutgoingAttachment, parseAddress } from "../lib/mime-build";
import { connectStartTls, connectTls } from "../lib/net";
import { SmtpError, smtpSession } from "../lib/smtp";
import {
	CONFIRM,
	json,
	LoginError,
	NotConfiguredError,
	type PlatformStatus,
	requireSecrets,
	run,
	truncate,
	withTimeout,
} from "../lib/tools";

const IMAP_HOST = "xmail.mwn.de";
const IMAP_PORT = 993;
const SMTP_HOST = "postout.lrz.de";
const SMTP_PORT = 587;

// MCP clients give up after about 60 s, so every mail call must finish well before that.
const CONNECT_TIMEOUT_MS = 15_000;
const TIMEOUT_MS = 50_000;
const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const SENT_NAMES = ["Sent", "Sent Items", "Sent Messages", "Gesendet", "Gesendete Objekte", "Gesendete Elemente", "INBOX.Sent"];
const DRAFTS_NAMES = ["Drafts", "Entwürfe", "Draft", "INBOX.Drafts"];
const TRASH_NAMES = ["Trash", "Deleted Items", "Deleted Messages", "Papierkorb", "Gelöschte Objekte", "Gelöschte Elemente", "INBOX.Trash"];

function credentials(env: Env) {
	const s = requireSecrets(env, "mail", ["TUM_USER", "TUM_PASSWORD"]);
	return { user: s.TUM_USER, password: s.TUM_PASSWORD };
}

function sender(env: Env): MailAddress {
	const { TUM_EMAIL } = requireSecrets(env, "mail", ["TUM_EMAIL"]);
	const name = env.TUM_DISPLAY_NAME?.trim();
	return name ? { name, address: TUM_EMAIL.trim() } : { address: TUM_EMAIL.trim() };
}

export async function withImap<T>(env: Env, fn: (c: ImapClient) => Promise<T>): Promise<T> {
	const { user, password } = credentials(env);
	const client = new ImapClient(connectTls(IMAP_HOST, IMAP_PORT));
	const login = async () => {
		await client.greeting();
		try {
			await client.login(user, password);
		} catch (e) {
			if (e instanceof ImapError && e.kind === "auth") throw new LoginError(`IMAP login failed: ${e.message}`);
			throw e;
		}
	};
	const work = async () => {
		await withTimeout(login(), CONNECT_TIMEOUT_MS, `IMAP connect and login to ${IMAP_HOST}`);
		const result = await fn(client);
		await client.logout();
		return result;
	};
	try {
		return await withTimeout(work(), TIMEOUT_MS, "IMAP");
	} catch (e) {
		await client.close();
		throw e;
	}
}

async function smtpSend(env: Env, from: string, recipients: string[], message: Uint8Array): Promise<void> {
	const { user, password } = credentials(env);
	const { io, startTls } = connectStartTls(SMTP_HOST, SMTP_PORT);
	try {
		await withTimeout(smtpSession(io, { user, password, from, recipients, message, startTls }), 30_000, "SMTP");
	} catch (e) {
		if (e instanceof SmtpError && e.kind === "auth") throw new LoginError(e.message);
		throw e;
	}
}

// ---------- formatting helpers ----------

export function flattenAddresses(list: Address[] | Address | undefined): MailAddress[] {
	if (!list) return [];
	const arr = Array.isArray(list) ? list : [list];
	const out: MailAddress[] = [];
	for (const a of arr) {
		if (a.group) out.push(...a.group.map((m) => ({ name: m.name || undefined, address: m.address })));
		else if (a.address) out.push({ name: a.name || undefined, address: a.address });
	}
	return out;
}

export function addrText(a: MailAddress): string {
	return a.name ? `${a.name} <${a.address}>` : a.address;
}

function flagsOf(m: FetchedMessage): string[] {
	const f = m.attrs.get("FLAGS");
	return Array.isArray(f) ? f.filter((x): x is string => typeof x === "string") : [];
}

export function bodySection(m: FetchedMessage): Uint8Array | null {
	for (const [k, v] of m.attrs) if (k.startsWith("BODY[")) return valueToBytes(v as ImapValue);
	return null;
}

export async function parseMessage(raw: Uint8Array): Promise<Email> {
	return PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" });
}

function attachmentBytes(content: ArrayBuffer | Uint8Array | string): Uint8Array {
	if (typeof content === "string") return new TextEncoder().encode(content);
	return content instanceof Uint8Array ? content : new Uint8Array(content);
}

export function messageText(email: Email): string {
	if (email.text?.trim()) return email.text;
	if (email.html) return htmlToText(email.html);
	return "";
}

function special(boxes: MailboxInfo[], flag: string, names: string[]): MailboxInfo | undefined {
	const byFlag = boxes.find((b) => b.flags.some((f) => f.toLowerCase() === flag.toLowerCase()));
	if (byFlag) return byFlag;
	for (const n of names) {
		const hit = boxes.find((b) => b.name.toLowerCase() === n.toLowerCase());
		if (hit) return hit;
	}
	return undefined;
}

const attachmentInput = z
	.array(
		z.object({
			filename: z.string().min(1),
			content_base64: z.string().describe("File content, base64 encoded"),
			mime_type: z.string().optional().describe("MIME type. Guessed from the file name if empty."),
		}),
	)
	.optional()
	.describe("Files to attach");

function toAttachments(input: z.infer<typeof attachmentInput>): OutgoingAttachment[] {
	return (input ?? []).map((a) => ({
		filename: a.filename,
		mimeType: a.mime_type || guessMimeType(a.filename),
		content: fromBase64(a.content_base64),
	}));
}

function parseList(list: string[] | undefined): MailAddress[] {
	return (list ?? []).map(parseAddress);
}

async function fetchRaw(c: ImapClient, uid: number, peek = true): Promise<Uint8Array> {
	const meta = await c.uidFetch([uid], "(UID RFC822.SIZE)");
	if (!meta.length) throw new Error(`No message with UID ${uid} in this folder`);
	const size = Number(valueToString(meta[0].attrs.get("RFC822.SIZE")) ?? 0);
	if (size > MAX_MESSAGE_BYTES) throw new Error(`Message is too large (${size} bytes, limit ${MAX_MESSAGE_BYTES})`);
	const msgs = await c.uidFetch([uid], peek ? "(UID BODY.PEEK[])" : "(UID BODY[])");
	const raw = msgs.length ? bodySection(msgs[0]) : null;
	if (!raw) throw new Error(`Could not fetch message UID ${uid}`);
	return raw;
}

async function loadMessage(env: Env, folder: string, uid: number): Promise<Email> {
	const raw = await withImap(env, async (c) => {
		await c.select(folder, true);
		return fetchRaw(c, uid);
	});
	return parseMessage(raw);
}

/** Sends via SMTP and stores a copy in the Sent folder. Returns notes for the tool result. */
async function deliver(
	env: Env,
	msg: Parameters<typeof buildMessage>[0],
	bcc: MailAddress[],
	saveToSent: boolean,
	afterSend?: (c: ImapClient) => Promise<void>,
): Promise<{ message_id: string; recipients: string[]; notes: string[] }> {
	const { raw, messageId } = buildMessage(msg);
	const recipients = [...msg.to, ...(msg.cc ?? []), ...bcc].map((a) => a.address);
	if (!recipients.length) throw new Error("No recipients");
	await smtpSend(env, msg.from.address, [...new Set(recipients)], raw);
	const notes: string[] = [];
	if (saveToSent || afterSend) {
		try {
			await withImap(env, async (c) => {
				if (saveToSent) {
					const sent = special(await c.list(), "\\Sent", SENT_NAMES);
					if (sent) await c.append(sent.name, ["\\Seen"], raw);
					else notes.push("No Sent folder found, no copy saved.");
				}
				if (afterSend) await afterSend(c);
			});
		} catch (e) {
			notes.push(`Mail was sent, but the follow-up IMAP step failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	return { message_id: messageId, recipients, notes };
}

function quote(email: Email): string {
	const from = flattenAddresses(email.from).map(addrText).join(", ");
	const text = messageText(email).replace(/\r\n/g, "\n").trimEnd();
	return `\n\nOn ${email.date ?? "an unknown date"}, ${from} wrote:\n${text
		.split("\n")
		.map((l) => `> ${l}`)
		.join("\n")}`;
}

const FLAG_NAMES: Record<string, string> = {
	seen: "\\Seen",
	read: "\\Seen",
	flagged: "\\Flagged",
	answered: "\\Answered",
	draft: "\\Draft",
};

export function normalizeFlag(f: string): string {
	const mapped = FLAG_NAMES[f.toLowerCase()];
	if (mapped) return mapped;
	if (/^\\(Seen|Flagged|Answered|Draft)$/i.test(f)) return `\\${f.slice(1, 2).toUpperCase()}${f.slice(2).toLowerCase()}`;
	if (/^\\/.test(f)) throw new Error(`Flag ${f} is not allowed. Use mail_trash to delete.`);
	if (!/^[A-Za-z0-9$_.-]+$/.test(f)) throw new Error(`Invalid keyword: ${f}`);
	return f;
}

// ---------- tools ----------

const folderArg = z.string().default("INBOX").describe('Folder name as returned by mail_folders, e.g. "INBOX"');
const uidArg = z.number().int().positive().describe("Message UID from mail_search");
const uidsArg = z.array(z.number().int().positive()).min(1).max(500).describe("Message UIDs from mail_search");

export function registerMailTools(server: McpServer, env: Env) {
	server.registerTool(
		"mail_folders",
		{
			description: "List the folders of the TUM mailbox, with special use (Sent, Trash, ...) and optional message counts.",
			inputSchema: { with_counts: z.boolean().default(false).describe("Also return total and unread counts per folder (slower)") },
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ with_counts }) =>
			run(async () => {
				const folders = await withImap(env, async (c) => {
					const boxes = await c.list();
					const out = [];
					for (const b of boxes) {
						const selectable = !b.flags.some((f) => /^\\(Noselect|NonExistent)$/i.test(f));
						const entry: Record<string, unknown> = {
							name: b.name,
							special_use: b.flags.filter((f) => /^\\(Sent|Trash|Drafts|Junk|Archive|All|Flagged)$/i.test(f)),
						};
						if (with_counts && selectable) {
							try {
								Object.assign(entry, await c.status(b.name));
							} catch {
								// some folders refuse STATUS
							}
						}
						out.push(entry);
					}
					return out;
				});
				return json({ folders });
			}),
	);

	server.registerTool(
		"mail_search",
		{
			description:
				"Search the TUM mailbox. Returns the newest matching messages first, with UID, date, sender, recipients, subject and flags. All filters are combined with AND.",
			inputSchema: {
				folder: folderArg,
				from: z.string().optional().describe("Sender contains"),
				to: z.string().optional().describe("Recipient contains"),
				subject: z.string().optional().describe("Subject contains"),
				text: z.string().optional().describe("Header or body contains"),
				since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Date on or after, YYYY-MM-DD"),
				before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Date before, YYYY-MM-DD"),
				unread_only: z.boolean().default(false),
				flagged_only: z.boolean().default(false),
				limit: z.number().int().min(1).max(100).default(20),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async (a) =>
			run(async () => {
				const criteria: (string | ReturnType<typeof imapString>)[] = [];
				if (a.from) criteria.push("FROM", imapString(a.from));
				if (a.to) criteria.push("TO", imapString(a.to));
				if (a.subject) criteria.push("SUBJECT", imapString(a.subject));
				if (a.text) criteria.push("TEXT", imapString(a.text));
				if (a.since) criteria.push("SINCE", imapDate(new Date(`${a.since}T00:00:00Z`)));
				if (a.before) criteria.push("BEFORE", imapDate(new Date(`${a.before}T00:00:00Z`)));
				if (a.unread_only) criteria.push("UNSEEN");
				if (a.flagged_only) criteria.push("FLAGGED");

				const result = await withImap(env, async (c) => {
					await c.select(a.folder, true);
					const uids = await c.uidSearch(criteria);
					const picked = uids.slice(-a.limit).reverse();
					if (!picked.length) return { total: uids.length, messages: [] as unknown[] };
					const fetched = await c.uidFetch(
						picked,
						"(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID CONTENT-TYPE)])",
					);
					const byUid = new Map(fetched.map((m) => [m.uid, m]));
					const messages = [];
					for (const uid of picked) {
						const m = byUid.get(uid);
						if (!m) continue;
						const header = bodySection(m);
						const email = header ? await parseMessage(header) : undefined;
						const contentType = email?.headers.find((h) => h.key === "content-type")?.value ?? "";
						messages.push({
							uid,
							date: email?.date ?? valueToString(m.attrs.get("INTERNALDATE")),
							from: flattenAddresses(email?.from).map(addrText).join(", "),
							to: flattenAddresses(email?.to).map(addrText),
							cc: flattenAddresses(email?.cc).map(addrText),
							subject: email?.subject ?? "",
							flags: flagsOf(m),
							size: Number(valueToString(m.attrs.get("RFC822.SIZE")) ?? 0),
							maybe_attachments: /multipart\/(mixed|related)/i.test(contentType),
						});
					}
					return { total: uids.length, messages };
				});
				return json({ folder: a.folder, ...result });
			}),
	);

	server.registerTool(
		"mail_read",
		{
			description:
				"Read one message: headers, plain text body (HTML converted to text if needed) and the list of attachments. Use mail_download_attachment with the attachment index to get a file.",
			inputSchema: {
				folder: folderArg,
				uid: uidArg,
				mark_as_read: z.boolean().default(false).describe("Set the \\Seen flag"),
				max_chars: z.number().int().min(500).max(200_000).default(30_000),
			},
			annotations: { readOnlyHint: false, openWorldHint: true },
		},
		async ({ folder, uid, mark_as_read, max_chars }) =>
			run(async () => {
				const raw = await withImap(env, async (c) => {
					await c.select(folder, !mark_as_read);
					return fetchRaw(c, uid, !mark_as_read);
				});
				const email = await parseMessage(raw);
				const body = truncate(messageText(email), max_chars);
				return json({
					folder,
					uid,
					message_id: email.messageId,
					date: email.date,
					from: flattenAddresses(email.from).map(addrText).join(", "),
					reply_to: flattenAddresses(email.replyTo).map(addrText),
					to: flattenAddresses(email.to).map(addrText),
					cc: flattenAddresses(email.cc).map(addrText),
					subject: email.subject ?? "",
					in_reply_to: email.inReplyTo,
					body: body.text,
					body_truncated: body.truncated,
					body_source: email.text?.trim() ? "text" : email.html ? "html converted to text" : "none",
					attachments: email.attachments.map((att, index) => ({
						index,
						filename: att.filename,
						mime_type: att.mimeType,
						size: attachmentBytes(att.content).byteLength,
						disposition: att.disposition,
						content_id: att.contentId,
					})),
				});
			}),
	);

	server.registerTool(
		"mail_download_attachment",
		{
			description:
				"Download one attachment of a message by its index from mail_read. Images come back as images, text files as text, other files (e.g. PDF) as an embedded base64 resource.",
			inputSchema: { folder: folderArg, uid: uidArg, index: z.number().int().min(0) },
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ folder, uid, index }) =>
			run(async (): Promise<CallToolResult> => {
				const email = await loadMessage(env, folder, uid);
				const att = email.attachments[index];
				if (!att) throw new Error(`Attachment index ${index} not found. The message has ${email.attachments.length} attachments.`);
				const bytes = attachmentBytes(att.content);
				if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
					throw new Error(`Attachment is too large (${bytes.byteLength} bytes, limit ${MAX_ATTACHMENT_BYTES})`);
				}
				const filename = att.filename ?? `attachment-${index}`;
				const meta = { type: "text" as const, text: JSON.stringify({ filename, mime_type: att.mimeType, size: bytes.byteLength }) };
				if (/^image\/(png|jpeg|gif|webp)$/.test(att.mimeType)) {
					return { content: [meta, { type: "image", data: toBase64(bytes), mimeType: att.mimeType }] };
				}
				if (/^text\/|^application\/(json|xml|csv)|\+xml$|\+json$/.test(att.mimeType)) {
					const t = truncate(new TextDecoder().decode(bytes), 200_000);
					return { content: [meta, { type: "text", text: t.text + (t.truncated ? "\n[truncated]" : "") }] };
				}
				return {
					content: [
						meta,
						{
							type: "resource",
							resource: {
								uri: `mail://${encodeURIComponent(folder)}/${uid}/${index}/${encodeURIComponent(filename)}`,
								mimeType: att.mimeType,
								blob: toBase64(bytes),
							},
						},
					],
				};
			}),
	);

	server.registerTool(
		"mail_send",
		{
			description: `Send a new email from the TUM address (SMTP postout.lrz.de). A copy is saved in the Sent folder. ${CONFIRM}`,
			inputSchema: {
				to: z.array(z.string()).min(1).describe('Recipients, "Name <a@b.de>" or "a@b.de"'),
				cc: z.array(z.string()).optional(),
				bcc: z.array(z.string()).optional(),
				subject: z.string(),
				body: z.string().describe("Plain text body"),
				attachments: attachmentInput,
				save_to_sent: z.boolean().default(true),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
		},
		async (a) =>
			run(async () => {
				const result = await deliver(
					env,
					{
						from: sender(env),
						to: parseList(a.to),
						cc: parseList(a.cc),
						subject: a.subject,
						text: a.body,
						attachments: toAttachments(a.attachments),
					},
					parseList(a.bcc),
					a.save_to_sent,
				);
				return json({ sent: true, ...result });
			}),
	);

	server.registerTool(
		"mail_reply",
		{
			description: `Reply to a message. Sets In-Reply-To and References, quotes the original text, and flags the original as answered. ${CONFIRM}`,
			inputSchema: {
				folder: folderArg,
				uid: uidArg,
				body: z.string().describe("Plain text reply, written above the quote"),
				reply_all: z.boolean().default(false),
				include_quote: z.boolean().default(true),
				cc: z.array(z.string()).optional().describe("Extra Cc recipients"),
				attachments: attachmentInput,
				save_to_sent: z.boolean().default(true),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
		},
		async (a) =>
			run(async () => {
				const from = sender(env);
				const orig = await loadMessage(env, a.folder, a.uid);
				const replyTo = flattenAddresses(orig.replyTo);
				const target = replyTo.length ? replyTo : flattenAddresses(orig.from);
				if (!target.length) throw new Error("Original message has no sender address");
				const self = from.address.toLowerCase();
				const seen = new Set([self, ...target.map((t) => t.address.toLowerCase())]);
				const cc: MailAddress[] = [];
				if (a.reply_all) {
					for (const x of [...flattenAddresses(orig.to), ...flattenAddresses(orig.cc)]) {
						const k = x.address.toLowerCase();
						if (!seen.has(k)) {
							seen.add(k);
							cc.push(x);
						}
					}
				}
				cc.push(...parseList(a.cc));
				const subject = orig.subject ?? "";
				const refs = (orig.references ?? "").split(/\s+/).filter(Boolean);
				if (orig.messageId) refs.push(orig.messageId);
				const result = await deliver(
					env,
					{
						from,
						to: target,
						cc,
						subject: /^(re|aw):/i.test(subject) ? subject : `Re: ${subject}`,
						text: a.body + (a.include_quote ? quote(orig) : ""),
						inReplyTo: orig.messageId,
						references: refs,
						attachments: toAttachments(a.attachments),
					},
					[],
					a.save_to_sent,
					async (c) => {
						await c.select(a.folder, false);
						await c.uidStore([a.uid], "+FLAGS.SILENT", ["\\Answered"]);
					},
				);
				return json({ sent: true, ...result });
			}),
	);

	server.registerTool(
		"mail_forward",
		{
			description: `Forward a message inline with its attachments to new recipients. ${CONFIRM}`,
			inputSchema: {
				folder: folderArg,
				uid: uidArg,
				to: z.array(z.string()).min(1),
				cc: z.array(z.string()).optional(),
				body: z.string().default("").describe("Note written above the forwarded message"),
				include_attachments: z.boolean().default(true),
				save_to_sent: z.boolean().default(true),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
		},
		async (a) =>
			run(async () => {
				const orig = await loadMessage(env, a.folder, a.uid);
				const subject = orig.subject ?? "";
				const header = [
					"---------- Forwarded message ----------",
					`From: ${flattenAddresses(orig.from).map(addrText).join(", ")}`,
					`Date: ${orig.date ?? ""}`,
					`Subject: ${subject}`,
					`To: ${flattenAddresses(orig.to).map(addrText).join(", ")}`,
				];
				const cc = flattenAddresses(orig.cc);
				if (cc.length) header.push(`Cc: ${cc.map(addrText).join(", ")}`);
				const attachments: OutgoingAttachment[] = a.include_attachments
					? orig.attachments.map((att, i) => ({
							filename: att.filename ?? `attachment-${i}`,
							mimeType: att.mimeType,
							content: attachmentBytes(att.content),
						}))
					: [];
				const result = await deliver(
					env,
					{
						from: sender(env),
						to: parseList(a.to),
						cc: parseList(a.cc),
						subject: /^(fwd?|wg):/i.test(subject) ? subject : `Fwd: ${subject}`,
						text: `${a.body}\n\n${header.join("\n")}\n\n${messageText(orig)}`,
						attachments,
					},
					[],
					a.save_to_sent,
				);
				return json({ sent: true, forwarded_attachments: attachments.length, ...result });
			}),
	);

	server.registerTool(
		"mail_move",
		{
			description: "Move messages to another folder of the TUM mailbox.",
			inputSchema: { folder: folderArg, uids: uidsArg, destination: z.string().describe("Target folder name from mail_folders") },
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		},
		async ({ folder, uids, destination }) =>
			run(async () => {
				if (folder === destination) throw new Error("Source and destination are the same folder");
				const warning = await withImap(env, async (c) => {
					await c.select(folder, false);
					return c.uidMove(uids, destination);
				});
				return json({ moved: uids.length, from: folder, to: destination, warning });
			}),
	);

	server.registerTool(
		"mail_flags",
		{
			description:
				'Add or remove flags on messages. Names: "seen" (read), "flagged", "answered", "draft", or a custom keyword. Deleting is done with mail_trash.',
			inputSchema: {
				folder: folderArg,
				uids: uidsArg,
				add: z.array(z.string()).optional(),
				remove: z.array(z.string()).optional(),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		},
		async ({ folder, uids, add, remove }) =>
			run(async () => {
				const plus = (add ?? []).map(normalizeFlag);
				const minus = (remove ?? []).map(normalizeFlag);
				if (!plus.length && !minus.length) throw new Error("Give flags to add or remove");
				const flags = await withImap(env, async (c) => {
					await c.select(folder, false);
					if (plus.length) await c.uidStore(uids, "+FLAGS.SILENT", plus);
					if (minus.length) await c.uidStore(uids, "-FLAGS.SILENT", minus);
					const now = await c.uidFetch(uids, "(UID FLAGS)");
					return now.map((m) => ({ uid: m.uid, flags: flagsOf(m) }));
				});
				return json({ folder, flags });
			}),
	);

	server.registerTool(
		"mail_trash",
		{
			description: `Move messages to the Trash folder. Nothing is deleted permanently. ${CONFIRM}`,
			inputSchema: { folder: folderArg, uids: uidsArg },
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
		},
		async ({ folder, uids }) =>
			run(async () => {
				const result = await withImap(env, async (c) => {
					const trash = special(await c.list(), "\\Trash", TRASH_NAMES);
					if (!trash) throw new Error("No Trash folder found. Use mail_folders and mail_move instead.");
					if (trash.name === folder) throw new Error("Messages are already in the Trash folder");
					await c.select(folder, false);
					const warning = await c.uidMove(uids, trash.name);
					return { trash: trash.name, warning };
				});
				return json({ moved_to_trash: uids.length, ...result });
			}),
	);
}

export async function mailStatus(env: Env): Promise<PlatformStatus[]> {
	let creds: { user: string; password: string };
	try {
		creds = credentials(env);
	} catch (e) {
		if (e instanceof NotConfiguredError) return [{ platform: "mail", state: "not configured", detail: e.message }];
		throw e;
	}
	const imap = async (): Promise<PlatformStatus> => {
		const platform = `mail (IMAP ${IMAP_HOST})`;
		try {
			await withImap(env, async () => undefined);
			return { platform, state: "OK" };
		} catch (e) {
			return { platform, state: e instanceof LoginError ? "login error" : "error", detail: e instanceof Error ? e.message : String(e) };
		}
	};
	const smtp = async (): Promise<PlatformStatus> => {
		const platform = `mail (SMTP ${SMTP_HOST})`;
		try {
			const { io, startTls } = connectStartTls(SMTP_HOST, SMTP_PORT);
			await withTimeout(
				smtpSession(io, { ...creds, from: "", recipients: [], message: new Uint8Array(), startTls }),
				CONNECT_TIMEOUT_MS,
				`SMTP connect and login to ${SMTP_HOST}`,
			);
			if (!env.TUM_EMAIL?.trim()) {
				return { platform, state: "not configured", detail: "Login works, but TUM_EMAIL is missing, so sending is disabled." };
			}
			return { platform, state: "OK" };
		} catch (e) {
			return {
				platform,
				state: e instanceof SmtpError && e.kind === "auth" ? "login error" : "error",
				detail: e instanceof Error ? e.message : String(e),
			};
		}
	};
	return Promise.all([imap(), smtp()]);
}

/** For the watcher: unread mails of the last days in INBOX (headers only, nothing is marked as read). */
export async function unreadInbox(env: Env, days = 14, limit = 30) {
	const since = imapDate(new Date(Date.now() - days * 86400_000));
	return withImap(env, async (c) => {
		await c.select("INBOX", true);
		const uids = (await c.uidSearch(["UNSEEN", "SINCE", since])).slice(-limit);
		if (!uids.length) return [];
		const fetched = await c.uidFetch(uids, "(UID INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])");
		const out = [];
		for (const m of fetched) {
			const header = bodySection(m);
			const email = header ? await parseMessage(header) : undefined;
			out.push({
				uid: m.uid,
				from: flattenAddresses(email?.from).map(addrText).join(", "),
				subject: email?.subject ?? "",
				date: email?.date ?? valueToString(m.attrs.get("INTERNALDATE")) ?? undefined,
			});
		}
		return out;
	});
}

// ---------- folders and drafts ----------

const PROTECTED_FLAGS = /^\\(Sent|Trash|Drafts|Junk|Archive|All|Flagged)$/i;

function assertFolderName(name: string) {
	if (!name.trim() || /[\r\n*%]/.test(name)) throw new Error(`Invalid folder name: ${name}`);
}

export function registerMailFolderTools(server: McpServer, env: Env) {
	const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

	server.registerTool(
		"mail_create_folder",
		{
			description: 'Create a mail folder. Use the hierarchy delimiter from mail_folders for subfolders (often "/" or ".").',
			inputSchema: { name: z.string().min(1).describe('Full folder name, e.g. "Uni/GDB"') },
			annotations: { ...write, idempotentHint: true },
		},
		async ({ name }) =>
			run(async () => {
				assertFolderName(name);
				await withImap(env, async (c) => {
					if ((await c.list()).some((b) => b.name === name)) throw new Error(`Folder "${name}" already exists`);
					await c.create(name);
				});
				return json({ created: name });
			}),
	);

	server.registerTool(
		"mail_rename_folder",
		{
			description: "Rename or move a mail folder. INBOX and special folders (Sent, Trash, Drafts, Junk) are refused.",
			inputSchema: { from: z.string().min(1), to: z.string().min(1) },
			annotations: write,
		},
		async ({ from, to }) =>
			run(async () => {
				assertFolderName(to);
				await withImap(env, async (c) => {
					const boxes = await c.list();
					const box = boxes.find((b) => b.name === from);
					if (!box) throw new Error(`Folder "${from}" not found`);
					if (from.toUpperCase() === "INBOX" || box.flags.some((f) => PROTECTED_FLAGS.test(f))) throw new Error(`"${from}" is a special folder and cannot be renamed`);
					if (boxes.some((b) => b.name === to)) throw new Error(`Folder "${to}" already exists`);
					await c.rename(from, to);
				});
				return json({ renamed: { from, to } });
			}),
	);

	server.registerTool(
		"mail_delete_folder",
		{
			description: `Delete a mail folder, only if it is empty and has no subfolders. INBOX and special folders are refused. ${CONFIRM}`,
			inputSchema: { name: z.string().min(1) },
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
		},
		async ({ name }) =>
			run(async () => {
				await withImap(env, async (c) => {
					const boxes = await c.list();
					const box = boxes.find((b) => b.name === name);
					if (!box) throw new Error(`Folder "${name}" not found`);
					if (name.toUpperCase() === "INBOX" || box.flags.some((f) => PROTECTED_FLAGS.test(f))) throw new Error(`"${name}" is a special folder and cannot be deleted`);
					const delim = box.delimiter ?? "/";
					if (boxes.some((b) => b.name.startsWith(`${name}${delim}`))) throw new Error(`"${name}" has subfolders. Delete or move them first.`);
					const st = await c.status(name);
					if (st.messages === undefined || Number.isNaN(st.messages)) throw new Error(`Could not read the message count of "${name}"`);
					if (st.messages > 0) throw new Error(`"${name}" contains ${st.messages} messages. Only empty folders can be deleted.`);
					await c.deleteMailbox(name);
				});
				return json({ deleted: name });
			}),
	);

	server.registerTool(
		"mail_save_draft",
		{
			description: "Save a mail as draft in the Drafts folder (nothing is sent). Open it later in any mail client to send it.",
			inputSchema: {
				to: z.array(z.string()).default([]),
				cc: z.array(z.string()).optional(),
				subject: z.string(),
				body: z.string(),
				attachments: attachmentInput,
			},
			annotations: { ...write, idempotentHint: false },
		},
		async (a) =>
			run(async () => {
				const { raw, messageId } = buildMessage({
					from: sender(env),
					to: parseList(a.to),
					cc: parseList(a.cc),
					subject: a.subject,
					text: a.body,
					attachments: toAttachments(a.attachments),
				});
				const folder = await withImap(env, async (c) => {
					const drafts = special(await c.list(), "\\Drafts", DRAFTS_NAMES);
					if (!drafts) throw new Error("No Drafts folder found");
					await c.append(drafts.name, ["\\Draft", "\\Seen"], raw);
					return drafts.name;
				});
				return json({ saved: true, folder, message_id: messageId });
			}),
	);
}
