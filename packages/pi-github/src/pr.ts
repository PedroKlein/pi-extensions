import { parseCheck, parsePullRequest, parseReview, type Check, type PullRequest, type Review } from "./model.js";
import { quoteUntrusted } from "./output.js";

const MAX_ITEMS = 20;
const MAX_TEXT_BYTES = 8 * 1024;

export interface PullRequestSummary extends PullRequest {
  mergeable?: string;
  reviews: Review[];
  checks: Check[];
}

export function normalizePullRequest(value: unknown): PullRequestSummary {
  const record = object(value);
  const reviews = array(record.reviews).map((review) => {
    const item = object(review);
    return parseReview({
      id: item.id,
      author: object(item.author).login,
      state: item.state,
      body: boundedUntrusted(item.body),
      url: item.url,
    });
  });
  const checks = array(record.checks ?? record.statusCheckRollup).map((check, index) => {
    const item = object(check);
    return parseCheck({
      id: typeof item.id === "number" ? item.id : index + 1,
      name: item.name ?? item.context,
      status: item.status ?? (item.state === "PENDING" ? "in_progress" : "completed"),
      conclusion: item.conclusion ?? stateConclusion(item.state),
      headSha: record.headRefOid,
      url: item.url ?? item.detailsUrl ?? item.targetUrl ?? record.url,
    });
  });
  return {
    ...parsePullRequest({
      number: record.number,
      title: record.title,
      body: boundedUntrusted(record.body),
      state: record.state,
      url: record.url,
      draft: record.isDraft ?? record.draft,
      headSha: record.headRefOid ?? record.headSha,
      baseSha: record.baseRefOid ?? record.baseSha,
      headRepository: object(record.headRepository).nameWithOwner ?? record.headRepository,
    }),
    mergeable: typeof record.mergeable === "string" ? record.mergeable : undefined,
    reviews,
    checks,
  };
}

export function summarizePullRequests(values: unknown[]): {
  items: PullRequestSummary[];
  omittedItems: number;
} {
  return {
    items: values.slice(0, MAX_ITEMS).map(normalizePullRequest),
    omittedItems: Math.max(0, values.length - MAX_ITEMS),
  };
}

function boundedUntrusted(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("Pull request text must be a string.");
  let bounded = Buffer.from(value).subarray(0, MAX_TEXT_BYTES).toString("utf8");
  while (Buffer.byteLength(bounded) > MAX_TEXT_BYTES) bounded = bounded.slice(0, -1);
  return quoteUntrusted(bounded);
}

function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object.");
  return value as Record<string, any>;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stateConclusion(value: unknown): string | null {
  if (typeof value !== "string" || value === "PENDING") return null;
  return value === "SUCCESS" ? "success" : "failure";
}
