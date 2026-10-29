import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage, Model, Api } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { createAskUserUI } from "../../src/ui.js";
import type { AskUserResult, NormalizedQuestion } from "../../src/types.js";

function response(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "text", text }], stopReason, timestamp: 1,
    api: "test-api", provider: "backend-a", model: "example-model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

function openForm(model: Model<Api> | null = { provider: "backend-a", id: "example-model" } as Model<Api>, type: NormalizedQuestion["type"] = "multi") {
  const done = vi.fn<(result: AskUserResult) => void>();
  const streamSimple = vi.fn().mockReturnValue({ result: vi.fn().mockResolvedValue(response("This decision controls where drafts are stored.")) });
  const ui = createAskUserUI({
    tui: { requestRender: vi.fn() } as unknown as TUI,
    theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
    done, model, modelRegistry: { streamSimple } as unknown as ModelRegistry,
    questions: [{ id: "storage", label: "Storage", prompt: "Where should drafts live?", type,
      options: type === "text" ? [] : [{ value: "local", label: "Local", description: "Saved on this device." }] }],
  });
  return { ui, done, streamSimple };
}

function screen(form: ReturnType<typeof openForm>, width = 100) {
  return form.ui.render(width).join("\n");
}

function followup(form: ReturnType<typeof openForm>, text: string) {
  form.ui.handleInput("?");
  for (const char of text) form.ui.handleInput(char);
  form.ui.handleInput("\r");
}

