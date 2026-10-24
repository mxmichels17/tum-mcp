// Zulip unit: every message of the combined feed (subscribed channels and direct messages).
// Each run reads the newest RECENT messages again, so edits, moves, reactions and deletions in that range
// are seen. Older history is read once, page by page from the newest backwards, back to MAIL_SINCE (scope.ts).

import { ZULIP_SITE, zulip } from "../../platforms/zulip";
import type { Entry } from "../model";
import { toJson } from "../model";
import { MAIL_SINCE_UNIX } from "../scope";
import { forget, getState, setState, storedKeys } from "../store";
import { item, type UnitCtx } from "../unit";

const RECENT = 500;
const PAGE = 1000;
/** History pages per invocation. Each page writes up to 2 rows per message (item and delta). */
const MAX_PAGES = 3;

type Msg = Record<string, unknown> & { id: number; timestamp: number; type: string; subject: string; display_recipient: unknown };

/** Window key of a message: its id, zero padded, so ids compare as strings. */
export const winOf = (id: number) => String(id).padStart(12, "0");

function entry(m: Msg): Entry {
	const key = `zulip:msg:${m.id}`;
	const { flags: _flags, ...raw } = m;
	const where =
		m.type === "stream"
			? `#${String(m.display_recipient)} > ${m.subject}`
			: `DM ${(m.display_recipient as { full_name: string }[]).map((p) => p.full_name).join(", ")}`;
	return { key, window: winOf(m.id), item: item("zulip", key, where, `${ZULIP_SITE}/#narrow/near/${m.id}`, { message: toJson(raw) }) };
}

async function page(ctx: UnitCtx, anchor: string | number, before: number, after: number) {
	return zulip<{ messages: Msg[]; found_oldest: boolean; found_newest: boolean }>(ctx.env, "GET", "/messages", {
		anchor,
		include_anchor: false,
		num_before: before,
		num_after: after,
		narrow: [],
		apply_markdown: false,
	});
}

const inScope = (m: Msg) => Number(m.timestamp) >= MAIL_SINCE_UNIX;

export async function unitZulip(ctx: UnitCtx): Promise<void> {
	const db = ctx.env.DB;
	// Scope: messages from MAIL_SINCE on. Stored older ones are forgotten without a delta.
	await forget(ctx.env, await storedKeys(db, "scope = 'zulip:messages' AND CAST(json_extract(content, '$.message.timestamp') AS INTEGER) < ?", MAIL_SINCE_UNIX));
	const recent = await page(ctx, "newest", RECENT, 0);
	const msgs = recent.messages.filter(inScope);
	if (msgs.length) {
		await ctx.apply({ scope: "zulip:messages", complete: true, windowFrom: winOf(msgs[0].id), entries: msgs.map(entry) });
	}
	// History before the recent range, once, back to MAIL_SINCE.
	const reachedLimit = recent.messages.length > msgs.length;
	let oldest = (await getState<number | "done">(db, "zulip:history_before")) ?? (recent.found_oldest || reachedLimit ? "done" : msgs[0]?.id);
	for (let i = 0; i < MAX_PAGES && typeof oldest === "number"; i++) {
		if (ctx.writesLeft() < PAGE * 3) {
			ctx.note("history paused: D1 daily write budget");
			break;
		}
		const p = await page(ctx, oldest, PAGE, 0);
		const mine = p.messages.filter(inScope);
		if (mine.length) await ctx.apply({ scope: "zulip:messages", complete: false, entries: mine.map(entry) });
		oldest = p.found_oldest || !p.messages.length || mine.length < p.messages.length ? "done" : p.messages[0].id;
	}
	if (oldest !== undefined) await setState(db, "zulip:history_before", oldest);
	await setState(db, "backlog:zulip:history", typeof oldest === "number" ? `messages before id ${oldest} not read yet` : null);
}
