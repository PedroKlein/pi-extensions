import { parseIssue, type Issue } from "./model.js";
import { quoteUntrusted } from "./output.js";

const MAX_ITEMS = 20;
const MAX_TEXT_BYTES = 8 * 1024;

export interface IssueComment {
  id: number;
  author: string;
  body: string;
  url: string;
}

export interface IssueSummary extends Issue {
  comments: IssueComment[];
}

export function normalizeIssue(value: unknown): IssueSummary {
  const record = object(value);
  const issue = parseIssue({
    number: record.number,
    title: record.title,
    body: boundedUntrusted(record.body),
    state: record.state,
    url: record.url,
    labels: array(record.labels).map((label) => text(object(label).name, "label name")),
    assignees: array(record.assignees).map((assignee) => text(object(assignee).login, "assignee login")),
  });
  const comments = array(record.comments).slice(0, MAX_ITEMS).map((comment) => {
    const item = object(comment);
    return {
      id: number(item.id, "comment id"),
      author: text(object(item.author).login, "comment author"),
      body: boundedUntrusted(item.body) ?? quoteUntrusted(""),
      url: text(item.url, "comment URL"),
    };
  });
  return { ...issue, comments };
}

export function summarizeIssues(values: unknown[]): {
  items: IssueSummary[];
  omittedItems: number;
} {
  return {
    items: values.slice(0, MAX_ITEMS).map(normalizeIssue),
    omittedItems: Math.max(0, values.length - MAX_ITEMS),
  };
}

function boundedUntrusted(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("Issue text must be a string.");
  let bounded = Buffer.from(value).subarray(0, MAX_TEXT_BYTES).toString("utf8");
  while (Buffer.byteLength(bounded) > MAX_TEXT_BYTES) bounded = bounded.slice(0, -1);
  return quoteUntrusted(bounded);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object.");
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${name} is missing.`);
  return value;
}

function number(value: unknown, name: string): number {
  if (!Number.isInteger(value)) throw new Error(`${name} is missing.`);
  return value as number;
}
