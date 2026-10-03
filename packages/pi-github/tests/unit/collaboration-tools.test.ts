import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerCollaborationTools, type CollaborationAuthority, type CollaborationSource } from "../../src/collaboration-tools.js";

const source: CollaborationSource = {
  listPullRequests: vi.fn(async () => []),
  getPullRequest: vi.fn(),
  listIssues: vi.fn(async () => []),
  getIssue: vi.fn(),
};

function tools(customSource: CollaborationSource = source, authority?: CollaborationAuthority) {
  const registered: any[] = [];
  const pi = { registerTool: (tool: any) => registered.push(tool) } as unknown as ExtensionAPI;
  registerCollaborationTools(pi, customSource, authority);
  return registered;
}

describe("GitHub collaboration tools", () => {
  it("registers PR and issue reads as deferred GitHub tools", () => {
    expect(tools().map((tool) => ({ name: tool.name, exposure: tool.exposure, namespace: tool.namespace }))).toEqual([
      {
        name: "github_pr",
        exposure: "deferred",
        namespace: expect.objectContaining({ name: "github" }),
      },
      {
        name: "github_issue",
        exposure: "deferred",
        namespace: expect.objectContaining({ name: "github" }),
      },
    ]);
  });

  it("returns bounded empty lists through the tools", async () => {
    const [pr, issue] = tools();
    const ctx = { cwd: "/repo" } as ExtensionContext;

    await expect(pr.execute("call", { action: "list" }, undefined, undefined, ctx)).resolves.toMatchObject({
      structuredContent: { items: [], omittedItems: 0 },
    });
    await expect(issue.execute("call", { action: "list" }, undefined, undefined, ctx)).resolves.toMatchObject({
      structuredContent: { items: [], omittedItems: 0 },
    });
  });

  it("requires exact confirmation for existing resources and rejects owned PR self-review", async () => {
    const mutatePullRequest = vi.fn(async (params) => ({ operation: params.action, repository: "org/repo", number: params.number }));
    const authorize = vi.fn(async () => undefined);
    const authority: CollaborationAuthority = {
      authorize,
      canCreate: () => true,
      isOwned: (kind, number) => kind === "pull-request" && number === 2,
      own: vi.fn(),
    };
    const [pr] = tools({ ...source, mutatePullRequest }, authority);
    const confirm = vi.fn(async () => true);
    const interactive = { hasUI: true, ui: { confirm } } as unknown as ExtensionContext;

    await pr.execute("call", { action: "comment", number: 3, body: "exact body" }, undefined, undefined, interactive);
    expect(authorize).toHaveBeenCalledWith("pull-request", 3);
    expect(confirm).toHaveBeenCalledWith("Mutate existing PR #3?", expect.stringContaining('"body": "exact body"'));
    await expect(pr.execute("call", { action: "review", number: 2, review: "approve", body: "approved" }, undefined, undefined, interactive)).rejects.toThrow("self-reviewed");
  });

  it("records autonomously created issues and rejects noninteractive existing issue writes", async () => {
    const own = vi.fn();
    const authorize = vi.fn(async () => undefined);
    const authority: CollaborationAuthority = { authorize, canCreate: () => true, isOwned: () => false, own };
    const mutateIssue = vi.fn(async () => ({ operation: "create", repository: "org/repo", number: 8, url: "https://example.test/issues/8" }));
    const [, issue] = tools({ ...source, mutateIssue }, authority);
    const noUi = { hasUI: false, ui: { confirm: vi.fn() } } as unknown as ExtensionContext;

    await issue.execute("call", { action: "create", title: "Bug", body: "Details" }, undefined, undefined, noUi);
    expect(authorize).toHaveBeenCalledWith("issue", undefined);
    expect(own).toHaveBeenCalledWith({ kind: "issue", repository: "org/repo", number: 8 });
    await expect(issue.execute("call", { action: "close", number: 4 }, undefined, undefined, noUi)).rejects.toThrow("interactive confirmation");
  });
});
