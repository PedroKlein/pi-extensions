/**
 * Phase 3 wiring tests: verify the bridge is consumed correctly in status,
 * start, and reconcile case blocks. Uses source-anchor assertions rather than
 * end-to-end ExtensionAPI harnessing (see plan-tool-concurrency.test.ts for
 * the same pattern).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_SRC = readFileSync(join(HERE, "../../src/index.ts"), "utf-8");

function extractCaseBlock(action: string): string {
	const openMatch = INDEX_SRC.indexOf(`case "${action}":`);
	if (openMatch === -1) return "";
	const braceStart = INDEX_SRC.indexOf("{", openMatch);
	let depth = 1;
	let i = braceStart + 1;
	while (i < INDEX_SRC.length && depth > 0) {
		const ch = INDEX_SRC[i];
		if (ch === "{") depth++;
		else if (ch === "}") depth--;
		i++;
	}
	return INDEX_SRC.slice(braceStart, i);
}

// ─── P3.2: status surfaces budget line + pending completions ─────────────

describe("P3.2: status output uses the bridge", () => {
	const status = extractCaseBlock("status");

	it("status case calls getSpawnBudget and formatBudgetLine", () => {
		expect(status).toContain("getSpawnBudget()");
		expect(status).toContain("formatBudgetLine(budget)");
	});

	it("status includes the budget line in the rendered text", () => {
		// The rendered `parts` array includes budgetLine, so the returned text contains it.
		expect(status).toContain("budgetLine");
	});

	it("status surfaces pending completions when reconcile finds matches", () => {
		expect(status).toContain("scanTaggedArtifacts()");
		expect(status).toContain("Pending completions from subagent artifacts");
	});

	it("does NOT fabricate spawn numbers — no `~N` estimate strings in status/plan-widget rendering", () => {
		// Scoped to source files that render user-visible numbers.
		const searchIn = [
			readFileSync(join(HERE, "../../src/index.ts"), "utf-8"),
			readFileSync(join(HERE, "../../src/plan.ts"), "utf-8"),
		];
		for (const src of searchIn) {
			expect(src).not.toMatch(/~\d+\/\d+/); // e.g. "~37/40"
		}
	});
});

// ─── P3.3: executor enforcement on start ─────────────────────────────────

describe("P3.3: executor enforcement on start", () => {
	const startCase = extractCaseBlock("start");

	it("start resolves the task's executor via resolveTaskExecutor", () => {
		expect(startCase).toContain("resolveTaskExecutor(activePlan, task)");
	});

	it("start blocks with reason 'awaiting-user' when executor is 'user'", () => {
		expect(startCase).toContain('resolvedExecutor === "user"');
		expect(startCase).toContain('reason: "awaiting-user"');
	});

	it("start blocks with reason 'subagent-budget-exhausted' when subagent executor + 0 remaining", () => {
		expect(startCase).toContain('"subagent-fresh"');
		expect(startCase).toContain('"subagent-fork"');
		expect(startCase).toContain('reason: "subagent-budget-exhausted"');
	});

	it("block response carries machine-readable escalation options", () => {
		expect(startCase).toContain("annotate-and-downgrade-inline");
		expect(startCase).toContain("escalate-to-user");
	});

	it("start proceeds with a warn-annotation when probe is unavailable", () => {
		expect(startCase).toContain("warnBudgetProbeUnavailable");
		expect(startCase).toContain("Subagent budget probe unavailable");
	});

	it("start on inline/any executor is not gated by budget (no budget branch executes)", () => {
		// The budget-check block is guarded by (resolvedExecutor === "subagent-fresh" || "subagent-fork").
		expect(startCase).toContain('resolvedExecutor === "subagent-fresh" || resolvedExecutor === "subagent-fork"');
	});
});

// ─── P3.5: reconcile action ──────────────────────────────────────────────

describe("P3.5: reconcile action", () => {
	const reconcile = extractCaseBlock("reconcile");

	it("reconcile case exists in the switch", () => {
		expect(reconcile).not.toBe("");
	});

	it("reconcile scans tagged artifacts and filters by open tasks", () => {
		expect(reconcile).toContain("scanTaggedArtifacts()");
		expect(reconcile).toContain("openIds");
	});

	it("reconcile never auto-completes — the case block does not call setTaskStatus", () => {
		expect(reconcile).not.toContain("setTaskStatus");
		expect(reconcile).not.toContain("mutateActivePlan");
	});

	it("reconcile returns machine-readable `offers` in details", () => {
		expect(reconcile).toContain("details: { offers }");
	});
});

// ─── P3.5: action enum contains reconcile ────────────────────────────────

describe("P3.5: reconcile listed in action enum", () => {
	it("StringEnum for `action` includes 'reconcile'", () => {
		expect(INDEX_SRC).toContain('"reconcile"');
	});
});
