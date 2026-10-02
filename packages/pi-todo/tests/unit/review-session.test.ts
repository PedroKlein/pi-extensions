import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const host = vi.hoisted(() => ({
  createSession: vi.fn(),
}));
const cloneDirs: string[] = [];

vi.mock("@earendil-works/pi-coding-agent", () => ({
  BorderedLoader: class {},
  SessionManager: { create: host.createSession },
}));

import { startCloneReviewSession } from "../../src/review.js";

const task = {
  id: 1,
  title: "Review change",
  status: "open" as const,
  type: "review" as const,
  priority: "medium" as const,
  repoId: "reviews",
  createdAt: 1,
  updatedAt: 1,
  url: "https://github.com/example/project/pull/42",
  prMeta: {
    title: "Change",
    author: "octocat",
    state: "open" as const,
    branch: "feature",
    host: "github.com",
    owner: "example",
    repo: "project",
    number: 42,
  },
};

describe("startCloneReviewSession", () => {
  afterEach(() => {
    host.createSession.mockReset();
    for (const dir of cloneDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("creates and switches to a session rooted in the cloned repository", async () => {
    const appendMessage = vi.fn();
    host.createSession.mockReturnValue({
      appendMessage,
      getSessionFile: () => "/sessions/review.jsonl",
    });
    const exec = vi.fn(async (command: string, args: string[]) => {
      if (command === "bash") return { code: 0, stdout: "diff", stderr: "", killed: false };
      return { code: 0, stdout: "", stderr: "", killed: false };
    });
    const pi = { exec } as unknown as ExtensionAPI;
    const switchSession = vi.fn().mockResolvedValue({ cancelled: false });
    const ctx = {
      sessionManager: { getSessionFile: () => "/sessions/parent.jsonl" },
      switchSession,
      ui: {
        notify: vi.fn(),
        custom: async (factory: any) => new Promise((resolve) => {
          factory({}, {}, {}, resolve);
        }),
      },
    } as unknown as ExtensionCommandContext;

    await startCloneReviewSession(task, pi, ctx);

    const cloneCall = exec.mock.calls.find((call) => call[0] === "git");
    const cloneDir = cloneCall?.[1].at(-1);
    if (cloneDir) cloneDirs.push(cloneDir);
    expect(host.createSession).toHaveBeenCalledWith(
      cloneDir,
      undefined,
      { parentSession: "/sessions/parent.jsonl" },
    );
    expect(appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: "user" }),
    );
    expect(switchSession).toHaveBeenCalledWith("/sessions/review.jsonl");
  });
});
