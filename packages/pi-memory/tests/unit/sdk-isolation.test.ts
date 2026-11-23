import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime,
  SessionManager, SettingsManager, type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { createMemoryExtension } from "../../src/index.js";

it("isolates real SDK sessions A/B with explicit factories while process agentDir stays C", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-memory-sdk-"));
  const processDir = join(root, "C");
  // One fixed process environment for the whole test, never switched between sessions.
  vi.stubEnv("PI_CODING_AGENT_DIR", processDir);
  const diagnostics: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { diagnostics.push(String(chunk)); return true; });
  const sessions: AgentSession[] = [];
  const errors: unknown[] = [];
  const dirs = [join(root, "A"), join(root, "B")];
  const options = dirs.map((agentDir) => ({ agentDir }));
  const factories = options.map(createMemoryExtension);
  // Each factory captures the value, not a mutable host options object.
  options.forEach((option) => { option.agentDir = processDir; });
  const offline = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Unexpected network request"); });
  try {
    for (const [n, agentDir] of dirs.entries()) {
      const cwd = join(root, `cwd-${n}`);
      mkdirSync(cwd);
      mkdirSync(agentDir);
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off" });
      const modelRuntime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
        modelsStorePath: join(agentDir, "models.db"), allowModelNetwork: false, refreshOnCreate: false,
      });
      const loader = new DefaultResourceLoader({
        cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
        noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [factories[n]],
      });
      await loader.reload();
      expect(loader.getExtensions().errors).toEqual([]);
      const { session } = await createAgentSession({
        cwd, agentDir, modelRuntime, model: modelRuntime.getModels()[0],
        resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(cwd), noTools: "builtin",
      });
      sessions.push(session);
    }
    // Both factories are loaded before either session_start; bind in reverse order.
    for (const session of [...sessions].reverse()) {
      await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
    }
    expect(getAgentDir()).toBe(processDir);
    const call = async (n: number, name: string, params: object = {}) => {
      const tool = sessions[n].agent.state.tools.find((tool) => tool.name === name);
      expect(tool, name).toBeDefined();
      return tool!.execute(`sdk-${n}-${name}`, params);
    };
    const search = async (n: number) => (await call(n, "memory_search", { scope: "all" })).structuredContent;
    for (const [n, agentDir] of dirs.entries()) {
      expect((await call(n, "memory_stats")).structuredContent).toMatchObject({
        agentDir, dbPath: join(agentDir, "memory", "memory.db"), storageMode: "agent-local", semantic: 0,
      });
    }
    await call(0, "memory_remember", { key: "pref.sdk-isolation", value: "written by A" });
    expect(await search(1)).toMatchObject({ count: 0 });
    await call(1, "memory_remember", { key: "pref.sdk-isolation", value: "written by B" });
    expect(await search(0)).toMatchObject({ results: [{ key: "pref.sdk-isolation", value: "written by A" }], count: 1 });
    expect(await search(1)).toMatchObject({ results: [{ key: "pref.sdk-isolation", value: "written by B" }], count: 1 });
    // Repeated startup must not take the directory from the most recently loaded instance.
    await sessions[0].extensionRunner.emit({ type: "session_start", reason: "reload" });
    expect((await call(0, "memory_stats")).structuredContent).toMatchObject({ agentDir: dirs[0], semantic: 1 });
    await call(0, "memory_forget", { key: "pref.sdk-isolation" });
    expect(await search(0)).toMatchObject({ count: 0 });
    expect(await search(1)).toMatchObject({ results: [{ value: "written by B" }], count: 1 });
    await call(1, "memory_forget", { key: "pref.sdk-isolation" });
    expect(await search(1)).toMatchObject({ count: 0 });
    expect(errors).toEqual([]);
    const reports = diagnostics.filter((line) => line.includes('"storageMode"')).map((line) => JSON.parse(line));
    expect(reports.map((report) => report.agentDir)).toEqual([dirs[1], dirs[0], dirs[0]]);
    for (const report of reports) expect(report.dbPath).toBe(join(report.agentDir, "memory", "memory.db"));
    expect(existsSync(join(processDir, "memory"))).toBe(false);
    expect(offline).not.toHaveBeenCalled();
  } finally {
    try {
      for (const session of sessions) {
        try { await session.extensionRunner.emit({ type: "session_shutdown" }); } finally { session.dispose(); }
      }
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 20_000);
