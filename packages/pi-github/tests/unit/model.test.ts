import { describe, expect, it } from "vitest";
import {
  parseAnnotation,
  parseCheck,
  parseIssue,
  parseOperationReceipt,
  parsePullRequest,
  parseReview,
} from "../../src/model.js";

const SHA = "a".repeat(40);

const valid = {
  annotation: { path: "src/index.ts", message: "failed", level: "failure", startLine: 4 },
  check: { id: 1, name: "test", status: "completed", conclusion: "success", headSha: SHA, url: "https://git.example.test/check/1" },
  issue: { number: 7, title: "Bug", state: "OPEN", url: "https://git.example.test/org/repo/issues/7" },
  receipt: { operation: "comment", repository: "org/repo", actor: "user", url: "https://git.example.test/result/1", headSha: SHA },
  pullRequest: { number: 3, title: "Change", state: "OPEN", url: "https://git.example.test/org/repo/pull/3", headSha: SHA, baseSha: "b".repeat(40), headRepository: "org/repo" },
  review: { id: 5, author: "reviewer", state: "APPROVED", body: "looks good", url: "https://git.example.test/review/5" },
};

describe("GitHub model parsers", () => {
  it("preserves complete identities and commit SHAs", () => {
    expect(parseAnnotation(valid.annotation)).toEqual(valid.annotation);
    expect(parseCheck(valid.check)).toEqual(valid.check);
    expect(parseIssue(valid.issue)).toEqual(valid.issue);
    expect(parseOperationReceipt(valid.receipt)).toEqual(valid.receipt);
    expect(parsePullRequest(valid.pullRequest)).toEqual(valid.pullRequest);
    expect(parseReview(valid.review)).toEqual(valid.review);
  });

  it.each([
    ["annotation", () => parseAnnotation({ ...valid.annotation, path: "" })],
    ["check", () => parseCheck({ ...valid.check, headSha: SHA.slice(1) })],
    ["issue", () => parseIssue({ ...valid.issue, number: 0 })],
    ["receipt", () => parseOperationReceipt({ ...valid.receipt, actor: undefined })],
    ["pull request", () => parsePullRequest({ ...valid.pullRequest, headRepository: undefined })],
    ["review", () => parseReview({ ...valid.review, id: undefined })],
  ])("rejects a malformed %s", (_name, parse) => {
    expect(parse).toThrow();
  });
});
