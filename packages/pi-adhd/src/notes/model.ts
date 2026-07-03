/**
 * Core types for pi-adhd notes system.
 */

export type NoteCategory = "prompt" | "reminder" | "reference";

export type PinScope = "project" | "global";

export interface Note {
  id: string;
  title: string;
  content: string;
  category: NoteCategory;
  pinned: PinScope | null;
  createdAt: number;
}

export interface InjectionResult {
  content: string;
  mode: "prompt" | "context";
}

/** Category → emoji icon mapping */
export const CATEGORY_ICONS: Record<NoteCategory, string> = {
  prompt: "🚀",
  reminder: "🔔",
  reference: "📎",
};

/** Category → injection mode (null = never injected) */
export const CATEGORY_INJECTION_MODE: Record<NoteCategory, "prompt" | "context" | null> = {
  prompt: "prompt",
  reference: "context",
  reminder: null,
};

/** All valid categories for cycling */
export const CATEGORIES: NoteCategory[] = ["prompt", "reminder", "reference"];

/** Create a new note with generated ID */
export function createNote(
  title: string,
  content: string,
  category: NoteCategory = "prompt",
): Note {
  return {
    id: crypto.randomUUID(),
    title,
    content,
    category,
    pinned: null,
    createdAt: Date.now(),
  };
}
