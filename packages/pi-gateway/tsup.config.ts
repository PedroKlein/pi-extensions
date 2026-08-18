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
		"@oh-my-pi/pi-coding-agent",
		"@oh-my-pi/pi-ai",
	],
});
