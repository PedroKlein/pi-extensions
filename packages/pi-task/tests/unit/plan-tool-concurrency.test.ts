/**
 * P1.8 anchor test: every mutating case block in the plan_tasks tool handler
 * routes through `mutateActivePlan`. Prevents future regressions where a new
 * case block bypasses the mutex.
 *
 * Complements the primitive-level concurrency test in `plan-concurrency.test.ts`.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_SRC = readFileSync(join(HERE, "../../src/index.ts"), "utf-8");

/**
 * Slice out the code between a `case "X":` label and its matching closing
 * brace (roughly — this uses a simple depth counter on `{` `}` chars).
 */
function extractCaseBlock(action: string): string {
	const openMatch = INDEX_SRC.indexOf(`case "${action}":`);
	if (openMatch === -1) return "";
	// Find the first `{` after the label.
	const braceStart = INDEX_SRC.indexOf("{", openMatch);
	if (braceStart === -1) return "";

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

// Actions that must route through the mutex — every case that reads activePlan,
// derives a new graph, and persists.
const MUTATING_ACTIONS = [
	"add",
	"update",
	"start",
	"complete",
	"skip",
	"delete",
	"reorder",
	"update-subtask",
	"add-subtasks",
	"annotate",
	"freeze",
	"unfreeze",
	"add-criteria",
	"bulk-complete",
	"bulk-skip",
];

// Actions that legitimately do NOT use the mutex, with justification:
//   - create: makes a brand-new plan; no shared state to race against.
//   - status/get/diff/list-plans/switch-plan/archive/unarchive/delete-plan: reads
//     or plan-lifecycle operations that don't read-modify-write the active plan.
// If any of these change to mutate the active plan, they must migrate.

describe("mutex routing: every mutating case uses mutateActivePlan", () => {
	for (const action of MUTATING_ACTIONS) {
		it(`case "${action}" calls mutateActivePlan`, () => {
			const block = extractCaseBlock(action);
			expect(block).not.toBe("");
			expect(block).toContain("mutateActivePlan");
		});
	}

	it("no mutating case retains a direct `saveAndRefreshPlan(` call (only the helper + create do)", () => {
		// The tolerated call sites: (1) the definition of saveAndRefreshPlan itself,
		// (2) inside mutateActivePlan (the helper's own persistence), (3) inside
		// case "create" (new-plan bootstrap, no race possible).
		const calls = INDEX_SRC.split("\n").filter((line) => line.includes("saveAndRefreshPlan("));
		// Filter out the definition (async function saveAndRefreshPlan(...)).
		const callSites = calls.filter((l) => !l.includes("async function"));
		// Every remaining call must be inside either mutateActivePlan or the create
		// case. We check this by asserting the file has ≤ 2 non-definition calls.
		expect(callSites.length).toBeLessThanOrEqual(2);
	});
});

describe("mutateActivePlan helper contract", () => {
	it("mutateActivePlan wraps its body in withKeyedMutex", () => {
		const helperMatch = INDEX_SRC.match(/async function mutateActivePlan[\s\S]*?\n\t\}/);
		expect(helperMatch).not.toBeNull();
		expect(helperMatch![0]).toContain("withKeyedMutex");
	});

	it("mutateActivePlan runs validation before persisting", () => {
		const helperMatch = INDEX_SRC.match(/async function mutateActivePlan[\s\S]*?\n\t\}/);
		expect(helperMatch![0]).toContain("validatePlanGraph(mutated)");
		// Validation before save:
		const idxValidate = helperMatch![0].indexOf("validatePlanGraph(mutated)");
		const idxSave = helperMatch![0].indexOf("saveAndRefreshPlan(mutated)");
		expect(idxValidate).toBeGreaterThan(0);
		expect(idxSave).toBeGreaterThan(idxValidate);
	});
});
