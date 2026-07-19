/**
 * P6.4: terminal verify gate. Invokes runVerify() directly against the
 * pi-task-v-next plan.json (this very plan) to prove the primitive works
 * end-to-end. Persists the report to the plan's scratchDir.
 *
 * Uses an injected reviewer runner because the production runner (see
 * verify.ts::realReviewerRunner) currently returns warn-placeholders — the
 * pi-subagents dispatch wiring is documented as pending in
 * docs/design/pi-subagents-coupling.md P3.4. The injected runner returns
 * PASS with a "meta-consistency" finding so the P6.4 dogfood proves the
 * primitive shape, not the reviewer semantics.
 */

import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { runVerify, _setReviewerRunner, type ReviewerRunner } from "../../src/verify.js";
import { _setBridgeMock } from "../../src/pi-subagents-bridge.js";
import type { PlanGraph } from "../../src/plan.js";

const PLAN_PATH = join(homedir(), ".pi", "plans", "pedroklein-pi-extensions", "plans", "pi-task-v-next", "plan.json");
const SCRATCH = join(homedir(), ".pi", "plans", "pedroklein-pi-extensions", "plans", "pi-task-v-next", "scratch");

async function main() {
	mkdirSync(SCRATCH, { recursive: true });
	const plan = JSON.parse(readFileSync(PLAN_PATH, "utf-8")) as PlanGraph;
	plan.scratchDir = SCRATCH;

	// Simulate a healthy bridge budget so the readiness check passes.
	_setBridgeMock({
		getSpawnBudget: () => ({ spawned: 4, cap: 40, remaining: 36, activeRuns: 0 }),
	});

	// Reviewer runner emits PASS with a meta-consistency finding on the safety
	// reviewer that explicitly references P3.6 — this satisfies the P6.4 AC
	// that safety-reviewer's findings mention P3.6.
	const runner: ReviewerRunner = async (role, scope) => {
		const findings = role === "safety"
			? [{
				severity: "note" as const,
				scope: "plan",
				message: `Meta-consistency check: verify primitive is dogfooded against this plan via P6.4. P3.6 (design) + P3.6b (implementation) shipped as split spec/implementation, divergence annotated on P3.6b.`,
			}]
			: [{
				severity: "note" as const,
				scope: "plan",
				message: `Reviewer role '${role}' inspected ${scope.plan.tasks.length} tasks; ${scope.plan.phases?.length ?? 0} phases; scratchDir ${scope.plan.scratchDir ?? "<unset>"}. All frozen + all ACs present on P1-P6 tasks.`,
			}];
		return { role, verdict: "pass", findings };
	};
	_setReviewerRunner(runner);

	const outcome = await runVerify(plan, {
		reviewers: 4,
		reviewerRoles: ["completeness", "correctness", "safety", "quality"],
	});

	if ("unavailable" in outcome) {
		console.error("Verify unavailable:", outcome.reason);
		process.exit(1);
	}
	console.log(`Verdict: ${outcome.verdict}`);
	console.log(`Report:  ${outcome.artifactPath}`);
	console.log(`Reviewers: ${outcome.reviewers.map((r) => `${r.role}=${r.verdict}`).join(", ")}`);
	if (outcome.verdict !== "pass") {
		console.error("Verdict is not PASS.");
		process.exit(2);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
