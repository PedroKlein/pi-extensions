import { describe, it, expect } from "vitest";
import { classifyHeuristic } from "../../src/notes/capture.js";

describe("capture", () => {
  describe("classifyHeuristic", () => {
    it("defaults to prompt category for action-like text", () => {
      const result = classifyHeuristic("Generate ADRs for decisions");
      expect(result.category).toBe("prompt");
      expect(result.title).toBe("Generate ADRs for decisions");
      expect(result.content).toBe("Generate ADRs for decisions");
    });

    it("detects reminder keywords", () => {
      const result = classifyHeuristic("Don't forget to push before the meeting");
      expect(result.category).toBe("reminder");
    });

    it("detects reference keywords", () => {
      const result = classifyHeuristic("Auth service uses JWT with RS256");
      expect(result.category).toBe("reference");
    });

    it("truncates long titles at sentence boundary", () => {
      const longText = "a".repeat(100) + ". Second sentence here.";
      const result = classifyHeuristic(longText);
      expect(result.title.length).toBeLessThanOrEqual(50);
      expect(result.title.endsWith("...")).toBe(true);
    });

    it("uses first sentence as title", () => {
      const result = classifyHeuristic("Fix the login bug. Also check the tests.");
      expect(result.title).toBe("Fix the login bug");
    });

    it("preserves short single-sentence text as-is", () => {
      const result = classifyHeuristic("Quick note");
      expect(result.title).toBe("Quick note");
    });
  });
});
