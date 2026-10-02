/**
 * LLM conversation engine for the side-chat.
 * Manages message history, model selection, streaming, and usage tracking.
 */

import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  contextTokens: number;
  cost: number;
  turns: number;
}

const SYSTEM_PROMPT = `You are a helpful assistant in a side-chat. Be concise and direct. The user is working on a coding project and has a quick question or needs a brief conversation without disturbing their main workflow.`;

export class ChatEngine {
  private chatMessages: ChatMessage[] = [];
  private llmMessages: Message[] = [];
  private ctx: ExtensionContext;
  private _streaming = false;
  private sideModel: Model<Api> | null = null;
  private extraContext: string | undefined;
  private onResponse: ((response: AssistantMessage, durationMs: number, model: Model<Api>) => void) | undefined;
  private usage: UsageStats = { inputTokens: 0, outputTokens: 0, contextTokens: 0, cost: 0, turns: 0 };

  constructor(
    ctx: ExtensionContext,
    extraContext?: string,
    onResponse?: (response: AssistantMessage, durationMs: number, model: Model<Api>) => void,
  ) {
    this.ctx = ctx;
    this.extraContext = extraContext;
    this.onResponse = onResponse;
  }

  get model() {
    return this.sideModel ?? this.ctx.model;
  }

  get streaming(): boolean {
    return this._streaming;
  }

  setModel(model: Model<Api>): void {
    this.sideModel = model;
  }

  getMessages(): ChatMessage[] {
    return [...this.chatMessages];
  }

  getUsage(): UsageStats {
    return { ...this.usage };
  }

  private get systemPrompt(): string {
    return this.extraContext
      ? `${SYSTEM_PROMPT}\n\n## Main Conversation Context\n\n${this.extraContext}`
      : SYSTEM_PROMPT;
  }

  /** Send a user message and get streamed assistant response */
  async send(
    userMessage: string,
    signal?: AbortSignal,
    onChunk?: (chunk: string) => void,
  ): Promise<string> {
    this.chatMessages.push({
      role: "user",
      content: userMessage,
      timestamp: Date.now(),
    });

    this.llmMessages.push({
      role: "user",
      content: [{ type: "text", text: userMessage }],
      timestamp: Date.now(),
    } as Message);

    const model = this.model;
    if (!model) throw new Error("No model available for side-chat");

    this._streaming = true;
    let fullResponse = "";
    const startedAt = Date.now();

    try {
      const eventStream = this.ctx.modelRegistry.streamSimple(
        model,
        {
          systemPrompt: this.systemPrompt,
          messages: [...this.llmMessages],
        },
        signal ? { signal } : {},
      );

      let finalMessage: AssistantMessage | null = null;

      for await (const event of eventStream) {
        if (event.type === "text_delta") {
          fullResponse += event.delta;
          onChunk?.(event.delta);
        } else if (event.type === "done") {
          finalMessage = event.message;
        } else if (event.type === "error") {
          finalMessage = event.error;
          if (event.reason !== "aborted") {
            const errMsg = event.error.errorMessage || "Unknown error";
            fullResponse += `\nError: ${errMsg}`;
          }
        }
      }

      if (finalMessage) {
        this.onResponse?.(finalMessage, Date.now() - startedAt, model);
      }

      if (finalMessage && finalMessage.stopReason !== "error" && finalMessage.stopReason !== "aborted") {
        this.llmMessages.push(finalMessage);

        this.usage.inputTokens += finalMessage.usage.input;
        this.usage.outputTokens += finalMessage.usage.output;
        this.usage.contextTokens = finalMessage.usage.totalTokens;
        this.usage.cost += finalMessage.usage.cost.total;
        this.usage.turns++;

        const textContent = finalMessage.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n");
        if (textContent) fullResponse = textContent;
      }
    } finally {
      this._streaming = false;
    }

    this.chatMessages.push({
      role: "assistant",
      content: fullResponse,
      timestamp: Date.now(),
    });

    return fullResponse;
  }

  /** Summarize the conversation */
  async summarize(signal?: AbortSignal): Promise<string> {
    const model = this.model;
    if (!model) throw new Error("No model available for summarization");

    const conversationText = this.chatMessages
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n\n");

    const startedAt = Date.now();
    const result = await this.ctx.modelRegistry.streamSimple(
      model,
      {
        systemPrompt: "Summarize conversations into concise actionable notes.",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: `Summarize this conversation into a concise actionable note (1-3 sentences). Focus on the conclusion or key insight:\n\n${conversationText}` }],
            timestamp: Date.now(),
          } as Message,
        ],
      },
      signal ? { signal } : {},
    ).result();
    this.onResponse?.(result, Date.now() - startedAt, model);

    const text = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    return text || "Side-chat summary unavailable";
  }

  /** Get the full conversation as formatted text */
  getFormattedConversation(): string {
    return this.chatMessages
      .map((m) => `**${m.role === "user" ? "You" : "Assistant"}:** ${m.content}`)
      .join("\n\n");
  }
}
