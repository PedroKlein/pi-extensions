import { describe, it, expect } from "vitest";
import {
  MODE_ORDER,
  MODE_LABELS,
  READONLY_BASH_MODES,
  RESTRICTED_SUBAGENT_MODES,
  WRITE_FILTERED_MODES,
  ALLOWED_WRITE_EXTENSIONS,
  isWriteAllowed,
} from "../../src/index.js";
import type { Mode } from "../../src/types.js";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

describe("MODE_ORDER", () => {
  it("contains all 5 modes", () => {
    expect(MODE_ORDER).toHaveLength(5);
    expect(MODE_ORDER).toContain("ask");
    expect(MODE_ORDER).toContain("brainstorm");
    expect(MODE_ORDER).toContain("plan");
    expect(MODE_ORDER).toContain("build");
    expect(MODE_ORDER).toContain("none");
  });

  it("starts with ask and ends with none", () => {
    expect(MODE_ORDER[0]).toBe("ask");
    expect(MODE_ORDER[MODE_ORDER.length - 1]).toBe("none");
  });

  it("allows cycling: last index wraps back to first", () => {
    const lastIdx = MODE_ORDER.indexOf("none");
    const nextIdx = (lastIdx + 1) % MODE_ORDER.length;
    expect(MODE_ORDER[nextIdx]).toBe("ask");
  });
});

describe("MODE_LABELS", () => {
  it("has an entry for every mode", () => {
    for (const mode of MODE_ORDER) {
      expect(MODE_LABELS[mode]).toBeDefined();
      expect(MODE_LABELS[mode].icon).toBeTruthy();
      expect(MODE_LABELS[mode].label).toBeTruthy();
      expect(MODE_LABELS[mode].color).toBeTruthy();
    }
  });

  it("build mode has success color", () => {
    expect(MODE_LABELS.build.color).toBe("success");
  });

  it("none mode has dim color", () => {
    expect(MODE_LABELS.none.color).toBe("dim");
  });
});

describe("tool gating sets", () => {
  it("READONLY_BASH_MODES includes ask, brainstorm, plan", () => {
    expect(READONLY_BASH_MODES.has("ask")).toBe(true);
    expect(READONLY_BASH_MODES.has("brainstorm")).toBe(true);
    expect(READONLY_BASH_MODES.has("plan")).toBe(true);
    expect(READONLY_BASH_MODES.has("build")).toBe(false);
    expect(READONLY_BASH_MODES.has("none")).toBe(false);
  });

  it("RESTRICTED_SUBAGENT_MODES matches READONLY_BASH_MODES", () => {
    for (const mode of MODE_ORDER) {
      expect(RESTRICTED_SUBAGENT_MODES.has(mode as Mode)).toBe(
        READONLY_BASH_MODES.has(mode as Mode)
      );
    }
  });

  it("WRITE_FILTERED_MODES is ask and brainstorm only", () => {
    expect(WRITE_FILTERED_MODES.has("ask")).toBe(true);
    expect(WRITE_FILTERED_MODES.has("brainstorm")).toBe(true);
    expect(WRITE_FILTERED_MODES.has("plan")).toBe(false);
    expect(WRITE_FILTERED_MODES.has("build")).toBe(false);
    expect(WRITE_FILTERED_MODES.has("none")).toBe(false);
  });

  it("ALLOWED_WRITE_EXTENSIONS includes .md and .mdx", () => {
    expect(ALLOWED_WRITE_EXTENSIONS.has(".md")).toBe(true);
    expect(ALLOWED_WRITE_EXTENSIONS.has(".mdx")).toBe(true);
    expect(ALLOWED_WRITE_EXTENSIONS.has(".ts")).toBe(false);
  });
});

describe("isWriteAllowed", () => {
  const cwd = "/home/user/project";

  it("allows markdown files inside cwd", () => {
    expect(isWriteAllowed("notes.md", cwd)).toBe(true);
    expect(isWriteAllowed("docs/plan.mdx", cwd)).toBe(true);
  });

  it("blocks non-markdown files inside cwd", () => {
    expect(isWriteAllowed("src/index.ts", cwd)).toBe(false);
    expect(isWriteAllowed("data.json", cwd)).toBe(false);
  });

  it("blocks path traversal outside cwd", () => {
    expect(isWriteAllowed("../other/file.md", cwd)).toBe(false);
  });

  it("allows writes under /tmp/", () => {
    expect(isWriteAllowed("/tmp/scratch.ts", cwd)).toBe(true);
  });

  it("allows writes under OS tmpdir()", () => {
    const tmp = tmpdir();
    expect(isWriteAllowed(join(tmp, "output.json"), cwd)).toBe(true);
  });

  it("allows writes under ~/.pi/", () => {
    const piDir = join(homedir(), ".pi", "agent", "settings.json");
    expect(isWriteAllowed(piDir, cwd)).toBe(true);
  });

  it("returns false for empty path", () => {
    expect(isWriteAllowed("", cwd)).toBe(false);
  });

  it("blocks absolute path outside cwd, /tmp/, and ~/.pi/", () => {
    expect(isWriteAllowed("/etc/passwd", cwd)).toBe(false);
    expect(isWriteAllowed("/home/user/other-project/src/app.ts", cwd)).toBe(false);
  });
});
