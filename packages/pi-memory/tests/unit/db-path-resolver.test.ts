import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DbPathError, resolveDbPath } from "../../src/db-path-resolver.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    realpathSync: vi.fn(actual.realpathSync),
    lstatSync: vi.fn(actual.lstatSync),
  };
});

let root: string;
let home: string;
let cwd: string;
let agentDir: string;

beforeEach(() => {
  vi.mocked(fs.readFileSync).mockClear();
  vi.mocked(fs.realpathSync).mockClear();
  vi.mocked(fs.lstatSync).mockClear();
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

  it.each([
    ".pi/agent-copy", "elsewhere/.pi/agent", "pico/agent", "hermes/agent", "pico-hermes-agent",
  ])("does not match agent names or partial paths: %s", (relative) => {
    const other = join(home, relative);
    fs.mkdirSync(other, { recursive: true });
    expect(path({ agentDir: other })).toBe(join(other, "memory", "memory.db"));
  });

  it.each(["EACCES", "EPERM", "ENOTDIR", "ELOOP", "EIO"])("rejects canonicalization %s without fallback", (code) => {
    vi.mocked(fs.realpathSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("sensitive-path-error"), { code });
    });
    expect(() => path()).toThrow(new DbPathError(agentDir, code));
  });

  it("also rejects errors resolving the standard comparison path", () => {
    fs.mkdirSync(agentDir, { recursive: true });
    vi.mocked(fs.realpathSync).mockImplementationOnce((value) => {
      vi.mocked(fs.realpathSync).mockImplementationOnce(() => {
        throw Object.assign(new Error("sensitive-path-error"), { code: "EACCES" });
      });
      return String(value);
    });
    expect(() => path()).toThrow(new DbPathError(join(home, ".pi", "agent"), "EACCES"));
  });

  it.each(["leaf", "ancestor", "standard"])("rejects a dangling %s symlink", (kind) => {
    const link = kind === "standard" ? join(home, ".pi", "agent") : join(root, "dangling");
    fs.mkdirSync(resolve(link, ".."), { recursive: true });
    fs.symlinkSync(join(root, "missing-target"), link);
    const selected = kind === "standard" ? agentDir : kind === "ancestor" ? join(link, "agent") : link;
    expect(() => path({ agentDir: selected })).toThrow(new DbPathError(link, "ENOENT"));
  });

  it("rejects non-ENOENT lstat errors while checking a missing path", () => {
    vi.mocked(fs.lstatSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("sensitive-stat-error"), { code: "EPERM" });
    });
    expect(() => path({ isProjectTrusted: false })).toThrow(new DbPathError(agentDir, "EPERM"));
  });

  it("resolves an alias created between realpath ENOENT and the existence check", () => {
    const standard = join(home, ".pi", "agent");
    fs.mkdirSync(standard, { recursive: true });
    const alias = join(root, "new-alias");
    vi.mocked(fs.realpathSync).mockImplementationOnce(() => {
      fs.symlinkSync(standard, alias);
      throw Object.assign(new Error("concurrent creation"), { code: "ENOENT" });
    });
    expect(path({ agentDir: alias })).toBe(join(home, ".pi", "memory", "memory.db"));
  });

  it("propagates an error on the one concurrent-creation recheck without fallback", () => {
    fs.mkdirSync(agentDir, { recursive: true });
    vi.mocked(fs.realpathSync)
      .mockImplementationOnce(() => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); })
      .mockImplementationOnce(() => { throw Object.assign(new Error("denied"), { code: "EACCES" }); });
    expect(() => path()).toThrow(new DbPathError(agentDir, "EACCES"));
  });

  it("allows a missing leaf beneath a valid symlink ancestor", () => {
    const target = join(root, "target");
    const link = join(root, "valid-link");
    fs.mkdirSync(target);
    fs.symlinkSync(target, link);
    expect(path({ agentDir: join(link, "uncreated-agent") }))
      .toBe(join(link, "uncreated-agent", "memory", "memory.db"));
  });

  it("rejects actual ENOTDIR and symlink loops", () => {
    const file = join(root, "file");
    fs.writeFileSync(file, "not a directory");
    expect(() => path({ agentDir: join(file, "agent") })).toThrow("ENOTDIR");
    const loop = join(root, "loop");
    fs.symlinkSync(loop, loop);
    expect(() => path({ agentDir: loop })).toThrow("ELOOP");
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

  it.each(["standard", "custom"])("prioritizes localPath above the %s agent rule", (kind) => {
    config({ "pi-memory": { localPath: "./selected" } });
    const selected = kind === "standard" ? join(home, ".pi", "agent") : agentDir;
    expect(path({ agentDir: selected })).toBe(join(cwd, "selected", "memory.db"));
    expect(fs.realpathSync).not.toHaveBeenCalled();
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

  it("rejects a dangling settings ancestor instead of treating it as missing", () => {
    fs.rmSync(join(cwd, ".pi"), { recursive: true });
    fs.symlinkSync(join(root, "missing-config-directory"), join(cwd, ".pi"));
    expect(() => path()).toThrow(new DbPathError(join(cwd, ".pi"), "ENOENT"));
  });

  it("rejects existing dangling settings symlinks instead of treating them as missing", () => {
    fs.symlinkSync(join(root, "missing.json"), join(cwd, ".pi", "settings.json"));
    expect(() => path()).toThrow("ENOENT");
  });
});
