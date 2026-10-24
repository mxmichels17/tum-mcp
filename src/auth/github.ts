// GitHub login for the OAuth flow of the MCP server.
// Flow and helpers: @cloudflare/workers-oauth-provider docs/upstream-sign-in.md and docs/consent-page.md.

import {
	type AuthRequest,
	AuthorizationError,
	authorizationErrorRedirect,
	CimdFetchError,
	type ConsentDescription,
	type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";

/** The only GitHub account that may log in (secret ALLOWED_GITHUB_LOGIN). Without it nobody can log in. */
export const allowedLogin = (env: Env): string => (env.ALLOWED_GITHUB_LOGIN ?? "").trim();

export const isAllowedLogin = (env: Env, login: string | undefined): boolean => {
	const allowed = allowedLogin(env);
	return !!allowed && !!login && login.toLowerCase() === allowed.toLowerCase();
};

export type Props = {
	login: string;
	name: string;
};

type Bindings = Env & { OAUTH_PROVIDER: OAuthHelpers };

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string, status = 200, headers = new Headers()): Response {
	headers.set("Content-Type", "text/html; charset=utf-8");
	return new Response(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;line-height:1.5}button{font-size:1rem;padding:.5rem 1rem;margin-right:.5rem}.warn{color:#a40}</style></head>
<body>${body}</body></html>`,
		{ status, headers },
	);
}

function consentPage(d: ConsentDescription, handle: string, headers: Headers, allowed: string): Response {
	const name = escape(d.clientName);
	const origin = d.clientDomain
		? `Published by <strong>${escape(d.clientDomain)}</strong>.`
		: "This app registered itself. Its name is not verified.";
	return page(
		`Authorize ${d.clientName}`,
		`<h1>TUM MCP</h1>
<p>Allow <strong>${name}</strong> to use your TUM tools (mail, Zulip, TUMonline)?</p>
<p>${origin} Access will be sent to <strong>${escape(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? '<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>' : ""}
<p>You will sign in with GitHub next. Only the account <code>${escape(allowed || "(none configured)")}</code> is accepted.</p>
<form method="post">
<input type="hidden" name="handle" value="${escape(handle)}">
${d.scope.map((s) => `<input type="hidden" name="scope" value="${escape(s)}">`).join("")}
<button name="decision" value="approve">Allow</button><button name="decision" value="deny">Deny</button>
</form>`,
		200,
		headers,
	);
}

function errorPage(e: unknown): Response {
	if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
	if (e instanceof AuthorizationError || e instanceof CimdFetchError) {
		const message = e instanceof AuthorizationError ? e.description : "This app could not be verified.";
		return page("Authorization error", `<h1>Authorization error</h1><p>${escape(message ?? "Invalid request")}</p><p>Start the connection again from Claude.</p>`, 400);
	}
	throw e;
}

/** Remembered consent (signed cookie, 30 days). Off when COOKIE_ENCRYPTION_KEY is missing or too short. */
function rememberOptions(env: Env): { secret: string } | undefined {
	const secret = env.COOKIE_ENCRYPTION_KEY?.trim();
	return secret && secret.length >= 32 ? { secret } : undefined;
}

async function redirectToGithub(
	env: Env,
	oauth: OAuthHelpers,
	reqUrl: string,
	authRequest: AuthRequest,
	headers?: Headers,
): Promise<Response> {
	const verifier = crypto.randomUUID() + crypto.randomUUID();
	const upstream = await oauth.beginUpstream(authRequest, { data: { verifier }, headers });
	const url = new URL("https://github.com/login/oauth/authorize");
	url.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
	url.searchParams.set("redirect_uri", new URL("/callback", reqUrl).href);
	url.searchParams.set("scope", "read:user");
	url.searchParams.set("state", upstream.state);
	url.searchParams.set("code_challenge", await s256(verifier));
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("allow_signup", "false");
	upstream.headers.set("Location", url.href);
	return new Response(null, { status: 302, headers: upstream.headers });
}

async function s256(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

const app = new Hono<{ Bindings: Bindings }>();

app.get("/", (c) => c.text("TUM MCP server. Connect from claude.ai with the URL <this origin>/mcp."));

app.get("/authorize", async (c) => {
	try {
		const oauth = c.env.OAUTH_PROVIDER;
		const request = await oauth.parseAuthRequest(c.req.raw);
		const remember = rememberOptions(c.env);
		if (remember && (await oauth.isConsentRemembered(c.req.raw, request, remember))) {
			return redirectToGithub(c.env, oauth, c.req.url, request);
		}
		const details = await oauth.describeConsent(request);
		const consent = await oauth.beginConsent(request);
		return consentPage(details, consent.handle, consent.headers, allowedLogin(c.env));
	} catch (e) {
		return errorPage(e);
	}
});

app.post("/authorize", async (c) => {
	try {
		const oauth = c.env.OAUTH_PROVIDER;
		const form = await c.req.raw.formData();
		const handle = String(form.get("handle") ?? "");
		if (form.get("decision") !== "approve") {
			const denied = await oauth.denyConsent(c.req.raw, handle);
			denied.headers.set("Location", denied.redirectTo);
			return new Response(null, { status: 302, headers: denied.headers });
		}
		const approved = await oauth.approveConsent(c.req.raw, handle, {
			scope: form.getAll("scope").map(String),
			remember: rememberOptions(c.env),
		});
		return redirectToGithub(c.env, oauth, c.req.url, approved.request, approved.headers);
	} catch (e) {
		return errorPage(e);
	}
});

app.get("/callback", async (c) => {
	try {
		const oauth = c.env.OAUTH_PROVIDER;
		const { request, data, headers } = await oauth.finishUpstream<{ verifier: string }>(c.req.raw);
		const params = new URL(c.req.url).searchParams;
		const code = params.get("code");
		if (params.get("error") || !code) {
			headers.set("Location", authorizationErrorRedirect(request, "access_denied"));
			return new Response(null, { status: 302, headers });
		}

		const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
			method: "POST",
			headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: c.env.GITHUB_CLIENT_ID,
				client_secret: c.env.GITHUB_CLIENT_SECRET,
				code,
				redirect_uri: new URL("/callback", c.req.url).href,
				code_verifier: data.verifier,
			}),
		});
		const token = (await tokenRes.json()) as { access_token?: string; error_description?: string };
		if (!token.access_token) {
			return page("GitHub login failed", `<h1>GitHub login failed</h1><p>${escape(token.error_description ?? "No access token")}</p>`, 502);
		}
		const userRes = await fetch("https://api.github.com/user", {
			headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/vnd.github+json", "User-Agent": "tum-mcp" },
		});
		if (!userRes.ok) return page("GitHub login failed", "<h1>GitHub login failed</h1><p>Could not read the GitHub user.</p>", 502);
		const user = (await userRes.json()) as { login: string; name: string | null };

		if (!isAllowedLogin(c.env, user.login)) {
			console.warn(`Rejected GitHub login: ${user.login}`);
			headers.set("Location", authorizationErrorRedirect(request, "access_denied"));
			return new Response(null, { status: 302, headers });
		}

		// The GitHub token is not kept. The MCP server only needs to know who logged in.
		const { redirectTo } = await oauth.completeAuthorization({
			request,
			userId: user.login,
			metadata: { label: user.name ?? user.login },
			scope: request.scope,
			props: { login: user.login, name: user.name ?? user.login } satisfies Props,
		});
		headers.set("Location", redirectTo);
		return new Response(null, { status: 302, headers });
	} catch (e) {
		return errorPage(e);
	}
});

export { app as GitHubHandler };
