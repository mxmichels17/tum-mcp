// Shared helpers for MCP tool handlers.

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Required sentence for every tool that sends, posts or submits something. */
export const CONFIRM = "Call only after the user said yes.";

export type PlatformState = "OK" | "not configured" | "login error" | "token not activated" | "error" | "not implemented";

export interface PlatformStatus {
	platform: string;
	state: PlatformState;
	detail?: string;
}

export class NotConfiguredError extends Error {
	constructor(
		public platform: string,
		public missing: string[],
	) {
		super(`${platform} is not configured. Missing Worker secrets: ${missing.join(", ")}`);
	}
}

export class LoginError extends Error {}

/** Reads secrets and throws NotConfiguredError when any is empty. */
export function requireSecrets<K extends keyof Env>(env: Env, platform: string, names: K[]): Record<K, string> {
	const out = {} as Record<K, string>;
	const missing: string[] = [];
	for (const n of names) {
		const v = env[n];
		if (typeof v !== "string" || v.trim() === "") missing.push(String(n));
		else out[n] = v;
	}
	if (missing.length) throw new NotConfiguredError(platform, missing);
	return out;
}

export function json(data: unknown): CallToolResult {
	return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function errorResult(e: unknown): CallToolResult {
	const message = e instanceof Error ? e.message : String(e);
	return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/** Runs a handler and turns thrown errors into an MCP error result. */
export async function run(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
	try {
		return await fn();
	} catch (e) {
		return errorResult(e);
	}
}

export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)} s`)), ms);
	});
	try {
		return await Promise.race([p, timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

export function truncate(s: string, max: number): { text: string; truncated: boolean } {
	if (s.length <= max) return { text: s, truncated: false };
	return { text: s.slice(0, max), truncated: true };
}
