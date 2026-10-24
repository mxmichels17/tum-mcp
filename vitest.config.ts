import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			// The protocol code is tested over in-memory streams. Real sockets only exist in workerd.
			"cloudflare:sockets": fileURLToPath(new URL("./test/stubs/sockets.ts", import.meta.url)),
		},
	},
	test: { include: ["test/**/*.test.ts"] },
});
