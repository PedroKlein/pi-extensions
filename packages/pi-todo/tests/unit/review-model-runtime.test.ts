import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const host = vi.hoisted(() => ({
  fetchPrDiff: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  BorderedLoader: class {
    signal = new AbortController().signal;
    onAbort: (() => void) | undefined;
  },
  SessionManager: { create: vi.fn() },
}));

vi.mock("../../src/github.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/github.js")>()),
  fetchPrDiff: host.fetchPrDiff,
}));

import { showAiSummaryModal } from "../../src/review.js";

const task = {
  id: 1,
  title: "Review change",
  status: "open" as const,
  type: "review" as const,
  priority: "medium" as const,
  repoId: "reviews",
  createdAt: 1,
  updatedAt: 1,
  url: "https://github.com/example/project/pull/42",
  prMeta: {
    title: "Change",
    author: "octocat",
    state: "open" as const,
    branch: "feature",
    host: "github.com",
    owner: "example",
    repo: "project",
    number: 42,
  },
};

function response(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test-api",
    provider: "backend-a",
    model: "physical-model",
    usage: {
      input: 20,
      output: 5,
      cacheRead: 4,
      cacheWrite: 1,
      reasoning: 2,
      totalTokens: 30,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

describe("PR review nested model calls", () => {
  it("routes summary and Q&A through ModelRuntime and reports physical usage", async () => {
    host.fetchPrDiff.mockResolvedValue("diff --git a/file b/file");
    const selectedModel = { provider: "router", id: "auto" };
    const responses = [response("## What\nA change"), response("It changes one file.")];
    const streamSimple = vi.fn().mockImplementation(() => ({
      result: vi.fn().mockResolvedValue(responses.shift()),
    }));
    const getApiKeyAndHeaders = vi.fn(() => {
      throw new Error("credential lookup must stay inside ModelRuntime");
    });
    let summaryUi: { handleInput(data: string): void } | undefined;
    let closeSummary: (() => void) | undefined;
    let customCall = 0;
    const tui = { requestRender: vi.fn() };
    const custom = vi.fn(async (factory: any) => {
      customCall++;
      if (customCall < 3) {
        return new Promise((resolve) => factory(tui, theme, {}, resolve));
      }
      return new Promise<void>((resolve) => {
        closeSummary = () => resolve();
        summaryUi = factory(tui, theme, {}, resolve);
      });
    });
    const emit = vi.fn();
    const pi = {
      exec: vi.fn(),
      events: { emit },
    } as unknown as ExtensionAPI;
    const ctx = {
      model: selectedModel,
      modelRegistry: { streamSimple, getApiKeyAndHeaders },
      ui: { custom, notify: vi.fn() },
    } as unknown as ExtensionContext;

    const modal = showAiSummaryModal(task, pi, ctx);
    await vi.waitFor(() => expect(summaryUi).toBeDefined());

    summaryUi!.handleInput("?");
    for (const char of "What changed?") summaryUi!.handleInput(char);
    summaryUi!.handleInput("\r");

    await vi.waitFor(() => expect(streamSimple).toHaveBeenCalledTimes(2));
    closeSummary!();
    await modal;

    expect(streamSimple.mock.calls[0]).toEqual([
      selectedModel,
      expect.objectContaining({ messages: [expect.objectContaining({ role: "user" })] }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ]);
    expect(streamSimple.mock.calls[1]).toEqual([
      selectedModel,
      expect.objectContaining({ messages: [expect.objectContaining({ role: "user" })] }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ]);
    expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledWith(
      "pi-audit:usage",
      expect.objectContaining({
        source: "pi-todo",
        model: "router/auto",
        route: "backend-a/physical-model",
        input: 20,
        output: 5,
      }),
    );
  });
});
