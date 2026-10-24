import { describe, expect, it } from "vitest";
import { CookieJar, cookieExpired, cookieLogLine, formBody, parseForm } from "../src/lib/http";

function res(...cookies: string[]) {
	const h = new Headers();
	for (const c of cookies) h.append("Set-Cookie", c);
	return new Response(null, { headers: h });
}

describe("CookieJar paths", () => {
	it("keeps the same name for different paths and sends only the matching ones", () => {
		const jar = new CookieJar();
		const host = new URL("https://campus.tum.de/");
		jar.store(host, res("AUTH_SESSION_ID=SP;Version=1;Path=/auth/realms/SP/", "TS=1; Path=/"));
		jar.store(host, res("AUTH_SESSION_ID=IDP;Version=1;Path=/auth/realms/IDP/"));
		expect(jar.header(new URL("https://campus.tum.de/auth/realms/SP/broker/x"))).toBe("AUTH_SESSION_ID=SP; TS=1");
		expect(jar.header(new URL("https://campus.tum.de/auth/realms/IDP/login"))).toBe("AUTH_SESSION_ID=IDP; TS=1");
		expect(jar.header(new URL("https://campus.tum.de/tumonline/ee/rest/x"))).toBe("TS=1");
		expect(jar.header(new URL("https://campus.tum.de/auth/realms/SPX/"))).toBe("TS=1");
		expect(jar.get("campus.tum.de", "AUTH_SESSION_ID")).toBe("SP");
	});

	it("deletes per path and survives a JSON round trip", () => {
		const jar = new CookieJar();
		const u = new URL("https://a.de/");
		jar.store(u, res("K=1; Path=/x", "K=2; Path=/y"));
		jar.store(u, res("K=; Path=/x; Max-Age=0"));
		const copy = new CookieJar(JSON.parse(JSON.stringify(jar.toJSON())));
		expect(copy.header(new URL("https://a.de/x"))).toBeUndefined();
		expect(copy.header(new URL("https://a.de/y/z"))).toBe("K=2");
	});

	it("reads sessions stored before path support as path /", () => {
		const jar = new CookieJar({ "www.moodle.tum.de": { MoodleSession: "abc" } });
		expect(jar.header(new URL("https://www.moodle.tum.de/course/view.php?id=1"))).toBe("MoodleSession=abc");
	});
});

describe("parseForm", () => {
	it("leaves out submit buttons and unchecked radios, as a browser does", () => {
		const f = parseForm(
			'<form action="/x"><input type="hidden" name="a" value="1"><input type="radio" name="r" value="no"><input type="radio" name="r" value="yes" checked><input type="checkbox" name="c" value="1"><input type="submit" name="_eventId_AttributeReleaseRejected" value="Reject"><input type="submit" name="_eventId_proceed" value="Accept"></form>',
			new URL("https://login.tum.de/idp/"),
		);
		expect(f?.fields).toEqual({ a: "1", r: "yes" });
	});

	it("keeps every value of a repeated field (one consent id per attribute)", () => {
		const f = parseForm('<form action="/x"><input type="hidden" name="id" value="uid"><input type="hidden" name="id" value="email"><input type="hidden" name="o" value="1"></form>', new URL("https://a.de/"));
		if (!f) throw new Error("no form");
		expect(formBody(f, { ...f.fields, _eventId_proceed: "" }).toString()).toBe("id=uid&id=email&o=1&_eventId_proceed=");
		expect(formBody(f, { ...f.fields, id: "x" }).toString()).toBe("id=x&o=1");
	});
});

describe("cookie expiry and log", () => {
	it("treats Max-Age <= 0 and any past Expires as deleted, Max-Age before Expires", () => {
		const now = Date.parse("2026-10-20T17:00:00Z");
		expect(cookieExpired(["Max-Age=0"], now)).toBe(true);
		expect(cookieExpired(["Max-Age=-1"], now)).toBe(true);
		expect(cookieExpired(["Expires=Thu, 01-Jan-1970 00:00:10 GMT"], now)).toBe(true);
		expect(cookieExpired(["Expires=Mon, 19 Oct 2026 10:00:00 GMT"], now)).toBe(true);
		expect(cookieExpired(["Expires=Wed, 21-Oct-2026 10:00:00 GMT"], now)).toBe(false);
		expect(cookieExpired(["Max-Age=60", "Expires=Thu, 01-Jan-1970 00:00:10 GMT"], now)).toBe(false);
		expect(cookieExpired(["Path=/"], now)).toBe(false);
		const jar = new CookieJar();
		const u = new URL("https://campus.tum.de/a");
		const h = new Headers();
		h.append("Set-Cookie", "OLD=1; Path=/");
		jar.store(u, new Response(null, { headers: h }));
		const h2 = new Headers();
		h2.append("Set-Cookie", "OLD=x; Expires=Mon, 19 Oct 2020 10:00:00 GMT; Path=/");
		jar.store(u, new Response(null, { headers: h2 }));
		expect(jar.header(u)).toBeUndefined();
	});

	it("logs cookie names, paths and SameSite, never values", () => {
		const h = new Headers();
		h.append("Set-Cookie", "AUTH_SESSION_ID=SECRETVALUE;Version=1;Path=/realms/SP/;Secure;HttpOnly;SameSite=None");
		h.append("Set-Cookie", "KC_RESTART=; Version=1; Expires=Thu, 01-Jan-1970 00:00:10 GMT; Max-Age=0; Path=/realms/SP/");
		const line = cookieLogLine("GET", new Response(null, { status: 302, headers: h }), new URL("https://campus.tum.de/realms/SP/x?code=CODEVALUE"), "TS01=TSVALUE; CO_LANG=de");
		expect(line).toBe("GET 302 campus.tum.de/realms/SP/x | sent: TS01,CO_LANG | set: AUTH_SESSION_ID(/realms/SP/,None) KC_RESTART(/realms/SP/,-,deleted)");
		expect(line).not.toMatch(/SECRETVALUE|CODEVALUE|TSVALUE/);
	});
});
