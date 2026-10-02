import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { DREAM_DEFAULTS, readDreamConfig } from "../../src/dream/config.js";
import {
  capPromptBytes,
  executeDream,
  selectDreamSessions,
} from "../../src/dream/orchestrator.js";
import type { ExtractedSession } from "../../src/dream/session-reader.js";
import { MemoryStore } from "../../src/store.js";
import { createModelCall } from "../../src/model-call.js";

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
    const events: Array<{ operation: string; input: number; output: number; cost?: number }> = [];
    const models = ["miner", "refiner", "advisor"].map((id) => ({
      provider: "custom-provider",
      id,
      name: id,
      api: "test-api",
    }));
    const streamSimple = vi.fn().mockImplementation((model) => ({
      result: vi.fn().mockResolvedValue({
        role: "assistant",
        content: [{
          type: "text",
          text: model.id === "miner"
            ? JSON.stringify({ semantic: [], lessons: [] })
            : model.id === "refiner"
              ? JSON.stringify({ operations: [] })
              : "## Workflow\nNo changes.",
        }],
        api: "test-api",
        provider: "backend-a",
        model: `physical-${model.id}`,
        usage: {
          input: 25,
          output: 5,
          cacheRead: 3,
          cacheWrite: 2,
          totalTokens: 35,
          cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      }),
    }));
    const modelCall = createModelCall({
      model: undefined,
      modelRegistry: { getAll: () => models, streamSimple } as unknown as ModelRegistry,
    }, (event) => events.push(event));
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
        },
        modelCall,
        { setStatus: vi.fn(), notify: vi.fn() },
        {
          manual: false,
          onUsageEvent: (event) => events.push(event),
        },
      );

      expect(result.success).toBe(true);
      expect(streamSimple).toHaveBeenCalledTimes(3);
      expect(streamSimple.mock.calls.map(([model]) => `${model.provider}/${model.id}`)).toEqual([
        "custom-provider/miner",
        "custom-provider/refiner",
        "custom-provider/advisor",
      ]);
      for (const operation of ["dream-mine", "dream-refine", "dream-advise"]) {
        expect(events).toContainEqual(
          expect.objectContaining({
            operation,
            input: 25,
            output: 5,
            cost: 0.03,
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

describe("Dream model runtime execution", () => {
  it("bounds concurrent mining calls without spawning Pi subprocesses", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-memory-dream-concurrency-"));
    tempDirs.push(root);
    const projectDir = join(root, "sessions", "--workspace-example--");
    mkdirSync(projectDir, { recursive: true });
    for (let index = 0; index < 8; index++) {
      writeFileSync(
        join(projectDir, `2026-01-${String(index + 1).padStart(2, "0")}T00-00-00-000Z_fixture.jsonl`),
        [
          JSON.stringify({ type: "session", version: 3, id: `fixture-${index}` }),
          JSON.stringify({ type: "message", message: { role: "user", content: "first substantive request" } }),
          JSON.stringify({ type: "message", message: { role: "assistant", content: "x".repeat(220_000) } }),
          JSON.stringify({ type: "message", message: { role: "user", content: "second substantive request" } }),
          JSON.stringify({ type: "message", message: { role: "assistant", content: "second answer" } }),
        ].join("\n"),
      );
    }
    const store = new MemoryStore(join(root, "memory.db"));
    let active = 0;
    let maxActive = 0;
    const modelCall = vi.fn(async ({ operation }: { operation: string }) => {
      if (operation === "dream-mine") {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
        return JSON.stringify({ semantic: [], lessons: [] });
      }
      if (operation === "dream-refine") return JSON.stringify({ operations: [] });
      return "## Workflow\nNo changes.";
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
        },
        modelCall,
        { setStatus: vi.fn(), notify: vi.fn() },
        { manual: true },
      );

      expect(result.success).toBe(true);
      expect(modelCall.mock.calls.filter(([request]) => request.operation === "dream-mine")).toHaveLength(8);
      expect(maxActive).toBe(3);
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
          },
        },
      }),
    );

    const config = readDreamConfig(cwd);
    expect(config.minerModel).toBe("custom-provider/miner");
    expect(config.refinerModel).toBe("custom-provider/refiner");
    expect(config.advisorModel).toBe("custom-provider/advisor");
  });
});
