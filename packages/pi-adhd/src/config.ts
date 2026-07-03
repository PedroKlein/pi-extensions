/**
 * Extension configuration parser.
 * Reads "pi-adhd" key from Pi's settings.json.
 */

export interface AdhDConfig {
  /** Turns before reminder fires (default: 8) */
  reminderTurns: number;
}

const DEFAULTS: AdhDConfig = {
  reminderTurns: 8,
};

/** Parse pi-adhd config from settings object. Missing key → all defaults. */
export function parseAdhDConfig(settings: unknown): AdhDConfig {
  if (!settings || typeof settings !== "object") return { ...DEFAULTS };

  const raw = (settings as Record<string, unknown>)["pi-adhd"];
  if (!raw || typeof raw !== "object") return { ...DEFAULTS };

  const cfg = raw as Record<string, unknown>;

  const reminderTurns =
    typeof cfg.reminderTurns === "number" && cfg.reminderTurns > 0
      ? cfg.reminderTurns
      : DEFAULTS.reminderTurns;

  return { reminderTurns };
}
