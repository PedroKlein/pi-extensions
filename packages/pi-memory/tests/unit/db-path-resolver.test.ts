import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DbPathError, resolveDbPath } from "../../src/db-path-resolver.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

let root: string;
let home: string;
let cwd: string;
let agentDir: string;

beforeEach(() => {
  vi.mocked(fs.readFileSync).mockClear();
  root = fs.mkdtempSync(join(tmpdir(), "pi-memory-path-"));
  home = join(root, "home");
  cwd = join(root, "project");
  agentDir = join(home, "pico", "agent");
  fs.mkdirSync(join(cwd, ".pi"), { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

function path(overrides: Partial<Parameters<typeof resolveDbPath>[0]> = {}) {
  return resolveDbPath({ agentDir, cwd, homeDir: home, configDirName: ".pi", isProjectTrusted: true, ...overrides });
}
function config(value: unknown) {
  fs.writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(value));
}

describe("agent-aware defaults (path calculation only)", () => {
  it("keeps the standard agent on the legacy database", () => {
    expect(path({ agentDir: join(home, ".pi", "agent") })).toBe(join(home, ".pi", "memory", "memory.db"));
  });

  it.each([undefined, "standard"])("accepts SDK agentDir with env=%s without opening a database", (env) => {
    // Uses the real SDK; computes a path only, never reads/writes the real memory DB.
    vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
    const standard = getAgentDir();
    if (env) vi.stubEnv("PI_CODING_AGENT_DIR", standard);
    expect(path({ agentDir: getAgentDir(), homeDir: resolve(standard, "..", "..") }))
      .toBe(resolve(standard, "..", "memory", "memory.db"));
  });

  it("normalizes ~/ and .. when comparing the standard agent", () => {
    const expected = join(home, ".pi", "memory", "memory.db");
    expect(path({ agentDir: "~/.pi/agent/../agent" })).toBe(expected);
    expect(path({ agentDir: join(home, ".pi") + "/agent/../agent" })).toBe(expected);
  });

  it("recognizes symlink aliases of the standard agent", () => {
    const standard = join(home, ".pi", "agent");
    fs.mkdirSync(standard, { recursive: true });
    const alias = join(root, "alias");
    fs.symlinkSync(standard, alias);
    expect(path({ agentDir: alias })).toBe(join(home, ".pi", "memory", "memory.db"));
  });

  it("isolates two agents and keeps defaults independent of cwd", () => {
    const first = path();
    expect(first).toBe(join(agentDir, "memory", "memory.db"));
    expect(path({ cwd: join(root, "other-project") })).toBe(first);
    expect(path({ agentDir: join(home, "eros", "agent") })).not.toBe(first);
  });
});

describe("project overrides", () => {
  it.each(["absolute", "relative"])("uses a trusted %s directory override", (kind) => {
    const directory = kind === "absolute" ? join(root, "override") : "./.pi/memory";
    config({ "pi-memory": { localPath: directory } });
    expect(path()).toBe(join(resolve(cwd, directory), "memory.db"));
  });

  it("uses CONFIG_DIR_NAME rather than a hardcoded directory", () => {
    fs.mkdirSync(join(cwd, ".agents"));
    fs.writeFileSync(join(cwd, ".agents", "settings.json"), '{"pi-memory":{"localPath":"./local"}}');
    expect(path({ configDirName: ".agents" })).toBe(join(cwd, "local", "memory.db"));
  });

  it("never reads untrusted settings, even malformed settings", () => {
    fs.writeFileSync(join(cwd, ".pi", "settings.json"), "{ malformed untrusted settings");
    const read = vi.mocked(fs.readFileSync);
    expect(path({ isProjectTrusted: false })).toBe(join(agentDir, "memory", "memory.db"));
    expect(read).not.toHaveBeenCalled();
  });

  it.each([{}, { "pi-memory": {} }])("uses the default for absent localPath: %j", (value) => {
    config(value);
    expect(path()).toBe(join(agentDir, "memory", "memory.db"));
  });
});

describe("invalid configuration never falls back or exposes contents", () => {
  it("reports the settings path and SyntaxError without the raw parse message", () => {
    const marker = "sensitive-config-marker";
    fs.writeFileSync(join(cwd, ".pi", "settings.json"), `{ ${marker}`);
    expect(() => path()).toThrow(new DbPathError(join(cwd, ".pi", "settings.json"), "SyntaxError"));
    try { path(); } catch (error) {
      expect(String(error)).not.toContain(marker);
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it.each([null, [], 1, "settings", true])("rejects non-object settings: %j", (value) => {
    config(value);
    expect(() => path()).toThrow("TypeError (settings)");
  });

  it.each([null, [], 1, "section", false])("rejects non-object pi-memory: %j", (value) => {
    config({ "pi-memory": value });
    expect(() => path()).toThrow("TypeError (pi-memory)");
  });

  it.each([null, 123, [], {}, true, "", "   ", "bad\0path"])("rejects invalid localPath: %j", (value) => {
    config({ "pi-memory": { localPath: value } });
    expect(() => path()).toThrow("TypeError (pi-memory.localPath)");
  });

  it("reports unreadable settings safely (deterministic even under root)", () => {
    config({});
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("sensitive error message"), { code: "EACCES" });
    });
    expect(() => path()).toThrow(new DbPathError(join(cwd, ".pi", "settings.json"), "EACCES"));
  });

  it("rejects an actual directory in place of settings.json", () => {
    fs.mkdirSync(join(cwd, ".pi", "settings.json"));
    expect(() => path()).toThrow("EISDIR");
  });

  it("rejects existing dangling settings symlinks instead of treating them as missing", () => {
    fs.symlinkSync(join(root, "missing.json"), join(cwd, ".pi", "settings.json"));
    expect(() => path()).toThrow("ENOENT");
  });
});
