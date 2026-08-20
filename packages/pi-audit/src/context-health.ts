import {
  measureStaticBurden,
  type MeasuredValue,
  type StaticBurdenInput,
  type TokenizerProvenance,
} from "./static-burden.js";

export interface ContextHealthInput {
  contextTokens: number;
  staticBurden: StaticBurdenInput;
  retainedEntries: unknown[];
}

interface MeasuredCount extends MeasuredValue {
  count: number;
}

export interface ContextHealthReport {
  schemaVersion: 1;
  tokenizer: Omit<TokenizerProvenance, "count">;
  static: {
    systemPrompt: MeasuredValue;
    skills: ReturnType<typeof measureStaticBurden>["categories"]["skills"];
    activeToolSchemas: MeasuredCount;
  };
  growth: {
    user: MeasuredCount;
    assistant: MeasuredCount;
    reasoning: MeasuredCount;
    toolResults: MeasuredCount;
    customMessages: MeasuredCount;
  };
  largestToolResults: Array<
    MeasuredValue & { entryId: string; toolName: string }
  >;
  thresholds: {
    currentTokens: number;
    crossed: number[];
    next: number | null;
  };
  recommendations: Array<{ command: string; purpose: string }>;
}

const THRESHOLDS = [100_000, 200_000, 350_000];

function measuredCount(): MeasuredCount {
  return { chars: 0, tokens: 0, count: 0 };
}

function add(
  target: MeasuredCount,
  text: string,
  tokenizer: TokenizerProvenance,
): void {
  target.chars += text.length;
  target.tokens += tokenizer.count(text);
  target.count += 1;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return JSON.stringify(block);
      const value = block as Record<string, unknown>;
      if (value.type === "text" && typeof value.text === "string") {
        return value.text;
      }
      if (value.type === "thinking" && typeof value.thinking === "string") {
        return value.thinking;
      }
      return JSON.stringify(value);
    })
    .join("\n");
}

function assistantParts(content: unknown): {
  assistant: string[];
  reasoning: string[];
} {
  if (!Array.isArray(content)) {
    return { assistant: [contentText(content)], reasoning: [] };
  }
  const assistant: string[] = [];
  const reasoning: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      assistant.push(JSON.stringify(block));
      continue;
    }
    const value = block as Record<string, unknown>;
    if (value.type === "thinking" && typeof value.thinking === "string") {
      reasoning.push(value.thinking);
    } else if (value.type === "text" && typeof value.text === "string") {
      assistant.push(value.text);
    } else {
      assistant.push(JSON.stringify(value));
    }
  }
  return { assistant, reasoning };
}

export function buildContextHealthReport(
  input: ContextHealthInput,
  tokenizer: TokenizerProvenance,
): ContextHealthReport {
  const staticReport = measureStaticBurden(input.staticBurden, tokenizer);
  const user = measuredCount();
  const assistant = measuredCount();
  const reasoning = measuredCount();
  const toolResults = measuredCount();
  const customMessages = measuredCount();
  const largestToolResults: ContextHealthReport["largestToolResults"] = [];

  for (const entry of input.retainedEntries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;

    if (record.type === "custom_message") {
      add(customMessages, contentText(record.content), tokenizer);
      continue;
    }
    if (record.type !== "message") continue;
    const message = record.message;
    if (!message || typeof message !== "object") continue;
    const normalized = message as Record<string, unknown>;

    if (normalized.role === "user") {
      add(user, contentText(normalized.content), tokenizer);
      continue;
    }
    if (normalized.role === "assistant") {
      const parts = assistantParts(normalized.content);
      for (const text of parts.assistant) add(assistant, text, tokenizer);
      for (const text of parts.reasoning) add(reasoning, text, tokenizer);
      continue;
    }
    if (normalized.role === "toolResult") {
      const text = contentText(normalized.content);
      add(toolResults, text, tokenizer);
      largestToolResults.push({
        entryId: typeof record.id === "string" ? record.id : "unknown",
        toolName:
          typeof normalized.toolName === "string"
            ? normalized.toolName
            : "unknown",
        chars: text.length,
        tokens: tokenizer.count(text),
      });
      continue;
    }
    if (normalized.role === "custom") {
      add(customMessages, contentText(normalized.content), tokenizer);
    }
  }

  largestToolResults.sort((left, right) => right.tokens - left.tokens);
  const crossed = THRESHOLDS.filter(
    (threshold) => input.contextTokens >= threshold,
  );
  const next = THRESHOLDS.find(
    (threshold) => input.contextTokens < threshold,
  );

  return {
    schemaVersion: 1,
    tokenizer: {
      name: tokenizer.name,
      provenance: tokenizer.provenance,
      accuracy: tokenizer.accuracy,
    },
    static: {
      systemPrompt: staticReport.categories.systemPrompt,
      skills: staticReport.categories.skills,
      activeToolSchemas: staticReport.categories.activeToolSchemas,
    },
    growth: { user, assistant, reasoning, toolResults, customMessages },
    largestToolResults: largestToolResults.slice(0, 5),
    thresholds: {
      currentTokens: input.contextTokens,
      crossed,
      next: next ?? null,
    },
    recommendations: [
      {
        command: "/compact",
        purpose: "Summarize the current session while preserving its thread.",
      },
      {
        command: "/handoff",
        purpose: "Create a durable continuation document before switching sessions.",
      },
      {
        command: "/new",
        purpose: "Start a clean session when prior context is no longer needed.",
      },
    ],
  };
}
