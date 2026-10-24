import { describe, expect, it } from "vitest";
import { CookieJar, parseForm } from "../src/lib/http";
import { parseXml, textOf, xmlToJson } from "../src/lib/xml";
import { flattenArgs } from "../src/platforms/moodle";
import { checkTumonlineError, NoRightsError, TokenNotConfirmedError } from "../src/platforms/tumonline-personal";

describe("xml", () => {
	it("parses TUMonline rowsets with isnull and entities", () => {
		const root = parseXml(
			'<?xml version="1.0" encoding="utf-8"?><rowset><row><lv_titel>Analysis &amp; Lineare Algebra</lv_titel><uninotenamekurz>1,3</uninotenamekurz><weight isnull="true"/></row><row><lv_titel><![CDATA[A <b>B</b>]]></lv_titel></row></rowset>',
		);
		const rowset = root.children[0];
		expect(rowset.name).toBe("rowset");
		expect(rowset.children).toHaveLength(2);
		expect(textOf(rowset.children[0], "lv_titel")).toBe("Analysis & Lineare Algebra");
		expect(rowset.children[0].children[2].attrs.isnull).toBe("true");
		expect(textOf(rowset.children[1], "lv_titel")).toBe("A <b>B</b>");
		expect(xmlToJson(rowset)).toMatchObject({ row: [{ uninotenamekurz: "1,3" }, { lv_titel: "A <b>B</b>" }] });
	});
});

describe("TUMonline errors", () => {
	const err = (m: string) => parseXml(`<?xml version="1.0"?><error><message>${m}</message></error>`);
	it("maps the known messages", () => {
		expect(() => checkTumonlineError(err("Token ist nicht bestätigt!"), "noten")).toThrow(TokenNotConfirmedError);
		expect(() => checkTumonlineError(err('Keine Rechte für Funktion "noten"'), "noten")).toThrow(NoRightsError);
		expect(() => checkTumonlineError(err("Token ist ungültig!"), "id")).toThrow(/invalid/);
		expect(() => checkTumonlineError(parseXml("<rowset></rowset>"), "id")).not.toThrow();
	});
});

describe("moodle args", () => {
	it("encodes nested arrays and objects like PHP", () => {
		const p = flattenArgs({ courseids: [3, 7], plugindata: { onlinetext_editor: { text: "<p>x</p>", format: 1 } }, flag: true });
		expect([...p.entries()]).toEqual([
			["courseids[0]", "3"],
			["courseids[1]", "7"],
			["plugindata[onlinetext_editor][text]", "<p>x</p>"],
			["plugindata[onlinetext_editor][format]", "1"],
			["flag", "1"],
		]);
	});
});

describe("http helpers", () => {
	it("stores and sends cookies per host", () => {
		const jar = new CookieJar();
		const res = new Response(null, { headers: [["Set-Cookie", "jwt=abc; Path=/; HttpOnly"], ["Set-Cookie", "x=1; Domain=.tum.de"]] });
		jar.store(new URL("https://live.rbg.tum.de/shib"), res);
		expect(jar.get("live.rbg.tum.de", "jwt")).toBe("abc");
		expect(jar.header(new URL("https://live.rbg.tum.de/api"))).toBe("jwt=abc; x=1");
		expect(jar.header(new URL("https://login.tum.de/"))).toBe("x=1");
		expect(new CookieJar(jar.toJSON()).get("live.rbg.tum.de", "jwt")).toBe("abc");
	});

	it("reads a SAML auto-submit form", () => {
		const html = '<form action="https&#x3a;&#x2f;&#x2f;www.moodle.tum.de&#x2f;Shibboleth.sso&#x2f;SAML2&#x2f;POST" method="post"><input type="hidden" name="RelayState" value="ss&#x3a;mem&#x3a;1"/><input type="hidden" name="SAMLResponse" value="PD94bWw="/></form>';
		const f = parseForm(html, new URL("https://login.tum.de/idp/profile/SAML2/Redirect/SSO?execution=e1s3"));
		expect(f?.action.href).toBe("https://www.moodle.tum.de/Shibboleth.sso/SAML2/POST");
		expect(f?.fields).toEqual({ RelayState: "ss:mem:1", SAMLResponse: "PD94bWw=" });
	});
});
