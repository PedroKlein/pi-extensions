import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  DEFAULT_DEFAULTS,
  mergeDefaults,
  mergeApps,
  resolveApp,
  type AppConfig,
  type Defaults,
} from "../../src/config.js";

describe("DEFAULT_DEFAULTS", () => {
  it("has expected default values", () => {
    expect(DEFAULT_DEFAULTS.width).toBe("80%");
    expect(DEFAULT_DEFAULTS.height).toBe("80%");
    expect(DEFAULT_DEFAULTS.anchor).toBe("center");
    expect(DEFAULT_DEFAULTS.closeKey).toBe("ctrl+q");
    expect(DEFAULT_DEFAULTS.holdOnExit).toBe(false);
    expect(DEFAULT_DEFAULTS.toggle).toBe(false);
    expect(DEFAULT_DEFAULTS.notify).toBe(false);
    expect(DEFAULT_DEFAULTS.borderColor).toBe("accent");
  });

  it("shell defaults to $SHELL or /bin/sh", () => {
    // Either the env variable or the fallback
    expect(DEFAULT_DEFAULTS.shell).toMatch(/\/.*sh/);
  });
});

describe("mergeDefaults", () => {
  it("returns DEFAULT_DEFAULTS when both args are undefined", () => {
    const result = mergeDefaults(undefined, undefined);
    expect(result).toEqual(DEFAULT_DEFAULTS);
  });

  it("applies global overrides over defaults", () => {
    const result = mergeDefaults({ width: "60%", closeKey: "ctrl+x" }, undefined);
    expect(result.width).toBe("60%");
    expect(result.closeKey).toBe("ctrl+x");
    // other fields still from defaults
    expect(result.anchor).toBe("center");
  });

  it("applies local overrides over global", () => {
    const result = mergeDefaults({ width: "60%", anchor: "top" }, { anchor: "bottom" });
    expect(result.width).toBe("60%");
    expect(result.anchor).toBe("bottom"); // local wins
  });

  it("local wins over both global and defaults", () => {
    const result = mergeDefaults({ borderColor: "warning" }, { borderColor: "error" });
    expect(result.borderColor).toBe("error");
  });

  it("undefined global + local override applies correctly", () => {
    const result = mergeDefaults(undefined, { height: "50%", notify: true });
    expect(result.height).toBe("50%");
    expect(result.notify).toBe(true);
    expect(result.width).toBe("80%"); // default preserved
  });
});

describe("mergeApps", () => {
  it("returns global apps when no local apps", () => {
    const global: AppConfig[] = [{ name: "shell", cmd: "$SHELL" }];
    const result = mergeApps(global, []);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("shell");
  });

  it("returns local apps when no global apps", () => {
    const local: AppConfig[] = [{ name: "htop", cmd: "htop" }];
    const result = mergeApps([], local);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("htop");
  });

  it("merges non-overlapping apps from both", () => {
    const global: AppConfig[] = [{ name: "shell", cmd: "$SHELL" }];
    const local: AppConfig[] = [{ name: "lazygit", cmd: "lazygit" }];
    const result = mergeApps(global, local);
    expect(result).toHaveLength(2);
    const names = result.map((a) => a.name);
    expect(names).toContain("shell");
    expect(names).toContain("lazygit");
  });

  it("local overrides global app of same name", () => {
    const global: AppConfig[] = [{ name: "shell", cmd: "$SHELL", width: "80%" }];
    const local: AppConfig[] = [{ name: "shell", cmd: "bash", key: "ctrl+t" }];
    const result = mergeApps(global, local);
    expect(result).toHaveLength(1);
    const app = result[0]!;
    expect(app.cmd).toBe("bash"); // local wins
    expect(app.key).toBe("ctrl+t"); // local adds
    expect(app.width).toBe("80%"); // global field preserved when local doesn't set it
  });

  it("handles empty both lists", () => {
    const result = mergeApps([], []);
    expect(result).toHaveLength(0);
  });
});

describe("resolveApp", () => {
  const defaults: Defaults = { ...DEFAULT_DEFAULTS };

  it("uses defaults for unset optional fields", () => {
    const app: AppConfig = { name: "test", cmd: "echo hi" };
    const resolved = resolveApp(app, defaults);
    expect(resolved.width).toBe(defaults.width);
    expect(resolved.height).toBe(defaults.height);
    expect(resolved.anchor).toBe(defaults.anchor);
    expect(resolved.closeKey).toBe(defaults.closeKey);
    expect(resolved.shell).toBe(defaults.shell);
    expect(resolved.toggle).toBe(defaults.toggle);
    expect(resolved.holdOnExit).toBe(defaults.holdOnExit);
    expect(resolved.notify).toBe(defaults.notify);
    expect(resolved.borderColor).toBe(defaults.borderColor);
  });

  it("preserves app-specific overrides", () => {
    const app: AppConfig = {
      name: "lazygit",
      cmd: "lazygit",
      width: "95%",
      height: "95%",
      key: "ctrl+shift+g",
      toggle: true,
      notify: true,
      borderColor: "success",
    };
    const resolved = resolveApp(app, defaults);
    expect(resolved.width).toBe("95%");
    expect(resolved.height).toBe("95%");
    expect(resolved.key).toBe("ctrl+shift+g");
    expect(resolved.toggle).toBe(true);
    expect(resolved.notify).toBe(true);
    expect(resolved.borderColor).toBe("success");
  });

  it("preserves optional fields that are absent", () => {
    const app: AppConfig = { name: "test", cmd: "test" };
    const resolved = resolveApp(app, defaults);
    expect(resolved.key).toBeUndefined();
    expect(resolved.cwd).toBeUndefined();
    expect(resolved.env).toBeUndefined();
    expect(resolved.feedContext).toBeUndefined();
    expect(resolved.if).toBeUndefined();
  });

  it("passes through cwd, env, feedContext, if fields", () => {
    const app: AppConfig = {
      name: "test",
      cmd: "test",
      cwd: "/tmp",
      env: { FOO: "bar" },
      feedContext: "echo done",
      if: "command -v test",
    };
    const resolved = resolveApp(app, defaults);
    expect(resolved.cwd).toBe("/tmp");
    expect(resolved.env).toEqual({ FOO: "bar" });
    expect(resolved.feedContext).toBe("echo done");
    expect(resolved.if).toBe("command -v test");
  });

  it("name and cmd are required and always present", () => {
    const app: AppConfig = { name: "myapp", cmd: "myapp --flag" };
    const resolved = resolveApp(app, defaults);
    expect(resolved.name).toBe("myapp");
    expect(resolved.cmd).toBe("myapp --flag");
  });
});
