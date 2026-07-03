/**
 * Chat exit actions — what happens when you close the side-chat.
 */

import type { ChatEngine } from "./engine.js";

export type ExitActionType = "discard" | "inject" | "summarize-inject" | "steer" | "save-as-note";

export interface ExitAction {
  key: string;
  label: string;
  action: ExitActionType;
  description: string;
}

export interface ExitResult {
  action: ExitActionType;
  content: string;
}

/** All available exit actions */
export const EXIT_ACTIONS: ExitAction[] = [
  {
    key: "d",
    label: "Discard",
    action: "discard",
    description: "Throw away the conversation",
  },
  {
    key: "i",
    label: "Inject",
    action: "inject",
    description: "Inject full conversation into main context",
  },
  {
    key: "s",
    label: "Summarize + Inject",
    action: "summarize-inject",
    description: "Summarize then inject into main context",
  },
  {
    key: "t",
    label: "Steer",
    action: "steer",
    description: "Redirect the main agent based on this chat",
  },
  {
    key: "n",
    label: "Save as Note",
    action: "save-as-note",
    description: "Auto-summarize and save as a note for later",
  },
];

/** Execute an exit action, returning the result content */
export async function executeExitAction(
  actionType: ExitActionType,
  engine: ChatEngine,
  signal?: AbortSignal,
): Promise<ExitResult | null> {
  switch (actionType) {
    case "discard":
      return null;

    case "inject":
      return {
        action: "inject",
        content: engine.getFormattedConversation(),
      };

    case "summarize-inject": {
      const summary = await engine.summarize(signal);
      return {
        action: "summarize-inject",
        content: summary,
      };
    }

    case "steer": {
      const messages = engine.getMessages();
      const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
      return {
        action: "steer",
        content: lastAssistant?.content ?? "No assistant response to steer with",
      };
    }

    case "save-as-note": {
      const summary = await engine.summarize(signal);
      return {
        action: "save-as-note",
        content: summary,
      };
    }
  }
}
