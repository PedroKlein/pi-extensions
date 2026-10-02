import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("package contract", () => {
  it("keeps bundled TypeBox out of runtime dependencies", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );

    expect(manifest.dependencies?.["@sinclair/typebox"]).toBeUndefined();
    expect(manifest.devDependencies?.["@sinclair/typebox"]).toBe("^0.34.0");
  });
});
