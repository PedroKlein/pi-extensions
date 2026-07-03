import { describe, it, expect } from "vitest";
import { BamlRuntime, ClientRegistry, Collector } from "@boundaryml/baml";

const PROXY_URL = process.env["PI_BAML_TEST_PROXY_URL"];

describe("executor against real BAML runtime", () => {
  it("compiles a simple function successfully", () => {
    const files = {
      "main.baml": `
function Greet(name: string) -> string {
  client "anthropic/claude-4.5-haiku"
  prompt #"Say hello to {{ name }} in one sentence."#
}`,
    };

    const runtime = BamlRuntime.fromFiles("/", files, {});
    expect(runtime).toBeDefined();

    const ctx = runtime.createContextManager();
    expect(ctx).toBeDefined();
  });

  it("rejects invalid BAML syntax with diagnostics", () => {
    const files = {
      "bad.baml": `function Bad(x: string) { prompt #""# }`,
    };

    expect(() => BamlRuntime.fromFiles("/", files, {})).toThrow();
  });

  it("compiles complex types correctly", () => {
    const files = {
      "main.baml": `
class Item {
  name string
  quantity int
  price float
  tags string[]
  metadata Item?
}

function ExtractItems(text: string) -> Item[] {
  client "anthropic/claude-4.5-haiku"
  prompt #"
    Extract items from: {{ text }}
    {{ ctx.output_format }}
  "#
}`,
    };

    const runtime = BamlRuntime.fromFiles("/", files, {});
    expect(runtime).toBeDefined();
  });

  // Only run actual LLM calls when proxy is available
  describe.skipIf(!PROXY_URL)("live LLM calls", () => {
    it("calls a simple function and gets a response", async () => {
      const files = {
        "main.baml": `
function Classify(text: string) -> "positive" | "negative" | "neutral" {
  client "anthropic/claude-4.5-haiku"
  prompt #"
    Classify the sentiment of: {{ text }}
    {{ ctx.output_format }}
  "#
}`,
      };

      const runtime = BamlRuntime.fromFiles("/", files, {});
      const ctx = runtime.createContextManager();

      const cr = new ClientRegistry();
      cr.addLlmClient("anthropic/claude-4.5-haiku", "anthropic", {
        model: "claude-4.5-haiku",
        api_key: "test", // Proxy handles auth
        base_url: PROXY_URL + "/anthropic",
      });
      cr.setPrimary("anthropic/claude-4.5-haiku");

      const collector = new Collector();
      const result = await runtime.callFunction(
        "Classify",
        { text: "I love this product!" },
        ctx,
        null,
        cr,
        [collector],
      );

      expect(result.isOk()).toBe(true);
      const parsed = result.parsed(false);
      expect(["positive", "negative", "neutral"]).toContain(parsed);
    });
  });
});
