import { describe, it, expect } from "vitest";
import { executeExitAction } from "../../src/chat/actions.js";

// Minimal mock ChatEngine
function createMockEngine(messages = [{ role: "user" as const, content: "hello", timestamp: 1 }, { role: "assistant" as const, content: "hi there", timestamp: 2 }]) {
  return {
    getMessages: () => messages,
    getFormattedConversation: () => messages.map(m => `**${m.role}:** ${m.content}`).join("\n\n"),
    summarize: async () => "Summary of conversation",
  };
}

describe("exit actions", () => {
  it("discard returns null", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeExitAction("discard", createMockEngine() as any);
    expect(result).toBeNull();
  });

  it("inject returns full conversation", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeExitAction("inject", createMockEngine() as any);
    expect(result?.action).toBe("inject");
    expect(result?.content).toContain("hello");
    expect(result?.content).toContain("hi there");
  });

  it("summarize-inject returns summary", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeExitAction("summarize-inject", createMockEngine() as any);
    expect(result?.action).toBe("summarize-inject");
    expect(result?.content).toBe("Summary of conversation");
  });

  it("steer returns last assistant message", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeExitAction("steer", createMockEngine() as any);
    expect(result?.action).toBe("steer");
    expect(result?.content).toBe("hi there");
  });

  it("save-as-note returns summary", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await executeExitAction("save-as-note", createMockEngine() as any);
    expect(result?.action).toBe("save-as-note");
    expect(result?.content).toBe("Summary of conversation");
  });
});
