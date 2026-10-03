import { describe, expect, it } from "vitest";
import { statusLabel } from "../../src/status.js";

describe("GitHub authority status", () => {
  it("renders collaboration, autonomy, and checks progress", () => {
    expect(statusLabel({ mode: "collaboration" })).toBe("GH ✎");
    expect(statusLabel({ mode: "autonomous" })).toBe("GH 🚀");
    expect(statusLabel({ mode: "autonomous" }, { completed: 2, total: 5 })).toBe("GH 🚀 2/5");
    expect(statusLabel(null)).toBeNull();
  });
});
