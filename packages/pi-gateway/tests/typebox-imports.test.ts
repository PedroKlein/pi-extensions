import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Regression guard for the oh-my-pi "Unknown type" bug.
 *
 * oh-my-pi's extension loader redirects the *bare* `@sinclair/typebox` (and
 * `typebox`) root specifier to its omptype TypeBox facade, but intentionally
 * leaves subpaths (`/type`, `/value`, ...) resolving to real typebox. Mixing a
 * facade-built schema (root `Type`) with the real checker (`@sinclair/typebox/
 * value` `Value`) makes `Value.Check` throw "Unknown type" at runtime on
 * oh-my-pi. Keep every runtime typebox import on a subpath so `Type` and
 * `Value` come from the same (real) copy on both harnesses.
 */
describe("typebox imports (oh-my-pi facade safety)", () => {
	const srcDir = join(__dirname, "..", "src");
	const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));

	// A runtime (non-type-only) import from the bare root specifier.
	const bareRootValueImport =
		/import\s+(?!type\b)\{[^}]*\}\s+from\s+["']@sinclair\/typebox["']/;

	for (const file of files) {
		it(`${file} does not import typebox values from the bare root specifier`, () => {
			const src = readFileSync(join(srcDir, file), "utf8");
			expect(bareRootValueImport.test(src)).toBe(false);
		});
	}
});