describe("question explanation UI", () => {
  it("shows missing-model feedback and returns to the unanswered form", () => {
    const form = openForm(null);
    expect(screen(form)).toContain("e explain question");
    form.ui.handleInput("e");
    expect(screen(form)).toContain("No model selected");
    expect(form.streamSimple).not.toHaveBeenCalled();
    form.ui.handleInput("\x1b");
    expect(screen(form)).toContain("[ ] Local");
    expect(form.done).not.toHaveBeenCalled();
  });

  it.each(["error", "empty", "rejected"])("shows %s request failure and allows retry", async (failure) => {
    const form = openForm();
    form.streamSimple.mockReturnValueOnce({ result: vi.fn().mockImplementation(() =>
      failure === "rejected" ? Promise.reject(new Error("network failure")) : Promise.resolve(response("", failure === "error" ? "error" : "stop")),
    ) });
    form.ui.handleInput("e");
    await vi.waitFor(() => expect(screen(form)).toContain("Could not explain this question"));
    expect(form.done).not.toHaveBeenCalled();
    form.ui.handleInput("r");
    await vi.waitFor(() => expect(screen(form)).toContain("This decision controls"));
    form.ui.handleInput("\x1b");
    expect(screen(form)).toContain("[ ] Local");
  });

  it("aborts explanation on back, ignores late responses, and safely starts a new request", async () => {
    const form = openForm();
    let resolveOld!: (value: AssistantMessage) => void;
    let resolveNew!: (value: AssistantMessage) => void;
    form.streamSimple.mockReturnValueOnce({ result: () => new Promise((resolve) => { resolveOld = resolve; }) });
    form.ui.handleInput("e");
    const oldSignal = form.streamSimple.mock.calls[0][2].signal;
    form.ui.handleInput("r");
    expect(form.streamSimple).toHaveBeenCalledTimes(1);
    form.ui.handleInput("\x1b");
    expect(oldSignal.aborted).toBe(true);
    expect(form.done).not.toHaveBeenCalled();
    form.streamSimple.mockReturnValueOnce({ result: () => new Promise((resolve) => { resolveNew = resolve; }) });
    form.ui.handleInput("e");
    resolveOld(response("stale explanation"));
    await Promise.resolve();
    expect(screen(form)).not.toContain("stale explanation");
    expect(screen(form)).toContain("Explaining...");
    resolveNew(response("Current explanation"));
    await vi.waitFor(() => expect(screen(form)).toContain("Current explanation"));
    form.ui.handleInput("\x1b");
    form.ui.handleInput("\x1b");
    expect(form.done.mock.calls[0][0].cancelled).toBe(true);
  });

  it("preserves a free-text answer and cancels follow-up input without cancelling the form", async () => {
    const form = openForm(undefined, "text");
    form.ui.handleInput("\r");
    for (const char of "Save on my device") form.ui.handleInput(char);
    form.ui.handleInput("\x1b");
    form.ui.handleInput("e");
    await vi.waitFor(() => expect(screen(form)).toContain("This decision controls"));
    form.ui.handleInput("?");
    form.ui.handleInput("\r");
    expect(form.streamSimple).toHaveBeenCalledTimes(1);
    form.ui.handleInput("\x1b");
    expect(screen(form)).toContain("Explain this question");
    form.ui.handleInput("\x1b");
    expect(screen(form)).toContain("Save on my device");
    form.ui.handleInput("\r");
    form.ui.handleInput("\r");
    expect(form.done.mock.calls[0][0].answers[0].freeText).toBe("Save on my device");
    expect(JSON.stringify(form.done.mock.calls[0][0])).not.toContain("This decision controls");
  });

  it("scrolls long explanations and keeps narrow rendering within the available width", async () => {
    const form = openForm();
    form.streamSimple.mockReturnValueOnce({ result: vi.fn().mockResolvedValue(response(Array.from({ length: 30 }, (_, i) => `Explanation line ${i + 1}`).join("\n"))) });
    form.ui.handleInput("e");
    await vi.waitFor(() => expect(screen(form)).toContain("Explanation line 1"));
    expect(screen(form)).not.toContain("Explanation line 30");
    for (let i = 0; i < 8; i++) form.ui.handleInput("J");
    expect(screen(form)).toContain("Explanation line 30");
    expect(form.ui.render(40).every((line) => visibleWidth(line) <= 40)).toBe(true);
    expect(screen(form, 40)).toContain("Esc back to answers");
  });

  it("reports provider cancellation without closing the questionnaire", async () => {
    const form = openForm();
    form.streamSimple.mockReturnValueOnce({ result: vi.fn().mockResolvedValue(response("", "aborted")) });
    form.ui.handleInput("e");
    await vi.waitFor(() => expect(screen(form)).toContain("Explanation cancelled"));
    expect(form.done).not.toHaveBeenCalled();
    form.ui.handleInput("r");
    await vi.waitFor(() => expect(screen(form)).toContain("This decision controls"));
  });

  it("does not forward explanation reasoning to private follow-ups", async () => {
    const form = openForm();
    form.streamSimple.mockReturnValueOnce({ result: vi.fn().mockResolvedValue({
      ...response("This decision controls where drafts are stored."),
      content: [{ type: "thinking", thinking: "private explanation reasoning" }, { type: "text", text: "This decision controls where drafts are stored." }],
    }) });
    form.ui.handleInput("e");
    await vi.waitFor(() => expect(screen(form)).toContain("This decision controls"));
    followup(form, "Why does that matter?");
    await vi.waitFor(() => expect(form.streamSimple).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(form.streamSimple.mock.calls[1][1])).not.toContain("private explanation reasoning");
  });

  it("aborts outstanding requests when the form is disposed", async () => {
    const form = openForm();
    let resolve!: (value: AssistantMessage) => void;
    form.streamSimple.mockReturnValueOnce({ result: () => new Promise((done) => { resolve = done; }) });
    form.ui.handleInput("e");
    const signal = form.streamSimple.mock.calls[0][2].signal;
    form.ui.dispose?.();
    expect(signal.aborted).toBe(true);
    resolve(response("Late response after disposal"));
    await Promise.resolve();
    expect(screen(form)).not.toContain("Late response after disposal");
    expect(form.done).not.toHaveBeenCalled();
  });

  it("keeps option explanations separate from question explanations", async () => {
    const form = openForm();
    form.ui.handleInput("e");
    await vi.waitFor(() => expect(screen(form)).toContain("This decision controls"));
    form.ui.handleInput("\x1b");
    form.streamSimple.mockReturnValueOnce({ result: vi.fn().mockResolvedValue(response("Local storage works offline.")) });
    form.ui.handleInput("?");
    form.ui.handleInput("\r");
    await vi.waitFor(() => expect(screen(form)).toContain("Local storage works offline."));
    expect(screen(form)).not.toContain("This decision controls");
    expect(JSON.stringify(form.streamSimple.mock.calls[1][1])).not.toContain("This decision controls");
    form.ui.handleInput("e");
    expect(screen(form)).toContain("This decision controls");
    expect(screen(form)).not.toContain("Local storage works offline.");
    form.ui.handleInput("\x1b");
    form.ui.handleInput(" ");
    form.ui.handleInput("\r");
    expect(form.done.mock.calls[0][0].answers[0].selections[0].value).toBe("local");
    expect(JSON.stringify(form.done.mock.calls[0][0])).not.toContain("works offline");
  });

  it("retries a failed follow-up rather than asking a different question", async () => {
    const form = openForm();
    form.ui.handleInput("e");
    await vi.waitFor(() => expect(screen(form)).toContain("This decision controls"));
    form.streamSimple.mockReturnValueOnce({ result: vi.fn().mockRejectedValue(new Error("network failure")) });
    followup(form, "Will I lose my drafts?");
    await vi.waitFor(() => expect(screen(form)).toContain("Could not explain this question"));
    form.ui.handleInput("r");
    await vi.waitFor(() => expect(form.streamSimple).toHaveBeenCalledTimes(3));
    expect(form.streamSimple.mock.calls[2][1].messages.at(-1)).toMatchObject({ role: "user", content: "Will I lose my drafts?" });
  });
});
