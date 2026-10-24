// Login through the TUM identity provider (Shibboleth at login.tum.de) with TUM_USER and TUM_PASSWORD.
// Used for services without an API token (Moodle session fallback). Flow checked by hand on 2026-10-17:
// SP redirect -> login.tum.de e1s1 (local storage probe) -> e1s2 (j_username, j_password)
// -> optional attribute release consent -> auto-submit form with SAMLResponse -> SP session cookie.

import { CookieJar, formBody, type JarResponse, jarFetch, parseForm } from "./http";
import { LoginError, requireSecrets } from "./tools";

function title(html: string): string {
	return /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? "unknown page";
}

function idpError(html: string): string | undefined {
	const m = /<(?:p|div|section)[^>]*class="[^"]*(?:output--error|form-error|error)[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div|section)>/i.exec(html);
	return m ? m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : undefined;
}

/**
 * Runs the SAML login that starts at `startUrl` (an SP URL that redirects to login.tum.de).
 * Returns the final page after the SP accepted the SAML response. The jar holds the SP session.
 * `headers` are sent with every request (an SP that expects browser headers).
 * `log` gets one line per login.tum.de step: page kind and field names, never values.
 */
export async function tumSsoLogin(env: Env, jar: CookieJar, startUrl: string, headers?: Record<string, string>, log?: string[]): Promise<JarResponse> {
	const { TUM_USER, TUM_PASSWORD } = requireSecrets(env, "TUM SSO", ["TUM_USER", "TUM_PASSWORD"]);
	let page = await jarFetch(jar, startUrl, { headers });
	if (page.url.hostname === "login.tum.de" && !parseForm(page.text, page.url)) {
		// Seen when two logins run at the same time: the IdP answers without a form. Start once more.
		page = await jarFetch(jar, startUrl, { headers });
	}
	let credentialsSent = false;
	for (let step = 0; step < 8; step++) {
		const html = page.text;
		if (page.url.hostname !== "login.tum.de" && !/name="SAMLResponse"/.test(html)) return page;
		const form = parseForm(html, page.url);
		log?.push(`${page.url.pathname}${page.url.searchParams.get("execution") ? `?execution=${page.url.searchParams.get("execution")}` : ""} "${title(html)}" fields: ${Object.keys(form?.fields ?? {}).join(",") || "none"}`);
		if (/name="SAMLResponse"/.test(html) && form) {
			page = await jarFetch(jar, form.action, { method: "POST", body: formBody(form, form.fields), headers });
			continue;
		}
		if (!form) throw new Error(`TUM login: unexpected page "${title(html)}" (HTTP ${page.status}) at ${page.url.origin}${page.url.pathname}`);
		if (/name="j_password"/.test(html)) {
			if (credentialsSent) throw new LoginError(`TUM login failed: ${idpError(html) ?? "username or password rejected"}`);
			credentialsSent = true;
			const fields: Record<string, string> = { ...form.fields, j_username: TUM_USER, j_password: TUM_PASSWORD, _eventId_proceed: "" };
			delete fields["donotcache-dummy"];
			delete fields._shib_idp_revokeConsent;
			page = await jarFetch(jar, form.action, { method: "POST", body: formBody(form, fields), headers });
			continue;
		}
		if (/otp|totp|zweite[rn]? faktor|second factor|two-factor|2fa/i.test(html) && !/name="shib_idp_ls_supported"/.test(html)) {
			throw new LoginError("TUM login asks for a second factor (2FA). Automatic login is not possible for this account.");
		}
		const fields = { ...form.fields };
		if ("shib_idp_ls_supported" in fields) fields.shib_idp_ls_supported = "false";
		if (/_shib_idp_consentOptions/.test(html)) {
			fields._shib_idp_consentOptions = "_shib_idp_rememberConsent";
			const ids = [...html.matchAll(/name="_shib_idp_consentIds"[^>]*value="([^"]*)"|value="([^"]*)"[^>]*name="_shib_idp_consentIds"/g)].map((x) => x[1] ?? x[2]);
			log?.push(`consent: accept, remember; attributes ${ids.join(",") || "none listed"}`);
		}
		fields._eventId_proceed = "";
		page = await jarFetch(jar, form.action, { method: "POST", body: formBody(form, fields), headers });
	}
	throw new Error(`TUM login did not finish. Last page: "${title(page.text)}" (HTTP ${page.status}) at ${page.url.origin}${page.url.pathname}`);
}
