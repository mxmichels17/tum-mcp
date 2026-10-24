// Zulip at zulip.cit.tum.de. REST API docs: https://zulip.com/api/
// Secrets: ZULIP_EMAIL, ZULIP_API_KEY (Zulip > Personal settings > Account & privacy > API key).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fromBase64 } from "../lib/bytes";
import { CONFIRM, json, LoginError, NotConfiguredError, type PlatformStatus, requireSecrets, run, withTimeout } from "../lib/tools";
import { guessMimeType } from "../lib/mime-types";

export const ZULIP_SITE = "https://zulip.cit.tum.de";
const TIMEOUT_MS = 30_000;

type Params = Record<string, string | number | boolean | unknown[] | Record<string, unknown> | undefined>;

class ZulipError extends Error {
	constructor(
		message: string,
		public status: number,
		public code?: string,
	) {
		super(message);
	}
}

function encodeParams(params: Params): URLSearchParams {
	const p = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) {
		if (v === undefined) continue;
		p.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
	}
	return p;
}

/** Calls the Zulip REST API. GET and DELETE send params as query, others as form body. */
export async function zulip<T = Record<string, unknown>>(
	env: Env,
	method: "GET" | "POST" | "PATCH" | "DELETE",
	path: string,
	params: Params = {},
	body?: FormData,
): Promise<T> {
	const s = requireSecrets(env, "zulip", ["ZULIP_EMAIL", "ZULIP_API_KEY"]);
	const url = new URL(`/api/v1${path}`, ZULIP_SITE);
	const init: RequestInit = {
		method,
		headers: { Authorization: `Basic ${btoa(`${s.ZULIP_EMAIL.trim()}:${s.ZULIP_API_KEY.trim()}`)}` },
	};
	if (body) {
		init.body = body;
	} else if (method === "GET" || method === "DELETE") {
		url.search = encodeParams(params).toString();
	} else {
		init.body = encodeParams(params);
	}
	const res = await withTimeout(fetch(url, init), TIMEOUT_MS, "Zulip");
	const text = await res.text();
	let data: Record<string, unknown>;
	try {
		data = JSON.parse(text);
	} catch {
		throw new ZulipError(`Zulip returned HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
	}
	if (res.status === 401) throw new LoginError(`Zulip login failed: ${String(data.msg ?? "unauthorized")}`);
	if (!res.ok || data.result !== "success") {
		throw new ZulipError(`Zulip error (HTTP ${res.status}): ${String(data.msg ?? text.slice(0, 300))}`, res.status, data.code as string);
	}
	return data as T;
}

interface ZulipMessage {
	id: number;
	timestamp: number;
	type: "stream" | "private";
	subject: string;
	sender_full_name: string;
	sender_email: string;
	display_recipient: string | { email: string; full_name: string }[];
	stream_id?: number;
	content: string;
	flags?: string[];
	reactions?: { emoji_name: string; user_id: number }[];
	last_edit_timestamp?: number;
}

function compactMessage(m: ZulipMessage) {
	const reactions: Record<string, number> = {};
	for (const r of m.reactions ?? []) reactions[r.emoji_name] = (reactions[r.emoji_name] ?? 0) + 1;
	return {
		id: m.id,
		time: new Date(m.timestamp * 1000).toISOString(),
		sender: m.sender_full_name,
		sender_email: m.sender_email,
		...(m.type === "stream"
			? { channel: m.display_recipient as string, topic: m.subject }
			: { dm_with: (m.display_recipient as { email: string; full_name: string }[]).map((r) => `${r.full_name} <${r.email}>`) }),
		content: m.content,
		flags: m.flags,
		reactions: Object.keys(reactions).length ? reactions : undefined,
		edited: m.last_edit_timestamp ? true : undefined,
	};
}

export async function channelId(env: Env, channel: string | number): Promise<number> {
	if (typeof channel === "number") return channel;
	if (/^\d+$/.test(channel)) return Number(channel);
	const r = await zulip<{ stream_id: number }>(env, "GET", "/get_stream_id", { stream: channel });
	return r.stream_id;
}

const narrowTerm = z.object({
	operator: z.string().describe("e.g. channel, topic, sender, dm, is, search, has, near, id"),
	operand: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]),
	negated: z.boolean().optional(),
});

export function registerZulipTools(server: McpServer, env: Env) {
	server.registerTool(
		"zulip_get_messages",
		{
			description:
				"Get Zulip messages with a narrow (filter) and full-text search. Convenience filters are combined with AND, and any raw narrow terms are added. Content is raw Markdown.",
			inputSchema: {
				channel: z.string().optional().describe("Channel (stream) name"),
				topic: z.string().optional(),
				sender: z.string().optional().describe("Sender email"),
				dm_with: z.array(z.string()).optional().describe("Direct messages with these user emails"),
				search: z.string().optional().describe("Full-text search"),
				is: z.enum(["unread", "starred", "mentioned", "dm", "followed", "resolved"]).optional(),
				narrow: z.array(narrowTerm).optional().describe("Extra raw narrow terms, see https://zulip.com/api/construct-narrow"),
				anchor: z.string().default("newest").describe('"newest", "oldest", "first_unread" or a message ID'),
				num_before: z.number().int().min(0).max(200).default(20),
				num_after: z.number().int().min(0).max(200).default(0),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async (a) =>
			run(async () => {
				const narrow: z.infer<typeof narrowTerm>[] = [];
				if (a.channel) narrow.push({ operator: "channel", operand: a.channel });
				if (a.topic) narrow.push({ operator: "topic", operand: a.topic });
				if (a.sender) narrow.push({ operator: "sender", operand: a.sender });
				if (a.dm_with?.length) narrow.push({ operator: "dm", operand: a.dm_with.join(",") });
				if (a.search) narrow.push({ operator: "search", operand: a.search });
				if (a.is) narrow.push({ operator: "is", operand: a.is });
				narrow.push(...(a.narrow ?? []));
				const r = await zulip<{ messages: ZulipMessage[]; found_newest: boolean; found_oldest: boolean; anchor: number }>(
					env,
					"GET",
					"/messages",
					{
						anchor: a.anchor,
						num_before: a.num_before,
						num_after: a.num_after,
						narrow,
						apply_markdown: false,
						client_gravatar: true,
					},
				);
				return json({
					anchor: r.anchor,
					found_newest: r.found_newest,
					found_oldest: r.found_oldest,
					count: r.messages.length,
					messages: r.messages.map(compactMessage),
				});
			}),
	);

	server.registerTool(
		"zulip_get_message",
		{
			description: "Get one Zulip message by ID, with raw Markdown content.",
			inputSchema: { message_id: z.number().int().positive() },
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ message_id }) =>
			run(async () => {
				const r = await zulip<{ message: ZulipMessage }>(env, "GET", `/messages/${message_id}`, { apply_markdown: false });
				return json(compactMessage(r.message));
			}),
	);

	server.registerTool(
		"zulip_list_channels",
		{
			description: "List Zulip channels (streams). By default only the channels you are subscribed to.",
			inputSchema: {
				subscribed_only: z.boolean().default(true),
				name_contains: z.string().optional().describe("Case-insensitive filter on the channel name"),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ subscribed_only, name_contains }) =>
			run(async () => {
				type Ch = { stream_id: number; name: string; description: string; invite_only: boolean; is_muted?: boolean };
				const list = subscribed_only
					? (await zulip<{ subscriptions: Ch[] }>(env, "GET", "/users/me/subscriptions")).subscriptions
					: (await zulip<{ streams: Ch[] }>(env, "GET", "/streams")).streams;
				const q = name_contains?.toLowerCase();
				const channels = list
					.filter((c) => !q || c.name.toLowerCase().includes(q))
					.map((c) => ({ id: c.stream_id, name: c.name, description: c.description, private: c.invite_only, muted: c.is_muted }));
				return json({ count: channels.length, channels });
			}),
	);

	server.registerTool(
		"zulip_get_topics",
		{
			description: "List the topics of a Zulip channel, newest first.",
			inputSchema: {
				channel: z.string().describe("Channel name or ID"),
				limit: z.number().int().min(1).max(500).default(50),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ channel, limit }) =>
			run(async () => {
				const id = await channelId(env, channel);
				const r = await zulip<{ topics: { name: string; max_id: number }[] }>(env, "GET", `/users/me/${id}/topics`);
				return json({
					channel_id: id,
					topics: r.topics.slice(0, limit).map((t) => ({ name: t.name, last_message_id: t.max_id })),
				});
			}),
	);

	server.registerTool(
		"zulip_send_channel_message",
		{
			description: `Post a message to a topic in a Zulip channel (stream). Content is Zulip Markdown. ${CONFIRM}`,
			inputSchema: {
				channel: z.string().describe("Channel name or ID"),
				topic: z.string().min(1),
				content: z.string().min(1),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
		},
		async ({ channel, topic, content }) =>
			run(async () => {
				const to = /^\d+$/.test(channel) ? Number(channel) : channel;
				const r = await zulip<{ id: number }>(env, "POST", "/messages", { type: "stream", to, topic, content });
				return json({ sent: true, message_id: r.id });
			}),
	);

	server.registerTool(
		"zulip_send_dm",
		{
			description: `Send a direct message to one or more Zulip users (by email or user ID). Content is Zulip Markdown. ${CONFIRM}`,
			inputSchema: {
				to: z.array(z.union([z.string(), z.number().int()])).min(1).describe("User emails or user IDs"),
				content: z.string().min(1),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
		},
		async ({ to, content }) =>
			run(async () => {
				const r = await zulip<{ id: number }>(env, "POST", "/messages", { type: "direct", to, content });
				return json({ sent: true, message_id: r.id });
			}),
	);

	server.registerTool(
		"zulip_add_reaction",
		{
			description: `Add an emoji reaction to a Zulip message, e.g. "thumbs_up". ${CONFIRM}`,
			inputSchema: { message_id: z.number().int().positive(), emoji_name: z.string().min(1) },
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		},
		async ({ message_id, emoji_name }) =>
			run(async () => {
				await zulip(env, "POST", `/messages/${message_id}/reactions`, { emoji_name });
				return json({ added: true, message_id, emoji_name });
			}),
	);

	server.registerTool(
		"zulip_remove_reaction",
		{
			description: `Remove your emoji reaction from a Zulip message. ${CONFIRM}`,
			inputSchema: { message_id: z.number().int().positive(), emoji_name: z.string().min(1) },
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		},
		async ({ message_id, emoji_name }) =>
			run(async () => {
				await zulip(env, "DELETE", `/messages/${message_id}/reactions`, { emoji_name });
				return json({ removed: true, message_id, emoji_name });
			}),
	);

	server.registerTool(
		"zulip_upload_file",
		{
			description: `Upload a file to Zulip and get its URL. The file is visible to others only after a message links it as [name](url). ${CONFIRM}`,
			inputSchema: {
				filename: z.string().min(1),
				content_base64: z.string().describe("File content, base64 encoded"),
				mime_type: z.string().optional(),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
		},
		async ({ filename, content_base64, mime_type }) =>
			run(async () => {
				const bytes = fromBase64(content_base64);
				const form = new FormData();
				form.append("filename", new Blob([bytes], { type: mime_type || guessMimeType(filename) }), filename);
				const r = await zulip<{ url?: string; uri?: string; filename?: string }>(env, "POST", "/user_uploads", {}, form);
				const path = r.url ?? r.uri ?? "";
				return json({
					uploaded: true,
					url: path,
					absolute_url: new URL(path, ZULIP_SITE).href,
					filename: r.filename ?? filename,
					markdown: `[${filename}](${path})`,
				});
			}),
	);

	server.registerTool(
		"zulip_subscribe",
		{
			description: `Subscribe to one or more Zulip channels by name. ${CONFIRM}`,
			inputSchema: { channels: z.array(z.string().min(1)).min(1) },
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		},
		async ({ channels }) =>
			run(async () => {
				const r = await zulip<{ subscribed: Record<string, string[]>; already_subscribed: Record<string, string[]>; unauthorized?: string[] }>(
					env,
					"POST",
					"/users/me/subscriptions",
					{ subscriptions: channels.map((name) => ({ name })) },
				);
				return json({
					subscribed: Object.values(r.subscribed ?? {}).flat(),
					already_subscribed: Object.values(r.already_subscribed ?? {}).flat(),
					unauthorized: r.unauthorized ?? [],
				});
			}),
	);
}

export async function zulipStatus(env: Env): Promise<PlatformStatus> {
	try {
		const me = await zulip<{ full_name: string; email: string }>(env, "GET", "/users/me");
		return { platform: "zulip", state: "OK", detail: `Logged in as ${me.full_name} <${me.email}>` };
	} catch (e) {
		const detail = e instanceof Error ? e.message : String(e);
		if (e instanceof NotConfiguredError) return { platform: "zulip", state: "not configured", detail };
		if (e instanceof LoginError) return { platform: "zulip", state: "login error", detail };
		return { platform: "zulip", state: "error", detail };
	}
}
