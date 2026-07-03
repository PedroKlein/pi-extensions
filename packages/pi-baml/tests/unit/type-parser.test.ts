import { describe, it, expect } from "vitest";
import { parseTypeDefinitions } from "../../src/lib/type-parser.js";

describe("parseTypeDefinitions", () => {
  it("extracts a single class definition", () => {
    const source = `class TodoItem {\n  description string\n  done bool\n}`;
    const result = parseTypeDefinitions(source);

    expect(result).toHaveLength(1);
    expect(result[0]).toContain("class TodoItem");
    expect(result[0]).toContain("description string");
    expect(result[0]).toContain("done bool");
  });

  it("extracts a single enum definition", () => {
    const source = `enum Priority {\n  High\n  Medium\n  Low\n}`;
    const result = parseTypeDefinitions(source);

    expect(result).toHaveLength(1);
    expect(result[0]).toContain("enum Priority");
    expect(result[0]).toContain("High");
    expect(result[0]).toContain("Low");
  });

  it("extracts multiple types from one source in order", () => {
    const source = [
      "class TodoItem {",
      "  description string",
      "}",
      "",
      "enum Priority {",
      "  High",
      "  Medium",
      "  Low",
      "}",
    ].join("\n");

    const result = parseTypeDefinitions(source);

    expect(result).toHaveLength(2);
    expect(result[0]).toContain("class TodoItem");
    expect(result[1]).toContain("enum Priority");
  });

  it("handles @description annotations containing parens and quotes", () => {
    const source = [
      "class ActionItem {",
      '  description string @description("what needs to be done")',
      '  priority "high" | "medium" | "low" @description("urgency level")',
      "  assignee string?",
      "}",
    ].join("\n");

    const result = parseTypeDefinitions(source);

    expect(result).toHaveLength(1);
    expect(result[0]).toContain('@description("what needs to be done")');
    expect(result[0]).toContain('@description("urgency level")');
  });

  it("handles string fields with special characters in annotations", () => {
    const source = [
      "class Item {",
      '  label string @description("name (required)")',
      '  status string @description("one of: active, inactive, or pending")',
      "  tags string[]",
      "}",
    ].join("\n");

    const result = parseTypeDefinitions(source);

    expect(result).toHaveLength(1);
    expect(result[0]).toContain("label string");
    expect(result[0]).toContain("tags string[]");
  });

  it("returns empty array when source has no type definitions", () => {
    const source = [
      "// just a comment",
      "",
      "function Foo(x: string) -> string {",
      "  client PiClient",
      '  prompt #"..."#',
      "}",
    ].join("\n");

    const result = parseTypeDefinitions(source);

    expect(result).toEqual([]);
  });

  it("ignores function blocks — does not extract them as types", () => {
    const source = [
      "function ExtractTodos(notes: string) -> TodoItem[] {",
      "  client PiClient",
      '  prompt #"..."#',
      "}",
    ].join("\n");

    const result = parseTypeDefinitions(source);

    expect(result).toEqual([]);
  });

  it("ignores function blocks while extracting sibling type definitions", () => {
    const source = [
      "class TodoItem {",
      "  description string",
      "}",
      "",
      "function ExtractTodos(notes: string) -> TodoItem[] {",
      "  client PiClient",
      '  prompt #"..."#',
      "}",
      "",
      "enum Priority {",
      "  High",
      "  Low",
      "}",
    ].join("\n");

    const result = parseTypeDefinitions(source);

    expect(result).toHaveLength(2);
    expect(result[0]).toContain("class TodoItem");
    expect(result[1]).toContain("enum Priority");
    expect(result.join("")).not.toContain("function");
  });

  it("preserves original formatting and whitespace in extracted block", () => {
    const source = [
      "class TodoItem {",
      '  description string @description("what needs to be done")',
      '  priority "high" | "medium" | "low"',
      "  assignee string?",
      "}",
    ].join("\n");

    const result = parseTypeDefinitions(source);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(source);
  });

  it("handles class with empty body", () => {
    const source = `class Empty {}`;
    const result = parseTypeDefinitions(source);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe("class Empty {}");
  });

  it("handles enum with empty body", () => {
    const source = `enum Void {}`;
    const result = parseTypeDefinitions(source);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe("enum Void {}");
  });

  it("handles a realistic full BAML file with both types and functions", () => {
    const source = [
      "class ActionItem {",
      '  description string @description("what needs to be done")',
      "  assignee string?",
      '  priority "high" | "medium" | "low"',
      "}",
      "",
      "class MeetingSummary {",
      "  title string",
      "  action_items ActionItem[]",
      "}",
      "",
      "function ExtractMeetingSummary(transcript: string) -> MeetingSummary {",
      "  client PiClient",
      '  prompt #"Extract a structured summary."#',
      "}",
    ].join("\n");

    const result = parseTypeDefinitions(source);

    expect(result).toHaveLength(2);
    expect(result[0]).toContain("class ActionItem");
    expect(result[1]).toContain("class MeetingSummary");
    expect(result.some((r) => r.includes("function"))).toBe(false);
  });
});
