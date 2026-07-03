/**
 * Reminder tracker — monitors turn count and fires notifications.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { NotesStore } from "../notes/store.js";
import type { AdhDConfig } from "../config.js";

/**
 * Handle turn_end event — increment counter and fire reminder if needed.
 */
export function onTurnEnd(store: NotesStore, config: AdhDConfig, ctx: ExtensionContext): void {
  if (store.count === 0) return;

  store.incrementTurns();

  if (store.shouldRemind(config.reminderTurns)) {
    store.markReminderFired();

    // Fire toast notification
    if (ctx.hasUI) {
      ctx.ui.notify(`🧠 You have ${store.count} pending notes`, "info");
    }

    // Update status bar with ⚡
    updateStatus(store, ctx);
  }
}

/**
 * Update the status bar indicator.
 */
export function updateStatus(store: NotesStore, ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  if (store.count === 0) {
    ctx.ui.setStatus("pi-adhd", undefined);
    return;
  }

  const needsReminder = store.reminderFired && store.turnsSinceInteraction >= 1;
  const flash = needsReminder ? " ⚡" : "";
  ctx.ui.setStatus("pi-adhd", `🧠 ${store.count} notes${flash}`);
}
