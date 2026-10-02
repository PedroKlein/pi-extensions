/**
 * Note capture with AI classification.
 *
 * Uses the active model when available, then falls back to heuristics.
 */

import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { NoteCategory } from "./model.js";

export interface ClassifiedNote {
  title: string;
  content: string;
  category: NoteCategory;
}

export interface ClassifyOptions {
  model?: Model<Api>;
  modelRegistry?: ModelRegistry;
  signal?: AbortSignal;
  onResponse?: (response: AssistantMessage, durationMs: number) => void;
}

const CLASSIFY_PROMPT = `You are classifying a quick note the user wants to save for later.

Given the note text, respond with JSON only:
{"title": "<short descriptive title, 3-6 words>", "category": "<prompt|reminder|reference>"}

Categories:
- "prompt": Something the user wants to DO or ASK the AI agent later. An action, a request, a task.
  Examples: "generate ADRs", "refactor the auth module", "ask about performance"
- "reminder": Something the user wants to REMEMBER but not act on. A fact to keep in mind.
  Examples: "CI is broken until Monday", "meeting at 3pm", "don't forget to push"
- "reference": Technical information or a decision to recall later as context.
  Examples: "auth uses JWT with RS256", "we chose approach B for caching", "API rate limit is 100/min"

Rules for the title:
- Be specific and descriptive, not generic
- Use the key action verb or noun from the note
- Don't just repeat the first few words
- 3-6 words max

Note text:
`;

/** Classify a note using the best available method */
export async function classifyNote(text: string, options: ClassifyOptions = {}): Promise<ClassifiedNote> {
  if (options.model && options.modelRegistry) {
    try {
      const result = await classifyWithLLM(text, options.model, options.modelRegistry, options.signal, options.onResponse);
      if (result) return result;
    } catch {
      // Fall through to heuristics
    }
  }

  return classifyHeuristic(text);
}

async function classifyWithLLM(
  text: string,
  model: Model<Api>,
  modelRegistry: ModelRegistry,
  signal?: AbortSignal,
  onResponse?: (response: AssistantMessage, durationMs: number) => void,
): Promise<ClassifiedNote | null> {
  const startedAt = Date.now();
  const response = await modelRegistry.streamSimple(
    model,
    {
      systemPrompt: CLASSIFY_PROMPT.trim(),
      messages: [{
        role: "user",
        content: [{ type: "text", text }],
        timestamp: Date.now(),
      }],
    },
    { ...(signal ? { signal } : {}), temperature: 0, maxTokens: 150 },
  ).result();
  onResponse?.(response, Date.now() - startedAt);

  if (response.stopReason === "aborted" || response.stopReason === "error") return null;

  const content = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  if (!content) return null;

  // Try to extract JSON from the response (handle markdown code blocks)
  const jsonStr = content.replace(/^```json?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();

  try {
    const parsed = JSON.parse(jsonStr) as { title?: string; category?: string };
    if (parsed.title && isValidCategory(parsed.category)) {
      return { title: parsed.title.slice(0, 60), content: text, category: parsed.category as NoteCategory };
    }
  } catch {
    // JSON parse failed
  }

  return null;
}

/** Heuristic fallback */
export function classifyHeuristic(text: string): ClassifiedNote {
  // Try to extract a meaningful short title
  const firstSentence = text.split(/[.!?\n]/)[0]?.trim() ?? text;
  const title = firstSentence.length > 50 ? firstSentence.slice(0, 47) + "..." : firstSentence;

  // Simple keyword-based category detection
  const lower = text.toLowerCase();
  let category: NoteCategory = "prompt";

  if (lower.match(/\b(remember|don't forget|note to self|keep in mind|meeting|deadline)\b/)) {
    category = "reminder";
  } else if (lower.match(/\b(uses|decided|chose|approach|architecture|pattern|configured|is set to)\b/)) {
    category = "reference";
  }

  return { title, content: text, category };
}

function isValidCategory(cat: unknown): cat is NoteCategory {
  return cat === "prompt" || cat === "reminder" || cat === "reference";
}
