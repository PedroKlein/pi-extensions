import { access, readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import sshSessionExtension from "../src/index.js";

describe("package", () => {
  it("declares one Pi extension that registers only ssh_session", async () => {
    const manifestURL = new URL("../package.json", import.meta.url);
    const manifest = JSON.parse(await readFile(manifestURL, "utf8"));
    expect(manifest).toMatchObject({
      name: "@pedro_klein/pi-ssh-session",
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      exports: { ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } },
      files: ["dist", "src"],
      pi: { extensions: ["./src/index.ts"] },
    });
    expect(manifest).not.toHaveProperty("dependencies");
    await expect(access(new URL(manifest.pi.extensions[0], manifestURL))).resolves.toBeUndefined();

    const tools: Array<{ name: string; parameters: { properties: Record<string, unknown> } }> = [];
    sshSessionExtension({
      registerTool(tool: { name: string; parameters: { properties: Record<string, unknown> } }) {
        tools.push(tool);
      },
      on() {},
    } as unknown as ExtensionAPI);

    expect(tools.map(({ name }) => name)).toEqual(["ssh_session"]);
    expect(tools[0].parameters.properties).not.toHaveProperty("mode");
    expect(tools[0].parameters.properties).toHaveProperty("cacheSudoPassword");
    expect(tools[0].parameters.properties).not.toHaveProperty("password");
  });
});
