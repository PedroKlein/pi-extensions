import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import piReadonlyBash from "../../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("pi-readonly-bash extension", () => {
  it("is inactive by default but activated by an explicit child-style allowlist", async () => {
    const cwd = process.cwd();
    const agentDir = mkdtempSync(join(tmpdir(), "pi-readonly-profile-"));
    temporaryDirectories.push(agentDir);
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      extensionFactories: [{ name: "readonly", factory: piReadonlyBash }],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();

    const defaultSession = await createAgentSession({
      cwd,
      agentDir,
      settingsManager,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      noTools: "builtin",
    });
    expect(defaultSession.session.getActiveToolNames()).not.toContain("bash_readonly");
    await defaultSession.session.dispose();

    const childSession = await createAgentSession({
      cwd,
      agentDir,
      settingsManager,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      tools: ["bash_readonly"],
    });
    expect(childSession.session.getActiveToolNames()).toEqual(["bash_readonly"]);
    expect(childSession.session.getCallableToolNames()).toEqual(["bash_readonly"]);
    await childSession.session.dispose();
  });

  it("returns a complete tool result when policy blocks a command", async () => {
    let tool: any;
    const pi = {
      registerTool: (definition: unknown) => {
        tool = definition;
      },
    } as ExtensionAPI;

    piReadonlyBash(pi);
    const result = await tool.execute(
      "call-1",
      { command: "rm -rf /" },
      undefined,
      undefined,
      {},
    );

    expect(result).toMatchObject({
      isError: true,
      details: undefined,
    });
    expect(result.content[0].text).toContain("Readonly bash blocked");
  });
});
