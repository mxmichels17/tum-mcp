import { afterEach, describe, expect, it, vi } from "vitest";
import { rawCall } from "../src/platforms/tumonline-personal";

const env = { TUMONLINE_TOKEN: "SECRETTOKEN123" } as unknown as Env;

describe("tumonline_token_raw", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("returns the raw XML as JSON and text, without the token", async () => {
		const seen: string[] = [];
		vi.stubGlobal("fetch", async (u: URL) => {
			seen.push(String(u));
			return new Response("<rowset><row><titel>Prüfung</titel><echo>SECRETTOKEN123</echo></row></rowset>", { status: 200, headers: { "Content-Type": "text/xml" } });
		});
		const r = await rawCall(env, "pruefungenEigene", { pLang: "de" });
		expect(seen[0]).toContain("wbservicesbasic.pruefungenEigene");
		expect(seen[0]).toContain("pLang=de");
		expect(JSON.stringify(r)).not.toContain("SECRETTOKEN123");
		expect(r.xml).toContain("[token]");
		expect(r).toMatchObject({ function: "pruefungenEigene", http_status: 200 });
		expect(JSON.stringify(r.data)).toContain("Prüfung");
	});

	it("accepts only allowlisted functions and no pToken parameter", async () => {
		vi.stubGlobal("fetch", async () => new Response("<x/>"));
		await expect(rawCall(env, "terminCreate" as never, {})).rejects.toThrow(/allowlist/);
		await expect(rawCall(env, "kalender", { pToken: "x" })).rejects.toThrow(/pToken/);
	});
});
