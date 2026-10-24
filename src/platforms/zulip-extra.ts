// More Zulip tools: edit and delete own messages, read state, users, subscription management.
// API: https://zulip.com/api/ (zulip.cit.tum.de runs Zulip 12.0, feature level 498).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CONFIRM, json, run } from "../lib/tools";
import { channelId, zulip } from "./zulip";

interface ZUser {
	user_id: number;
	full_name: string;
	email: string;
	delivery_email?: string | null;
	is_active: boolean;
	is_bot: boolean;
	role?: number;
	timezone?: string;
	date_joined?: string;
	profile_data?: Record<string, { value: string }>;
}

const ROLES: Record<number, string> = { 100: "owner", 200: "administrator", 300: "moderator", 400: "member", 600: "guest" };

function userSummary(u: ZUser) {
	return {
		id: u.user_id,
		name: u.full_name,
		email: u.delivery_email || u.email,
		role: u.role ? ROLES[u.role] : undefined,
		bot: u.is_bot || undefined,
		active: u.is_active,
		timezone: u.timezone || undefined,
	};
}

async function myId(env: Env): Promise<number> {
	return (await zulip<{ user_id: number }>(env, "GET", "/users/me")).user_id;
}

/** Loads a message and refuses when it was not sent by me. */
async function ownMessage(env: Env, messageId: number) {
	const [me, r] = await Promise.all([
		myId(env),
		zulip<{ message: { id: number; sender_id: number; content: string; subject: string } }>(env, "GET", `/messages/${messageId}`, { apply_markdown: false }),
	]);
	if (r.message.sender_id !== me) throw new Error(`Message ${messageId} was not sent by you. Only your own messages can be changed.`);
	return r.message;
}

