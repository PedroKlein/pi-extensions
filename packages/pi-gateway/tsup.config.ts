import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts", "src/omp.ts"],
	format: ["esm"],
	dts: false,
	sourcemap: true,
	clean: true,
	target: "node20",
	external: [
		"@earendil-works/pi-coding-agent",
		"@earendil-works/pi-ai",
		"@earendil-works/pi-tui",
		"@oh-my-pi/pi-ai",
	],
	// Bundle (inline) TypeBox into the output. Both pi and oh-my-pi redirect a
	// bare `@sinclair/typebox` import to their own bundled/facade typebox at
	// extension-load time, and they do it inconsistently across the root vs
	// `/value` subpath — which corrupts schema validation ("Unknown type" on
	// oh-my-pi; missing `/type` subpath on pi). Inlining removes the import
	// specifier entirely so `Type` and `Value` always come from one real copy.
	// The pi-family packages above stay external so each host still resolves
	// them to its own shared runtime (single api/model registry).
	noExternal: ["@sinclair/typebox"],
});
