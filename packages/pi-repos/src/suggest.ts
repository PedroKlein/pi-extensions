/**
 * pi-repos — AI-suggested connections.
 *
 * Reads TL;DRs of all group members and uses LLM to suggest
 * directional relationships between them.
 */
import { spawn } from "node:child_process";
import type { ReposConfig, Connection, ConnectionSuggestion } from "./types.js";
import { loadIndex, resolveRepo, repoId, repoMetaDir, readSummary } from "./storage.js";
import { getGroupInfo } from "./group.js";

// ─── Prompt ──────────────────────────────────────────────────────────────────

function buildSuggestionPrompt(
  groupName: string,
  groupDescription: string,
  members: Array<{ id: string; tldr: string }>,
  existingConnections: Connection[],
): string {
  const memberBlock = members.map(m =>
    `### ${m.id}\n${m.tldr || "_No summary available._"}`
  ).join("\n\n");

  const existingBlock = existingConnections.length > 0
    ? existingConnections.map(c =>
        `- ${c.from} --[${c.relationship}]--> ${c.to}${c.description ? ` (${c.description})` : ""}`
      ).join("\n")
    : "_None yet._";

  return `You are analyzing a group of related repositories to identify how they connect.

## Group: ${groupName}
${groupDescription || "_No description._"}

## Members

${memberBlock}

## Existing Connections (do NOT re-suggest these)

${existingBlock}

## Task

Suggest directional connections between these repositories. For each suggestion provide:
- **from**: source repo ID (exact match from members list)
- **to**: target repo ID (exact match from members list)
- **relationship**: one of: deploys-to, depends-on, configures, shared-lib, imports, consumes
- **description**: brief explanation of the relationship (one sentence)
- **confidence**: high, medium, or low

Relationship semantics:
- **deploys-to**: A's output is deployed into/onto B (artifacts flow from A to B's runtime)
- **depends-on**: A imports packages or calls APIs provided by B at build/runtime
- **configures**: A provides configuration/settings that B reads and acts upon
- **shared-lib**: A and B share code via a common library (both import from it)
- **imports**: A imports modules/packages from B directly
- **consumes**: A consumes CRDs, events, schemas, or artifacts defined/produced by B

**CRITICAL RULES:**
- A connection means ACTUAL code/data/artifact flow between repos — NOT just similar patterns.
- Repos in the same group may have NO connections between them. Group membership ≠ connection.
- Using the same *type* of tool (e.g., both use Crossplane) is NOT a connection.
- "depends-on" requires an actual import or API call, not just similar config patterns.
- "consumes" requires one repo explicitly referencing types/schemas/artifacts DEFINED by the other.
- If repos are different generations/versions of the same system (V1 and V2), they do NOT connect.
- When in doubt, do NOT suggest the connection. Fewer correct suggestions > many wrong ones.

Only suggest connections you are reasonably confident about based on the TL;DRs.
Do NOT suggest self-connections or duplicate existing ones.

Output ONLY valid JSON array of objects with fields: from, to, relationship, description, confidence.
No markdown fencing, no preamble.`;
}

// ─── LLM Call ────────────────────────────────────────────────────────────────

async function runPiPrint(model: string | undefined, prompt: string): Promise<string | null> {
  const args = [
    "--print",
    "--no-extensions",
    "--system-prompt", "You are a code architecture analyst. Output only valid JSON.",
  ];
  if (model) {
    args.push("--model", model);
  }
  args.push(prompt);

  return new Promise(resolve => {
    let out = "";
    let resolved = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("pi", args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(null);
      return;
    }

    const done = (result: string | null) => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };

    child.stdout!.on("data", (d: Buffer) => { out += d.toString(); });
    child.on("close", code => done(code === 0 && out.trim().length > 0 ? out.trim() : null));
    child.on("error", () => done(null));

    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      done(null);
    }, 120_000);

    child.on("close", () => clearTimeout(timer));
  });
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Suggest connections for a group based on member TL;DRs.
 * Returns an array of suggestions (not persisted — caller must confirm and apply).
 */
export async function suggestConnections(
  config: ReposConfig,
  groupName: string,
): Promise<ConnectionSuggestion[]> {
  const group = getGroupInfo(config, groupName);
  const index = loadIndex(config);

  // Build member TL;DR context
  const members: Array<{ id: string; tldr: string }> = [];
  for (const memberId of group.repos) {
    let tldr = "";
    try {
      const entry = resolveRepo(index, memberId);
      const metaDir = repoMetaDir(config, entry);
      const summary = readSummary(metaDir);
      if (summary?.tldr) tldr = summary.tldr;
    } catch { /* skip */ }
    members.push({ id: memberId, tldr });
  }

  if (members.length < 2) {
    return []; // Can't have connections with fewer than 2 members
  }

  const prompt = buildSuggestionPrompt(
    group.name,
    group.description,
    members,
    group.connections,
  );

  const raw = await runPiPrint(config.summaryModel, prompt);
  if (!raw) return [];

  // Parse JSON response (handle possible markdown code fencing)
  let jsonStr = raw.trim();
  if (jsonStr.startsWith("```")) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  try {
    const suggestions = JSON.parse(jsonStr) as ConnectionSuggestion[];
    if (!Array.isArray(suggestions)) return [];

    // Validate and filter
    const validRelationships = new Set([
      "deploys-to", "depends-on", "configures", "shared-lib", "imports", "consumes",
    ]);
    const memberIds = new Set(group.repos);
    const existingKey = new Set(
      group.connections.map(c => `${c.from}|${c.to}|${c.relationship}`),
    );

    return suggestions.filter(s => {
      if (!s.from || !s.to || !s.relationship) return false;
      if (s.from === s.to) return false;
      if (!memberIds.has(s.from) || !memberIds.has(s.to)) return false;
      if (!validRelationships.has(s.relationship)) return false;
      if (existingKey.has(`${s.from}|${s.to}|${s.relationship}`)) return false;
      return true;
    });
  } catch {
    return [];
  }
}
