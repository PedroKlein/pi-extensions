import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager, initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piAsk from "../../src/index.js";
import type { NormalizedQuestion } from "../../src/types.js";

type Component = { handleInput(data: string): void; render(width: number): string[] };

function explanationResponse(text: string): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "text", text }], api: "test-api",
    provider: "backend-a", model: "example-model", stopReason: "stop", timestamp: 2,
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

function openQuestionnaire(
  session = SessionManager.inMemory(),
  questions: NormalizedQuestion[] = [{
    id: "storage", label: "Storage", prompt: "Which storage strategy?", type: "multi",
    context: "Decide how drafts are saved.",
    options: [{ value: "local", label: "Local", description: "Keeps drafts on this device" }],
  }],
) {
  let askUser: any;
  let ui!: Component;
  const streamSimple = vi.fn().mockReturnValue({
    result: vi.fn().mockResolvedValue(explanationResponse("We are deciding where drafts survive outages.")),
  });
  const emit = vi.fn();
  const pi = {
    registerTool: (tool: unknown) => { askUser = tool; }, registerCommand: vi.fn(), events: { emit },
  } as unknown as ExtensionAPI;
  piAsk(pi);
  const execution = askUser.execute("call-1", { questions }, undefined, undefined, {
    hasUI: true, model: { provider: "backend-a", id: "example-model" }, sessionManager: session,
    modelRegistry: { streamSimple },
    ui: { custom: (factory: any) => new Promise((resolve) => {
      ui = factory({ requestRender: vi.fn() }, {
        fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      }, {}, resolve);
    }) },
  });
  return { ui, streamSimple, emit, execution };
}

