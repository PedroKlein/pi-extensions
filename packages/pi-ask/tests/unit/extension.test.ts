import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piAsk from "../../src/index.js";

describe("pi-ask prompt placement", () => {
  it("keeps ask_user guidance on the tool and registers no prompt hook", () => {
    const tools: Array<{
      name: string;
      promptGuidelines?: string[];
    }> = [];
    const events: string[] = [];
    const pi = {
      registerTool: (tool: {
        name: string;
        promptGuidelines?: string[];
      }) => tools.push(tool),
      registerCommand: vi.fn(),
      on: (event: string) => events.push(event),
    } as unknown as ExtensionAPI;

    piAsk(pi);

    const askUser = tools.find((tool) => tool.name === "ask_user");
    expect(askUser?.promptGuidelines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("ALWAYS use ask_user"),
      ]),
    );
    expect(events).not.toContain("before_agent_start");
  });
});