export function registerZulipExtraTools(server: McpServer, env: Env) {
	const ro = { readOnlyHint: true, openWorldHint: true };

	server.registerTool(
		"zulip_edit_message",
		{
			description: `Edit the content (and optionally the topic) of one of my own Zulip messages. ${CONFIRM}`,
			inputSchema: {
				message_id: z.number().int().positive(),
				content: z.string().min(1).optional(),
				topic: z.string().min(1).optional().describe("New topic (only this message)"),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		},
		async ({ message_id, content, topic }) =>
			run(async () => {
				if (!content && !topic) throw new Error("Give content or topic");
				const before = await ownMessage(env, message_id);
				await zulip(env, "PATCH", `/messages/${message_id}`, { content, topic, propagate_mode: topic ? "change_one" : undefined });
				return json({ edited: true, message_id, previous_content: before.content.slice(0, 500) });
			}),
	);

	server.registerTool(
		"zulip_delete_message",
		{
			description: `Delete one of my own Zulip messages. Zulip only allows this if the organization permits it. ${CONFIRM}`,
			inputSchema: { message_id: z.number().int().positive() },
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
		},
		async ({ message_id }) =>
			run(async () => {
				await ownMessage(env, message_id);
				await zulip(env, "DELETE", `/messages/${message_id}`);
				return json({ deleted: true, message_id });
			}),
	);

	server.registerTool(
		"zulip_mark_read",
		{
			description: "Mark Zulip messages as read: given message IDs, a whole topic, or a whole channel.",
			inputSchema: {
				message_ids: z.array(z.number().int().positive()).optional(),
				channel: z.string().optional().describe("Channel name or ID (alone: the whole channel)"),
				topic: z.string().optional().describe("With channel: only this topic"),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		},
		async ({ message_ids, channel, topic }) =>
			run(async () => {
				if (message_ids?.length) {
					const r = await zulip<{ messages: number[] }>(env, "POST", "/messages/flags", { messages: message_ids, op: "add", flag: "read" });
					return json({ marked_read: r.messages.length });
				}
				if (!channel) throw new Error("Give message_ids, or a channel (and optionally a topic)");
				const id = await channelId(env, channel);
				const narrow: { operator: string; operand: string | number }[] = [{ operator: "channel", operand: id }];
				if (topic) narrow.push({ operator: "topic", operand: topic });
				narrow.push({ operator: "is", operand: "unread" });
				let total = 0;
				let anchor: string | number = "oldest";
				for (let i = 0; i < 20; i++) {
					type FlagResult = { updated_count: number; found_newest: boolean; last_processed_id: number | null };
					const r: FlagResult = await zulip<FlagResult>(env, "POST", "/messages/flags/narrow", {
						anchor,
						include_anchor: anchor === "oldest",
						num_before: 0,
						num_after: 1000,
						narrow,
						op: "add",
						flag: "read",
					});
					total += r.updated_count;
					if (r.found_newest || r.last_processed_id == null) break;
					anchor = r.last_processed_id;
				}
				return json({ marked_read: total, channel_id: id, topic });
			}),
	);

	server.registerTool(
		"zulip_users",
		{
			description: "Find Zulip users by name or email (filter is case-insensitive). The organization is large, so give a filter.",
			inputSchema: { query: z.string().min(2), limit: z.number().int().min(1).max(100).default(20) },
			annotations: ro,
		},
		async ({ query, limit }) =>
			run(async () => {
				const r = await zulip<{ members: ZUser[] }>(env, "GET", "/users", { client_gravatar: true, include_custom_profile_fields: false });
				const q = query.toLowerCase();
				const hits = r.members.filter((u) => u.is_active && (u.full_name.toLowerCase().includes(q) || (u.delivery_email || u.email).toLowerCase().includes(q)));
				return json({ total_members: r.members.length, count: hits.length, users: hits.slice(0, limit).map(userSummary) });
			}),
	);

	server.registerTool(
		"zulip_user",
		{
			description: "Details of one Zulip user by ID or email, including custom profile fields and presence.",
			inputSchema: { user: z.union([z.number().int().positive(), z.string().min(3)]).describe("User ID or email") },
			annotations: ro,
		},
		async ({ user }) =>
			run(async () => {
				const r = await zulip<{ user: ZUser }>(env, "GET", `/users/${encodeURIComponent(String(user))}`, { include_custom_profile_fields: true });
				let presence: unknown;
				try {
					presence = (await zulip<{ presence: unknown }>(env, "GET", `/users/${r.user.user_id}/presence`)).presence;
				} catch {
					presence = undefined;
				}
				return json({ ...userSummary(r.user), joined: r.user.date_joined, profile: r.user.profile_data, presence });
			}),
	);

	server.registerTool(
		"zulip_subscriptions",
		{
			description: "My Zulip channel subscriptions with muted state, pin state and unread hint.",
			inputSchema: { name_contains: z.string().optional() },
			annotations: ro,
		},
		async ({ name_contains }) =>
			run(async () => {
				type Sub = { stream_id: number; name: string; is_muted: boolean; pin_to_top: boolean; desktop_notifications: boolean | null; description: string };
				const r = await zulip<{ subscriptions: Sub[] }>(env, "GET", "/users/me/subscriptions");
				const q = name_contains?.toLowerCase();
				const subs = r.subscriptions
					.filter((s) => !q || s.name.toLowerCase().includes(q))
					.map((s) => ({ id: s.stream_id, name: s.name, muted: s.is_muted, pinned: s.pin_to_top, description: s.description.slice(0, 200) }));
				return json({ count: subs.length, subscriptions: subs });
			}),
	);

	server.registerTool(
		"zulip_unsubscribe",
		{
			description: `Unsubscribe from one or more Zulip channels by name. ${CONFIRM}`,
			inputSchema: { channels: z.array(z.string().min(1)).min(1) },
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		},
		async ({ channels }) =>
			run(async () => {
				const r = await zulip<{ removed: string[]; not_removed: string[] }>(env, "DELETE", "/users/me/subscriptions", { subscriptions: channels });
				return json({ removed: r.removed, not_removed: r.not_removed });
			}),
	);

	server.registerTool(
		"zulip_set_subscription",
		{
			description: "Change my settings for a subscribed Zulip channel: mute or unmute, pin or unpin.",
			inputSchema: {
				channel: z.string().describe("Channel name or ID"),
				muted: z.boolean().optional(),
				pinned: z.boolean().optional(),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		},
		async ({ channel, muted, pinned }) =>
			run(async () => {
				const id = await channelId(env, channel);
				const data: { stream_id: number; property: string; value: boolean }[] = [];
				if (muted !== undefined) data.push({ stream_id: id, property: "is_muted", value: muted });
				if (pinned !== undefined) data.push({ stream_id: id, property: "pin_to_top", value: pinned });
				if (!data.length) throw new Error("Give muted or pinned");
				await zulip(env, "POST", "/users/me/subscriptions/properties", { subscription_data: data });
				return json({ channel_id: id, muted, pinned });
			}),
	);
}
