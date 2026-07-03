/**
 * Note capture with AI classification.
 *
 * Tier 1: BAML (if pi-baml available)
 * Tier 2: Direct LLM call
 * Tier 3: Heuristic fallback
 */

import type { NoteCategory } from "./model.js";

export interface ClassifiedNote {
  title: string;
  content: string;
  category: NoteCategory;
}

export interface ClassifyOptions {
  /** pi-baml library (from EventBus) */
  baml?: { available: boolean; execBaml?: <T>(code: string, fn: string, args: Record<string, unknown>) => Promise<T> };
  /** Model for direct LLM classification */
  model?: { id: string; apiKey: string; baseUrl?: string; headers?: Record<string, string> };
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

const BAML_CODE = `
class ClassifiedNote {
  title string @description("Short descriptive title, 3-6 words. Use key verb/noun from the note.")
  category "prompt" | "reminder" | "reference" @description("prompt=action to do later, reminder=fact to keep in mind, reference=technical info or decision")
}

function ClassifyNote(text: string) -> ClassifiedNote {
  client PiClient
  prompt #"
    Classify this quick note and give it a short title.

    Categories:
    - "prompt": Action to do later (generate ADRs, refactor module, ask about X)
    - "reminder": Fact to keep in mind (CI broken, meeting at 3, don't forget X)
    - "reference": Technical info or decision (auth uses JWT, chose approach B)

    Title rules: 3-6 words, specific, use key verb/noun from the note.

    Note: {{ text }}

    {{ ctx.output_format }}
  "#
}
`;

/** Classify a note using the best available method */
export async function classifyNote(text: string, options: ClassifyOptions = {}): Promise<ClassifiedNote> {
  // Tier 1: BAML
  if (options.baml?.available && options.baml.execBaml) {
    try {
      const result = await options.baml.execBaml<{ title: string; category: string }>(
        BAML_CODE,
        "ClassifyNote",
        { text },
      );
      if (isValidCategory(result.category)) {
        return { title: result.title.slice(0, 60), content: text, category: result.category };
      }
    } catch {
      // Fall through to tier 2
    }
  }

  // Tier 2: Direct LLM
  if (options.model) {
    try {
      const result = await classifyWithLLM(text, options.model);
      if (result) return result;
    } catch {
      // Fall through to tier 3
    }
  }

  // Tier 3: Heuristic fallback
  return classifyHeuristic(text);
}

async function classifyWithLLM(
  text: string,
  model: { id: string; apiKey: string; baseUrl?: string; headers?: Record<string, string> },
): Promise<ClassifiedNote | null> {
  const url = (model.baseUrl ?? "https://api.openai.com/v1") + "/chat/completions";

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${model.apiKey}`,
      ...(model.headers ?? {}),
    },
    body: JSON.stringify({
      model: model.id,
      messages: [{ role: "user", content: CLASSIFY_PROMPT + text }],
      temperature: 0,
      max_tokens: 150,
    }),
  });

  if (!response.ok) return null;

  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content?.trim();
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
