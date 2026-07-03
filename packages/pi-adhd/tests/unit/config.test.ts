import { describe, it, expect } from "vitest";
import { parseAdhDConfig } from "../../src/config.js";

describe("parseAdhDConfig", () => {
  it("returns defaults for missing settings", () => {
    const config = parseAdhDConfig(undefined);
    expect(config.reminderTurns).toBe(8);
  });

  it("returns defaults for null settings", () => {
    const config = parseAdhDConfig(null);
    expect(config.reminderTurns).toBe(8);
  });

  it("returns defaults when pi-adhd key is missing", () => {
    const config = parseAdhDConfig({ other: "stuff" });
    expect(config.reminderTurns).toBe(8);
  });

  it("reads custom reminderTurns", () => {
    const config = parseAdhDConfig({ "pi-adhd": { reminderTurns: 12 } });
    expect(config.reminderTurns).toBe(12);
  });

  it("ignores invalid reminderTurns (negative)", () => {
    const config = parseAdhDConfig({ "pi-adhd": { reminderTurns: -5 } });
    expect(config.reminderTurns).toBe(8);
  });

  it("ignores non-number reminderTurns", () => {
    const config = parseAdhDConfig({ "pi-adhd": { reminderTurns: "ten" } });
    expect(config.reminderTurns).toBe(8);
  });
});