describe("pi-ask prompt placement", () => {
  it("keeps ask_user guidance on the tool and registers no prompt hook", () => {
    const tools: Array<{
      name: string;
      description?: string;
      promptGuidelines?: string[];
      parameters?: unknown;
    }> = [];
    const events: string[] = [];
    const pi = {
      registerTool: (tool: {
        name: string;
        description?: string;
        promptGuidelines?: string[];
        parameters?: unknown;
      }) => tools.push(tool),
      registerCommand: vi.fn(),
      on: (event: string) => events.push(event),
    } as unknown as ExtensionAPI;

    piAsk(pi);

    const askUser = tools.find((tool) => tool.name === "ask_user");
    expect(askUser?.promptGuidelines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("ALWAYS use ask_user"),
      ]),
    );
    expect(events).not.toContain("before_agent_start");
    expect(JSON.stringify(askUser)).not.toContain("action");
  });

  it("explains the question from conversation context without returning the explanation", async () => {
    const session = SessionManager.inMemory();
    session.appendMessage({ role: "user", content: "We need to protect unsaved drafts during a network outage.", timestamp: 1 });
    session.appendMessage({
      ...explanationResponse("We are deciding where drafts survive outages."),
      content: [
        { type: "thinking", thinking: "private reasoning must not be forwarded" },
        { type: "text", text: "Choose a draft storage strategy." },
      ],
    });
    const before = structuredClone(session.getEntries());
    const form = openQuestionnaire(session);
    form.ui.handleInput(" ");
    form.ui.handleInput("e");

    await vi.waitFor(() => expect(form.ui.render(100).join("\n")).toContain("We are deciding where drafts survive outages."));
    const payload = JSON.stringify(form.streamSimple.mock.calls[0][1]);
    expect(payload).toContain("protect unsaved drafts");
    expect(payload).toContain("Which storage strategy?");
    expect(payload).toContain("Keeps drafts on this device");
    expect(payload).not.toContain("private reasoning must not be forwarded");
    expect(form.emit).toHaveBeenCalledWith("pi-audit:usage", expect.objectContaining({ operation: "question-explain" }));

    form.ui.handleInput("\x1b");
    expect(form.ui.render(100).join("\n")).toContain("[x] Local");
    form.ui.handleInput("\r");
    const result = await form.execution;
    expect(result.content).toEqual([{ type: "text", text: "User answers:\n- Storage: Local" }]);
    expect(result.details.answers[0].selections[0].value).toBe("local");
    expect(JSON.stringify(result)).not.toContain("drafts survive outages");
    expect(session.getEntries()).toEqual(before);
  });

  it("keeps clarification follow-ups in a private thread for each question", async () => {
    const form = openQuestionnaire(SessionManager.inMemory(), [
      { id: "storage", label: "Storage", prompt: "Where should drafts live?", type: "single", options: [{ value: "local", label: "Local" }] },
      { id: "sync", label: "Sync", prompt: "When should drafts sync?", type: "text", options: [] },
    ]);
    form.ui.handleInput("e");
    await vi.waitFor(() => expect(form.ui.render(100).join("\n")).toContain("drafts survive outages"));
    form.streamSimple.mockReturnValueOnce({ result: vi.fn().mockResolvedValue(explanationResponse("Sync means copying drafts to another device.")) });
    form.ui.handleInput("?");
    for (const char of "What does sync mean?") form.ui.handleInput(char);
    form.ui.handleInput("\r");
    await vi.waitFor(() => expect(form.ui.render(100).join("\n")).toContain("Sync means copying"));
    const followup = form.streamSimple.mock.calls[1][1].messages;
    expect(followup[1]).toMatchObject({ role: "assistant", content: [{ type: "text", text: "We are deciding where drafts survive outages." }] });
    expect(followup[2]).toMatchObject({ role: "user", content: "What does sync mean?" });

    form.ui.handleInput("\x1b");
    form.ui.handleInput("\t");
    form.ui.handleInput("e");
    await vi.waitFor(() => expect(form.streamSimple).toHaveBeenCalledTimes(3));
    expect(JSON.stringify(form.streamSimple.mock.calls[2][1])).not.toContain("What does sync mean?");
    form.ui.handleInput("\x1b");
    form.ui.handleInput("\x1b[D");
    form.ui.handleInput("e");
    expect(form.ui.render(100).join("\n")).toContain("Sync means copying");
    expect(form.streamSimple).toHaveBeenCalledTimes(3);
    form.ui.handleInput("\x1b");
    form.ui.handleInput("\x1b");
    const result = await form.execution;
    expect(result.details.cancelled).toBe(true);
    expect(JSON.stringify(result)).not.toContain("sync mean");
  });

  it("uses the active compacted and edited context rather than abandoned history", async () => {
    const session = SessionManager.inMemory();
    session.appendMessage({ role: "user", content: "obsolete background", timestamp: 1 });
    const kept = session.appendMessage({ role: "user", content: "outdated draft policy", timestamp: 2 });
    session.appendCompaction("Draft recovery during outages is required.", kept, 100);
    session.appendContextEdit(kept, { content: "Current policy: keep drafts locally." });
    const leaf = session.getLeafId()!;
    session.appendMessage({ role: "user", content: "abandoned branch", timestamp: 3 });
    session.branch(leaf);
    session.appendCustomEntry("private-ui-state", { note: "not conversation context" });
    session.appendMessage({ role: "bashExecution", command: "private-command", output: "excluded output", excludeFromContext: true, exitCode: 0, cancelled: false, truncated: false, timestamp: 4 });
    const before = structuredClone(session.getEntries());
    const form = openQuestionnaire(session);
    form.ui.handleInput("e");
    await vi.waitFor(() => expect(form.ui.render(100).join("\n")).toContain("drafts survive outages"));
    const payload = JSON.stringify(form.streamSimple.mock.calls[0][1]);
    expect(payload).toContain("Draft recovery during outages is required.");
    expect(payload).toContain("Current policy: keep drafts locally.");
    for (const excluded of ["obsolete background", "outdated draft policy", "abandoned branch", "not conversation context", "excluded output"]) expect(payload).not.toContain(excluded);
    expect(session.getEntries()).toEqual(before);
    form.ui.handleInput("\x1b");
    form.ui.handleInput("\x1b");
    await form.execution;
  });

  it("keeps /answer explanations out of submitted messages", async () => {
    initTheme("dark");
    const session = SessionManager.inMemory();
    session.appendMessage({ role: "user", content: "Protect drafts during outages", timestamp: 1 });
    session.appendMessage(explanationResponse("Where should drafts live? Local or remote?"));
    const before = structuredClone(session.getEntries());
    const questions = [{ id: "storage", label: "Storage", prompt: "Where should drafts live?", type: "single", options: [{ value: "local", label: "Local", description: "Saved on the device" }] }];
    const streamSimple = vi.fn()
      .mockReturnValueOnce({ result: vi.fn().mockResolvedValue(explanationResponse(JSON.stringify(questions))) })
      .mockReturnValue({ result: vi.fn().mockResolvedValue(explanationResponse("This is a private clarification.")) });
    let handler: any;
    let component: Component | undefined;
    const sendUserMessage = vi.fn();
    piAsk({ registerTool: vi.fn(), registerCommand: (name: string, command: any) => { if (name === "answer") handler = command.handler; },
      sendUserMessage, events: { emit: vi.fn() } } as unknown as ExtensionAPI);
    const execution = handler("", {
      hasUI: true, model: { provider: "backend-a", id: "example-model" }, sessionManager: session,
      modelRegistry: { streamSimple }, ui: { notify: vi.fn(), custom: (factory: any) => new Promise((resolve) => {
        component = factory({ requestRender: vi.fn() }, {
          fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text,
        }, {}, (result: unknown) => {
          (component as Component & { dispose?: () => void })?.dispose?.();
          resolve(result);
        });
      }) },
    });
    await vi.waitFor(() => expect(component?.render(100).join("\n")).toContain("Where should drafts live?"));
    component!.handleInput("e");
    await vi.waitFor(() => expect(component!.render(100).join("\n")).toContain("This is a private clarification."));
    expect(JSON.stringify(streamSimple.mock.calls[1][1])).toContain("Protect drafts during outages");
    component!.handleInput("\x1b");
    component!.handleInput("\r");
    await execution;
    expect(sendUserMessage).toHaveBeenCalledWith("User answers:\n- Storage: Local");
    expect(session.getEntries()).toEqual(before);
  });

  it("attributes option explanations dispatched through ModelRuntime", async () => {
    let askUser: any;
    let component: { handleInput(data: string): void } | undefined;
    let finish: ((value: unknown) => void) | undefined;
    const response: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Use this option when latency matters." }],
      api: "test-api",
      provider: "backend-a",
      model: "physical-model",
      usage: {
        input: 11,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        reasoning: 1,
        totalTokens: 19,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    const streamSimple = vi.fn().mockReturnValue({
      result: vi.fn().mockResolvedValue(response),
    });
    const emit = vi.fn();
    const pi = {
      registerTool: (tool: unknown) => { askUser = tool; },
      registerCommand: vi.fn(),
      on: vi.fn(),
      events: { emit },
    } as unknown as ExtensionAPI;
    piAsk(pi);

    const selectedModel = { provider: "router", id: "auto" };
    const execution = askUser.execute(
      "call-1",
      {
        questions: [{
          id: "q1",
          prompt: "Which option?",
          type: "single",
          options: [{ value: "fast", label: "Fast" }],
        }],
      },
      undefined,
      undefined,
      {
        hasUI: true,
        sessionManager: SessionManager.inMemory(),
        model: selectedModel,
        modelRegistry: {
          streamSimple,
          getApiKeyAndHeaders: vi.fn(() => {
            throw new Error("credential lookup must stay inside ModelRuntime");
          }),
        },
        ui: {
          custom: (factory: any) => new Promise((resolve) => {
            finish = resolve;
            component = factory(
              { requestRender: vi.fn() },
              { fg: (_color: string, text: string) => text, bold: (text: string) => text },
              {},
              resolve,
            );
          }),
        },
      },
    );

    await vi.waitFor(() => expect(component).toBeDefined());
    component!.handleInput("?");
    for (const char of "Why?") component!.handleInput(char);
    component!.handleInput("\r");
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(1));
    finish!({ questions: [], answers: [], cancelled: true });
    await execution;

    expect(streamSimple).toHaveBeenCalledWith(
      selectedModel,
      expect.objectContaining({ messages: [expect.objectContaining({ role: "user" })] }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(emit).toHaveBeenCalledWith(
      "pi-audit:usage",
      expect.objectContaining({
        source: "pi-ask",
        operation: "option-explain",
        model: "router/auto",
        route: "backend-a/physical-model",
        input: 11,
        output: 5,
      }),
    );
  });
});
