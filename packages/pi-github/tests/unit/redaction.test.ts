import { describe, expect, it } from "vitest";
import { createRedactor, truncateText } from "../../src/redaction.js";

describe("createRedactor", () => {
  it("removes known and credential-shaped secrets", () => {
    const redact = createRedactor(["known-secret"]);
    const output = redact([
      "token=known-secret",
      "Authorization: Bearer bearer-secret-value",
      "GITHUB_TOKEN=environment-secret",
      "https://user:password@example.test/path",
    ].join("\n"));

    expect(output).not.toContain("known-secret");
    expect(output).not.toContain("bearer-secret-value");
    expect(output).not.toContain("environment-secret");
    expect(output).not.toContain("user:password");
    expect(output).toContain("[REDACTED]");
  });
});

describe("truncateText", () => {
  it("bounds UTF-8 output and reports omitted bytes", () => {
    const result = truncateText("abc😀def", 7);

    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(7);
    expect(result).toMatchObject({ truncated: true });
    expect(result.omittedBytes).toBeGreaterThan(0);
  });

  it("leaves exact-boundary output unchanged", () => {
    expect(truncateText("abcd", 4)).toEqual({
      text: "abcd",
      truncated: false,
      omittedBytes: 0,
    });
  });
});
