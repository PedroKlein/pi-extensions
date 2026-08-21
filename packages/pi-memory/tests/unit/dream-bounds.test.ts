import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DREAM_DEFAULTS, readDreamConfig } from "../../src/dream/config.js";
import {
  capPromptBytes,
  executeDream,
  selectDreamSessions,
} from "../../src/dream/orchestrator.js";
import type { ExtractedSession } from "../../src/dream/session-reader.js";
import { MemoryStore } from "../../src/store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function sessions(count: number, chars = 1_000): ExtractedSession[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `/sessions/${index}.jsonl`,
    project: "example",
    timestamp: "2026-01-01",
    userMessages: ["user request", `u-${index}`],
    assistantMessages: ["x".repeat(chars)],
    toolCalls: [],
    estimatedTokens: Math.ceil(chars / 4),
  }));
}

describe("Dream automatic bounds", () => {
  it("caps automatic runs to 10 substantive sessions and 300KB source", () => {
    const selected = selectDreamSessions(sessions(20, 40_000), {
      manual: false,
      maxSessions: 10,
      maxSourceBytes: 300 * 1024,
    });

    expect(selected.sessions.length).toBeLessThanOrEqual(10);
    expect(selected.sourceBytes).toBeLessThanOrEqual(300 * 1024);
    expect(selected.deferred.length).toBeGreaterThan(0);
  });

  it("lets an explicit manual run exceed automatic bounds", () => {
    const selected = selectDreamSessions(sessions(20, 40_000), {
      manual: true,
      maxSessions: 10,
      maxSourceBytes: 300 * 1024,
    });

    expect(selected.sessions).toHaveLength(20);
    expect(selected.deferred).toHaveLength(0);
    expect(selected.sourceBytes).toBeGreaterThan(300 * 1024);
  });

  it("bounds refiner and advisor prompts by UTF-8 bytes", () => {
    const capped = capPromptBytes(
      `instructions\n${"context 😀 ".repeat(100_000)}\nfinal output rules`,
      64 * 1024,
    );

    expect(Buffer.byteLength(capped)).toBeLessThanOrEqual(64 * 1024);
    expect(capped).toContain("[... prompt context truncated ...]");
    expect(capped).toContain("final output rules");
  });
});

describe("Dream usage events", () => {
  it("emits labeled start and completion usage for an automatic empty run", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-memory-dream-events-"));
    tempDirs.push(root);
    const sessionsDir = join(root, "sessions");
    mkdirSync(sessionsDir);
    const store = new MemoryStore(join(root, "memory.db"));
    const events: unknown[] = [];
    try {
      const result = await executeDream(
        store,
        {
          ...DREAM_DEFAULTS,
          sessionsDir,
          journalDir: join(root, "journal"),
          skillsDir: join(root, "skills"),
          minerModel: "custom-provider/miner",
          refinerModel: "custom-provider/refiner",
          advisorModel: "custom-provider/advisor",
        },
        vi.fn(),
        { setStatus: vi.fn(), notify: vi.fn() },
        {
          manual: false,
          onUsageEvent: (event) => events.push(event),
        },
      );

      expect(result.success).toBe(true);
      expect(events).toEqual([
        expect.objectContaining({
          source: "pi-memory",
          operation: "dream-start",
          trigger: "automatic",
        }),
        expect.objectContaining({
          source: "pi-memory",
          operation: "dream-complete",
          trigger: "automatic",
          durationMs: expect.any(Number),
        }),
      ]);
    } finally {
      store.close();
    }
  });

  it("emits model and token usage for mine, refine, and advisor stages", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-memory-dream-stages-"));
    tempDirs.push(root);
    const sessionsDir = join(root, "sessions", "--workspace-example--");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "2026-01-01T00-00-00-000Z_fixture.jsonl"),
      [
        JSON.stringify({ type: "session", version: 3, id: "fixture" }),
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "first substantive request" },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: "first answer" },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "second substantive request" },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: "second answer" },
        }),
      ].join("\n"),
    );
    const store = new MemoryStore(join(root, "memory.db"));
    const events: Array<{ operation: string; input: number; output: number }> = [];
    const exec = vi.fn(async (_command: string, args: string[]) => {
      const model = args[args.indexOf("--model") + 1];
      if (model === "custom-provider/miner") {
        return {
          code: 0,
          stdout: JSON.stringify({ semantic: [], lessons: [] }),
          stderr: "",
        };
      }
      if (model === "custom-provider/refiner") {
        return {
          code: 0,
          stdout: JSON.stringify({ operations: [] }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "## Workflow\nNo changes.", stderr: "" };
    });
    try {
      const result = await executeDream(
        store,
        {
          ...DREAM_DEFAULTS,
          sessionsDir: join(root, "sessions"),
          journalDir: join(root, "journal"),
          skillsDir: join(root, "skills"),
          minerModel: "custom-provider/miner",
          refinerModel: "custom-provider/refiner",
          advisorModel: "custom-provider/advisor",
          extensions: ["npm:custom-provider-extension"],
        },
        exec,
        { setStatus: vi.fn(), notify: vi.fn() },
        {
          manual: false,
          onUsageEvent: (event) => events.push(event),
        },
      );

      expect(result.success).toBe(true);
      for (const [, args] of exec.mock.calls) {
        expect(args).toEqual(expect.arrayContaining([
          "--no-extensions",
          "--extension",
          "npm:custom-provider-extension",
        ]));
      }
      for (const operation of ["dream-mine", "dream-refine", "dream-advise"]) {
        expect(events).toContainEqual(
          expect.objectContaining({
            operation,
            input: expect.any(Number),
            output: expect.any(Number),
          }),
        );
      }
      expect(
        events.filter((event) =>
          ["dream-mine", "dream-refine", "dream-advise"].includes(
            event.operation,
          ),
        ).every((event) => event.input > 0 && event.output > 0),
      ).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe("Dream model configuration", () => {
  it("requires explicit models and resolves project overrides", () => {
    expect(DREAM_DEFAULTS.minerModel).toBe("");
    expect(DREAM_DEFAULTS.refinerModel).toBe("");
    expect(DREAM_DEFAULTS.advisorModel).toBe("");

    const cwd = mkdtempSync(join(tmpdir(), "pi-memory-dream-config-"));
    tempDirs.push(cwd);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({
        memory: {
          dream: {
            minerModel: "custom-provider/miner",
            refinerModel: "custom-provider/refiner",
            advisorModel: "custom-provider/advisor",
            extensions: ["npm:custom-provider-extension"],
          },
        },
      }),
    );

    const config = readDreamConfig(cwd);
    expect(config.minerModel).toBe("custom-provider/miner");
    expect(config.refinerModel).toBe("custom-provider/refiner");
    expect(config.advisorModel).toBe("custom-provider/advisor");
    expect(config.extensions).toEqual(["npm:custom-provider-extension"]);
  });
});
