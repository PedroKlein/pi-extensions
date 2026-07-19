/**
 * P3.6b verify primitive tests. Covers:
 *   - runVerify happy path with an injected reviewer runner
 *   - reviewer count validation (1–10)
 *   - override + reason contract
 *   - unavailable path when bridge is disabled
 *   - opt-in guarantee: no auto-verify on phase completion
 *   - synthesis semantics (fail-loudest)
 *   - report persistence + timestamp
 *   - schema equality: runtime output matches the spec schema
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import {
	runVerify,
	validateReviewerCount,
	validateOverride,
	resolveReviewerRoles,
	synthesiseVerdict,
	VERIFY_ROLES,
	VerifyReportSchema,
	_setReviewerRunner,
	type ReviewerRunner,
	type VerifyReport,
	type VerifyReviewerReport,
} from "../../src/verify.js";
import {
	createPlanGraph,
	createPlanTask,
	resolveTaskStatuses,
	addPhase,
	setTaskStatus,
	type PlanGraph,
} from "../../src/plan.js";
import { _setBridgeMock, _resetProbeLogGateForTests } from "../../src/pi-subagents-bridge.js";

const SCRATCH = join(tmpdir(), `pi-task-verify-tests-${Date.now()}`);

function makePlan(): PlanGraph {
	const t1 = createPlanTask({ id: "T1", title: "one", description: "", order: 1 });
	const t2 = createPlanTask({ id: "T2", title: "two", description: "", order: 2 });
	return {
		...createPlanGraph({ name: "verify-fixture", tasks: resolveTaskStatuses([t1, t2]) }),
		scratchDir: SCRATCH,
	};
}

function passRunner(verdict: "pass" | "fail" | "warn"): ReviewerRunner {
	return async (role) => ({ role, verdict, findings: [] });
}

beforeEach(() => {
	_setBridgeMock(null);
	_setReviewerRunner(null);
	_resetProbeLogGateForTests();
});

afterEach(() => {
	if (existsSync(SCRATCH)) rmSync(SCRATCH, { recursive: true, force: true });
});

// ─── Reviewer count validation ───────────────────────────────────────────

describe("validateReviewerCount (1–10 boundary)", () => {
	it("defaults to 4 when undefined", () => {
		expect(validateReviewerCount(undefined)).toBe(4);
	});
	it("accepts 1", () => { expect(validateReviewerCount(1)).toBe(1); });
	it("accepts 10", () => { expect(validateReviewerCount(10)).toBe(10); });
	it("rejects 0", () => { expect(() => validateReviewerCount(0)).toThrow(/between 1 and 10/); });
	it("rejects 11", () => { expect(() => validateReviewerCount(11)).toThrow(/between 1 and 10/); });
	it("rejects non-integer", () => { expect(() => validateReviewerCount(4.5)).toThrow(/between 1 and 10/); });
});

// ─── Override contract ───────────────────────────────────────────────────

describe("validateOverride", () => {
	it("noop when override is false or undefined", () => {
		expect(() => validateOverride(undefined, undefined)).not.toThrow();
		expect(() => validateOverride(false, undefined)).not.toThrow();
	});
	it("rejects override:true with missing reason", () => {
		expect(() => validateOverride(true, undefined)).toThrow(/non-empty --reason/);
	});
	it("rejects override:true with whitespace-only reason", () => {
		expect(() => validateOverride(true, "   ")).toThrow(/non-empty/);
	});
	it("accepts override:true with real reason", () => {
		expect(() => validateOverride(true, "shipping under time pressure")).not.toThrow();
	});
});

// ─── Reviewer role resolution ────────────────────────────────────────────

describe("resolveReviewerRoles", () => {
	it("defaults to all four roles", () => {
		expect(resolveReviewerRoles(undefined)).toEqual([...VERIFY_ROLES]);
	});
	it("filters to a subset", () => {
		expect(resolveReviewerRoles(["completeness", "safety"])).toEqual(["completeness", "safety"]);
	});
	it("throws when all supplied roles are unknown", () => {
		expect(() => resolveReviewerRoles(["nonsense"])).toThrow(/No valid reviewerRoles/);
	});
});

// ─── Synthesis (fail-loudest) ────────────────────────────────────────────

describe("synthesiseVerdict", () => {
	const rr = (verdict: "pass" | "fail" | "warn"): VerifyReviewerReport => ({ role: "completeness", verdict, findings: [] });
	it("all pass → pass", () => { expect(synthesiseVerdict([rr("pass"), rr("pass")])).toBe("pass"); });
	it("any fail → fail", () => { expect(synthesiseVerdict([rr("pass"), rr("fail"), rr("warn")])).toBe("fail"); });
	it("mixed pass+warn → warn", () => { expect(synthesiseVerdict([rr("pass"), rr("warn")])).toBe("warn"); });
});

// ─── Happy path: runVerify with injected runner ──────────────────────────

describe("runVerify happy paths", () => {
	it("returns a full VerifyReport when all reviewers pass", async () => {
		_setBridgeMock({ getSpawnBudget: () => ({ spawned: 0, cap: 40, remaining: 40, activeRuns: 0 }) });
		_setReviewerRunner(passRunner("pass"));
		const plan = makePlan();
		const outcome = await runVerify(plan, {}) as VerifyReport;
		expect(outcome.verdict).toBe("pass");
		expect(outcome.reviewers).toHaveLength(4);
		expect(outcome.scope).toBe("plan");
		expect(outcome.artifactPath).toContain("verify/plan/");
		expect(existsSync(outcome.artifactPath)).toBe(true);
	});

	it("respects reviewers count parameter", async () => {
		_setBridgeMock({ getSpawnBudget: () => ({ spawned: 0, cap: 40, remaining: 40, activeRuns: 0 }) });
		_setReviewerRunner(passRunner("pass"));
		const outcome = await runVerify(makePlan(), { reviewers: 2 }) as VerifyReport;
		expect(outcome.reviewers).toHaveLength(2);
	});

	it("scopes to a phase when phaseId is set", async () => {
		_setBridgeMock({ getSpawnBudget: () => ({ spawned: 0, cap: 40, remaining: 40, activeRuns: 0 }) });
		_setReviewerRunner(passRunner("pass"));
		let plan = makePlan();
		plan = addPhase(plan, { id: "PA", title: "Phase A" });
		const outcome = await runVerify(plan, { phaseId: "PA" }) as VerifyReport;
		expect(outcome.scope).toBe("PA");
	});

	it("bad phaseId returns unavailable rather than throwing", async () => {
		_setBridgeMock({ getSpawnBudget: () => ({ spawned: 0, cap: 40, remaining: 40, activeRuns: 0 }) });
		_setReviewerRunner(passRunner("pass"));
		const outcome = await runVerify(makePlan(), { phaseId: "NOPE" });
		expect("unavailable" in outcome).toBe(true);
	});

	it("override:true forces verdict pass and records reason", async () => {
		_setBridgeMock({ getSpawnBudget: () => ({ spawned: 0, cap: 40, remaining: 40, activeRuns: 0 }) });
		_setReviewerRunner(passRunner("fail"));
		const outcome = await runVerify(makePlan(), { override: true, reason: "shipping" }) as VerifyReport;
		expect(outcome.verdict).toBe("pass");
		expect(outcome.overrideApplied).toEqual(expect.objectContaining({ reason: "shipping" }));
	});
});

// ─── Bridge-unavailable path ─────────────────────────────────────────────

describe("bridge-unavailable path", () => {
	it("returns {unavailable, reason} when bridge disabled and no runner injected", async () => {
		_setBridgeMock("disabled");
		_setReviewerRunner(null);
		const outcome = await runVerify(makePlan(), {});
		expect("unavailable" in outcome).toBe(true);
		if ("unavailable" in outcome) {
			expect(outcome.verdict).toBe("unknown");
			expect(outcome.reason).toMatch(/bridge unavailable|insufficient/);
		}
	});

	it("does not throw when bridge disabled", async () => {
		_setBridgeMock("disabled");
		await expect(runVerify(makePlan(), {})).resolves.toBeTruthy();
	});
});

// ─── Opt-in guarantee: phase completes without verify ────────────────────

describe("opt-in guarantee (P3.6b spec §Opt-In Guarantees)", () => {
	it("a phase whose tasks are all done becomes reportable as complete WITHOUT a verify call", () => {
		let plan = makePlan();
		plan = addPhase(plan, { id: "PA", title: "A" });
		plan = {
			...plan,
			tasks: plan.tasks.map((t) => ({ ...t, phaseId: "PA" })),
		};
		plan = setTaskStatus(plan, "T1", "done");
		plan = setTaskStatus(plan, "T2", "done");
		// No verify call. The phase-status report can be read directly and
		// reflects `done` counts without any block.
		const inPhase = plan.tasks.filter((t) => t.phaseId === "PA");
		expect(inPhase.every((t) => t.status === "done")).toBe(true);
	});
});

// ─── Schema equality: runtime report matches the spec schema ─────────────

describe("report schema equality (spec ↔ runtime)", () => {
	it("VerifyReportSchema.Check accepts a real report emitted by runVerify", async () => {
		_setBridgeMock({ getSpawnBudget: () => ({ spawned: 0, cap: 40, remaining: 40, activeRuns: 0 }) });
		_setReviewerRunner(passRunner("pass"));
		const outcome = await runVerify(makePlan(), {}) as VerifyReport;
		const ok = Value.Check(VerifyReportSchema, outcome);
		if (!ok) {
			// Surface diagnostics on failure.
			// eslint-disable-next-line no-console
			console.error("Errors:", [...Value.Errors(VerifyReportSchema, outcome)]);
		}
		expect(ok).toBe(true);
	});
});

// ─── Persistence & artifact contents ─────────────────────────────────────

describe("report persistence", () => {
	it("writes an ISO-timestamped file with verdict, synthesis, and JSON body", async () => {
		_setBridgeMock({ getSpawnBudget: () => ({ spawned: 0, cap: 40, remaining: 40, activeRuns: 0 }) });
		_setReviewerRunner(passRunner("pass"));
		const outcome = await runVerify(makePlan(), {}) as VerifyReport;
		expect(existsSync(outcome.artifactPath)).toBe(true);
		const body = readFileSync(outcome.artifactPath, "utf-8");
		expect(body).toContain("Verdict:");
		expect(body).toContain("Synthesis");
		expect(body).toContain("```json");
		expect(outcome.artifactPath).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
	});
});
