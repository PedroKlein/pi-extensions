import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piMemory from "../../src/index.js";

describe("pi-memory extension surface", () => {
  it("keeps every existing memory tool registered", () => {
    const toolNames: string[] = [];
    const pi = {
      registerTool: (tool: { name: string }) => toolNames.push(tool.name),
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      on: vi.fn(),
    } as unknown as ExtensionAPI;

    piMemory(pi);

    expect(toolNames).toEqual([
      "memory_search",
      "memory_remember",
      "memory_forget",
      "memory_lessons",
      "memory_stats",
      "memory_pin",
    ]);
  });
});
