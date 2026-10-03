export interface Annotation {
  path: string;
  message: string;
  level: "notice" | "warning" | "failure";
  startLine?: number;
  endLine?: number;
}

export interface Check {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  headSha: string;
  url: string;
}

export interface Issue {
  number: number;
  title: string;
  state: string;
  url: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
}

export interface PullRequest {
  number: number;
  title: string;
  state: string;
  url: string;
  headSha: string;
  baseSha: string;
  headRepository: string;
  body?: string;
  draft?: boolean;
}

export interface Review {
  id: number;
  author: string;
  state: string;
  body: string;
  url: string;
}

export interface OperationReceipt {
  operation: string;
  repository: string;
  actor: string;
  url: string;
  headSha?: string;
  number?: number;
}

export function parseAnnotation(value: unknown): Annotation {
  const record = object(value, "annotation");
  const level = string(record.level, "annotation.level");
  if (!["notice", "warning", "failure"].includes(level)) {
    throw new Error("annotation.level is invalid.");
  }
  return compact({
    path: string(record.path, "annotation.path"),
    message: string(record.message, "annotation.message"),
    level: level as Annotation["level"],
    startLine: optionalPositiveInteger(record.startLine, "annotation.startLine"),
    endLine: optionalPositiveInteger(record.endLine, "annotation.endLine"),
  });
}

export function parseCheck(value: unknown): Check {
  const record = object(value, "check");
  return {
    id: positiveInteger(record.id, "check.id"),
    name: string(record.name, "check.name"),
    status: string(record.status, "check.status"),
    conclusion: nullableString(record.conclusion, "check.conclusion"),
    headSha: sha(record.headSha, "check.headSha"),
    url: url(record.url, "check.url"),
  };
}

export function parseIssue(value: unknown): Issue {
  const record = object(value, "issue");
  return compact({
    number: positiveInteger(record.number, "issue.number"),
    title: string(record.title, "issue.title"),
    state: string(record.state, "issue.state"),
    url: url(record.url, "issue.url"),
    body: optionalString(record.body, "issue.body"),
    labels: optionalStrings(record.labels, "issue.labels"),
    assignees: optionalStrings(record.assignees, "issue.assignees"),
  });
}

export function parsePullRequest(value: unknown): PullRequest {
  const record = object(value, "pull request");
  return compact({
    number: positiveInteger(record.number, "pullRequest.number"),
    title: string(record.title, "pullRequest.title"),
    state: string(record.state, "pullRequest.state"),
    url: url(record.url, "pullRequest.url"),
    headSha: sha(record.headSha, "pullRequest.headSha"),
    baseSha: sha(record.baseSha, "pullRequest.baseSha"),
    headRepository: string(record.headRepository, "pullRequest.headRepository"),
    body: optionalString(record.body, "pullRequest.body"),
    draft: optionalBoolean(record.draft, "pullRequest.draft"),
  });
}

export function parseReview(value: unknown): Review {
  const record = object(value, "review");
  return {
    id: positiveInteger(record.id, "review.id"),
    author: string(record.author, "review.author"),
    state: string(record.state, "review.state"),
    body: string(record.body, "review.body", true),
    url: url(record.url, "review.url"),
  };
}

export function parseOperationReceipt(value: unknown): OperationReceipt {
  const record = object(value, "operation receipt");
  return compact({
    operation: string(record.operation, "receipt.operation"),
    repository: string(record.repository, "receipt.repository"),
    actor: string(record.actor, "receipt.actor"),
    url: url(record.url, "receipt.url"),
    headSha: record.headSha === undefined ? undefined : sha(record.headSha, "receipt.headSha"),
    number: optionalPositiveInteger(record.number, "receipt.number"),
  });
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new Error(`${name} must be a${allowEmpty ? "" : " non-empty"} string.`);
  }
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : string(value, name, true);
}

function nullableString(value: unknown, name: string): string | null {
  return value === null ? null : string(value, name);
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value as number;
}

function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  return value === undefined ? undefined : positiveInteger(value, name);
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean.`);
  return value;
}

function optionalStrings(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${name} must be an array.`);
  return value.map((item, index) => string(item, `${name}[${index}]`));
}

function sha(value: unknown, name: string): string {
  const result = string(value, name);
  if (!/^[0-9a-f]{40}$/i.test(result)) throw new Error(`${name} must be a full commit SHA.`);
  return result.toLowerCase();
}

function url(value: unknown, name: string): string {
  const result = string(value, name);
  try {
    const parsed = new URL(result);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error();
  } catch {
    throw new Error(`${name} must be an HTTP URL.`);
  }
  return result;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}
