// "status": one line per platform: OK / not configured / login error.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { json, type PlatformStatus, run, withTimeout } from "../lib/tools";
import { artemisStatus } from "./artemis";
import { itsScoreboardStatus } from "./its-scoreboard";
import { mailStatus } from "./mail";
import { moodleStatus } from "./moodle";
import { moodleFeedStatus } from "./moodle-feeds";
import { tumonlineStatus } from "./tumonline";
import { tumonlinePersonalStatus } from "./tumonline-personal";
import { tumliveStatus } from "./tumlive";
import { zulipStatus } from "./zulip";

export function registerStatusTool(server: McpServer, env: Env) {
	server.registerTool(
		"status",
		{
			description:
				"Check every TUM platform connection. Reports OK, not configured (Worker secret missing), login error, token not activated or error. Tests real logins, so it can take up to 55 seconds. Logins are cached, so later calls are faster.",
			inputSchema: {},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async () =>
			run(async () => {
				const settle = (p: Promise<PlatformStatus>, platform: string, ms = 40_000): Promise<PlatformStatus> =>
					withTimeout(p, ms, platform).catch((e) => ({ platform, state: "error" as const, detail: e instanceof Error ? e.message : String(e) }));
				const [mail, ...rest] = await Promise.all([
					mailStatus(env),
					settle(zulipStatus(env), "zulip"),
					settle(tumonlineStatus(), "tumonline (public)"),
					settle(tumonlinePersonalStatus(env), "tumonline (personal)"),
					settle(artemisStatus(env), "artemis"),
					moodleFeedStatus(env),
					// Moodle (session mode), TUM-Live and the ITS scoreboard log in through TUM SSO.
					// Parallel SSO logins failed in tests, so these run one after the other.
					(async () => [
						await settle(moodleStatus(env), "moodle", 18_000),
						await settle(tumliveStatus(env), "tumlive", 18_000),
						await settle(itsScoreboardStatus(env), "its scoreboard", 18_000),
					])(),
				]);
				return json({ platforms: [...mail, ...rest.flat()] });
			}),
	);
}
