// "server_info": which deployed version answers, and which tools this MCP session has.
// Use it to tell a stale tool list in the client apart from a server problem.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { json, run } from "../lib/tools";
import { CAPABILITIES, NEW_IN_VERSION } from "./capabilities";

export function registerServerInfoTool(server: McpServer, env: Env, version: string, failedGroups: string[]) {
	server.registerTool(
		"server_info",
		{
			description:
				"Server version, deployed Worker version, the full list of tools registered in this MCP session, and per platform what works and what the platform blocks (and why). If the client shows fewer tools than listed here, reconnect the connector in claude.ai.",
			inputSchema: {},
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async () =>
			run(async () => {
				// The SDK keeps registered tools in a private map. Read it for diagnostics only.
				const tools = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools ?? {}).sort();
				const meta = env.CF_VERSION_METADATA;
				return json({
					server_version: version,
					worker_version: meta ? { id: meta.id, tag: meta.tag || undefined, deployed: meta.timestamp } : undefined,
					tool_count: tools.length,
					failed_tool_groups: failedGroups.length ? failedGroups : undefined,
					new_in_version: NEW_IN_VERSION,
					tools,
					capabilities: CAPABILITIES,
				});
			}),
	);
}
