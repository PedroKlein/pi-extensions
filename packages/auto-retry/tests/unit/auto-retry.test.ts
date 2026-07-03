import { describe, it, expect } from "vitest";
import { isJsonParseError, MAX_RETRIES, RETRY_MESSAGE } from "../../src/index.js";

describe("isJsonParseError", () => {
  it("detects 'unexpected' + 'position' pattern", () => {
    expect(isJsonParseError("Unexpected non-whitespace character after JSON at position 4210")).toBe(true);
  });

  it("detects 'unexpected' + 'json' pattern", () => {
    expect(isJsonParseError("Unexpected token in JSON at position 42")).toBe(true);
  });

  it("detects 'json' + 'parse' pattern", () => {
    expect(isJsonParseError("JSON parse error: unexpected end")).toBe(true);
  });

  it("detects unterminated string", () => {
    expect(isJsonParseError("Unterminated string in JSON")).toBe(true);
  });

  it("detects bad control character", () => {
    expect(isJsonParseError("Bad control character in string literal in JSON")).toBe(true);
  });

  it("detects expected comma or brace", () => {
    expect(isJsonParseError("Expected ',' or '}' after property value in JSON")).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isJsonParseError("Network timeout after 30 seconds")).toBe(false);
    expect(isJsonParseError("File not found: /some/path")).toBe(false);
    expect(isJsonParseError("TypeError: Cannot read property of undefined")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isJsonParseError("UNEXPECTED TOKEN IN JSON")).toBe(true);
    expect(isJsonParseError("BAD CONTROL CHARACTER IN STRING")).toBe(true);
  });
});

describe("constants", () => {
  it("MAX_RETRIES is 2", () => {
    expect(MAX_RETRIES).toBe(2);
  });

  it("RETRY_MESSAGE instructs smaller edits", () => {
    expect(RETRY_MESSAGE).toContain("malformed JSON");
    expect(RETRY_MESSAGE).toContain("smaller");
  });
});
