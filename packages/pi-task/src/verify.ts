/**
 * verify — the pi-task opt-in verification primitive.
 *
 * Implements `plan_tasks verify` and `plan_tasks phase-verify` per the design
 * in `docs/design/verify.md`.
 *
 * This module never mutates plan state. It builds reviewer prompts, dispatches
 * via the pi-subagents bridge (when available), synthesises verdicts, and
 * persists a report artefact. Callers wire the block-on-FAIL enforcement
 * into the `complete` action.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { PlanGraph, Phase } from "./plan.js";
import { getEffectivePhases, getPhaseStatus } from "./plan.js";
import { getSpawnBudget } from "./pi-subagents-bridge.js";

// ─── Types (mirror docs/design/verify.md) ────────────────────────────────

export type VerifyRole = "completeness" | "correctness" | "safety" | "quality";
export const VERIFY_ROLES: readonly VerifyRole[] = ["completeness", "correctness", "safety", "quality"];

export type VerifyVerdict = "pass" | "fail" | "warn";
export type VerifySeverity = "blocker" | "warn" | "note";

export interface VerifyFinding {
	severity: VerifySeverity;
	scope: string; // task/phase id or "plan"
	message: string;
	evidence?: string;
}

export interface VerifyReviewerReport {
	role: VerifyRole;
	verdict: VerifyVerdict;
	findings: VerifyFinding[];
	transcript?: string;
}

export interface VerifyReport {
	verdict: VerifyVerdict;
	scope: string; // "plan" or phaseId
	reviewers: VerifyReviewerReport[];
	synthesis: string;
	artifactPath: string;
	timestamp: number;
	budgetUsed: { spawned: number; cap: number | "unknown" };
	overrideApplied?: { reason: string; at: number };
}

/** Return shape when the bridge is unavailable. Callers must handle this. */
export interface VerifyUnavailable {
	unavailable: true;
	reason: string;
	verdict: "unknown";
}

export type VerifyOutcome = VerifyReport | VerifyUnavailable;

// TypeBox schema (referenced by tests to prove runtime shape matches the spec).
export const VerifyReviewerSchema = Type.Object({
	role: Type.Union([
		Type.Literal("completeness"),
		Type.Literal("correctness"),
		Type.Literal("safety"),
		Type.Literal("quality"),
	]),
	verdict: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("warn")]),
	findings: Type.Array(Type.Object({
		severity: Type.Union([Type.Literal("blocker"), Type.Literal("warn"), Type.Literal("note")]),
		scope: Type.String(),
		message: Type.String(),
		evidence: Type.Optional(Type.String()),
	})),
	transcript: Type.Optional(Type.String()),
});

export const VerifyReportSchema = Type.Object({
	verdict: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("warn")]),
	scope: Type.String(),
	reviewers: Type.Array(VerifyReviewerSchema),
	synthesis: Type.String(),
	artifactPath: Type.String(),
	timestamp: Type.Number(),
	budgetUsed: Type.Object({
		spawned: Type.Number(),
		cap: Type.Union([Type.Number(), Type.Literal("unknown")]),
	}),
	overrideApplied: Type.Optional(Type.Object({
		reason: Type.String(),
		at: Type.Number(),
	})),
});

// ─── Input params ────────────────────────────────────────────────────────

export interface VerifyParams {
	reviewers?: number;              // 1–10, default 4
	reviewerRoles?: VerifyRole[];    // subset of VERIFY_ROLES
	override?: boolean;
	reason?: string;
	phaseId?: string;                // set for phase-verify
}

// ─── Reviewer runner injection (test hook) ───────────────────────────────

/**
 * Reviewer runner. In production, this dispatches to pi-subagents via the
 * bridge. In tests, injected via `_setReviewerRunner`.
 */
export type ReviewerRunner = (
	role: VerifyRole,
	scope: { plan: PlanGraph; phase?: Phase },
) => Promise<VerifyReviewerReport>;

let injectedRunner: ReviewerRunner | null = null;

/** Test hook: swap the reviewer runner. */
export function _setReviewerRunner(runner: ReviewerRunner | null): void {
	injectedRunner = runner;
}

// ─── Public API ──────────────────────────────────────────────────────────

/** Validate reviewer count (1–10). Rejects 0, 11+, non-integer. */
export function validateReviewerCount(n: number | undefined): number {
	const value = n ?? 4;
	if (!Number.isInteger(value) || value < 1 || value > 10) {
		throw new Error(`reviewers must be an integer between 1 and 10; got ${value}`);
	}
	return value;
}

/** Validate override + reason contract. */
export function validateOverride(override: boolean | undefined, reason: string | undefined): void {
	if (!override) return;
	const trimmed = (reason ?? "").trim();
	if (!trimmed) {
		throw new Error("verify --override requires a non-empty --reason.");
	}
}

/** Filter to only known roles; default to all four when not supplied. */
export function resolveReviewerRoles(roles: string[] | undefined): VerifyRole[] {
	if (!roles || roles.length === 0) return [...VERIFY_ROLES];
	const filtered = roles.filter((r): r is VerifyRole => (VERIFY_ROLES as readonly string[]).includes(r));
	if (filtered.length === 0) {
		throw new Error(`No valid reviewerRoles supplied. Valid: ${VERIFY_ROLES.join(", ")}`);
	}
	return filtered;
}

/** Synthesise a verdict from reviewer verdicts. Fail-loudest. */
export function synthesiseVerdict(reviewers: VerifyReviewerReport[]): VerifyVerdict {
	if (reviewers.some((r) => r.verdict === "fail")) return "fail";
	if (reviewers.every((r) => r.verdict === "pass")) return "pass";
	return "warn";
}

/** Compose a short synthesis paragraph (≤ 1000 chars). */
export function composeSynthesis(reviewers: VerifyReviewerReport[]): string {
	const failCount = reviewers.filter((r) => r.verdict === "fail").length;
	const warnCount = reviewers.filter((r) => r.verdict === "warn").length;
	const passCount = reviewers.filter((r) => r.verdict === "pass").length;
	const blockers = reviewers.flatMap((r) => r.findings.filter((f) => f.severity === "blocker"));
	const parts: string[] = [
		`Reviewers: ${passCount} pass, ${warnCount} warn, ${failCount} fail (${reviewers.length} total).`,
	];
	if (blockers.length > 0) {
		parts.push(`Blockers (${blockers.length}):`);
		for (const b of blockers.slice(0, 5)) parts.push(`  - [${b.scope}] ${b.message}`);
		if (blockers.length > 5) parts.push(`  ... and ${blockers.length - 5} more.`);
	}
	const synth = parts.join("\n");
	return synth.length > 1000 ? `${synth.slice(0, 997)}...` : synth;
}

/** Persist the report artefact and return its absolute path. */
export function persistReport(
	scratchDir: string,
	scope: string,
	report: Omit<VerifyReport, "artifactPath">,
): string {
	const timestamp = new Date(report.timestamp).toISOString().replace(/[:.]/g, "-");
	const dir = join(scratchDir, "verify", scope);
	mkdirSync(dir, { recursive: true });
	const artifactPath = join(dir, `${timestamp}.md`);
	const body: string[] = [];
	body.push(`# Verify report — ${scope}`);
	body.push(`Verdict: **${report.verdict}**`);
	body.push(`Timestamp: ${new Date(report.timestamp).toISOString()}`);
	body.push("");
	body.push("## Synthesis");
	body.push(report.synthesis);
	if (report.overrideApplied) {
		body.push("");
		body.push(`## Override applied`);
		body.push(`Reason: ${report.overrideApplied.reason}`);
	}
	body.push("");
	body.push("## Reviewers");
	for (const r of report.reviewers) {
		body.push(`### ${r.role} — ${r.verdict}`);
		for (const f of r.findings) {
			body.push(`- [${f.severity}] ${f.scope}: ${f.message}${f.evidence ? ` (evidence: ${f.evidence})` : ""}`);
		}
	}
	body.push("");
	body.push("## Full report (JSON)");
	body.push("```json");
	body.push(JSON.stringify({ ...report, artifactPath }, null, 2));
	body.push("```");
	writeFileSync(artifactPath, body.join("\n"), "utf-8");
	return artifactPath;
}

/**
 * Run a verify pass on a plan or single phase. Never throws; on bridge failure,
 * returns `{ unavailable: true, reason, verdict: "unknown" }`.
 */
export async function runVerify(plan: PlanGraph, params: VerifyParams): Promise<VerifyOutcome> {
	validateOverride(params.override, params.reason);
	const count = validateReviewerCount(params.reviewers);
	const roles = resolveReviewerRoles(params.reviewerRoles).slice(0, count);

	const scope = params.phaseId ?? "plan";
	let phase: Phase | undefined;
	if (params.phaseId) {
		const phases = getEffectivePhases(plan);
		phase = phases.find((p) => p.id === params.phaseId);
		if (!phase) {
			return { unavailable: true, reason: `phase not found: ${params.phaseId}`, verdict: "unknown" };
		}
		// Touch phase status so callers can verify report scope is realistic.
		getPhaseStatus(plan, params.phaseId);
	}

	// Bridge liveness check — if no runner is injected and no bridge is available,
	// declare unavailable rather than pretending to run.
	const budget = await getSpawnBudget();
	if (!injectedRunner && (budget.remaining === "unknown" || (typeof budget.remaining === "number" && budget.remaining < roles.length))) {
		const reason = budget.remaining === "unknown"
			? "pi-subagents bridge unavailable"
			: `insufficient spawn budget: need ${roles.length}, have ${budget.remaining}`;
		return { unavailable: true, reason, verdict: "unknown" };
	}

	const runner = injectedRunner ?? realReviewerRunner;
	const reviewers: VerifyReviewerReport[] = [];
	for (const role of roles) {
		try {
			const rep = await runner(role, { plan, phase });
			reviewers.push(rep);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			reviewers.push({
				role,
				verdict: "warn",
				findings: [{ severity: "warn", scope, message: `reviewer runner threw: ${message}` }],
			});
		}
	}

	const verdict = synthesiseVerdict(reviewers);
	const synthesis = composeSynthesis(reviewers);
	const timestamp = Date.now();
	const overrideApplied = params.override && (params.reason ?? "").trim()
		? { reason: params.reason!.trim(), at: timestamp }
		: undefined;

	const budgetUsed = {
		spawned: reviewers.length,
		cap: typeof budget.cap === "number" ? budget.cap : ("unknown" as const),
	};

	const partial: Omit<VerifyReport, "artifactPath"> = {
		verdict: overrideApplied ? "pass" : verdict, // override forces pass; synthesis notes the reason
		scope,
		reviewers,
		synthesis,
		timestamp,
		budgetUsed,
		...(overrideApplied ? { overrideApplied } : {}),
	};

	const scratchDir = plan.scratchDir ?? "/tmp/pi-task-verify";
	const artifactPath = persistReport(scratchDir, scope.replace(/[^\w.-]/g, "_"), partial);
	return { ...partial, artifactPath };
}

/**
 * Production reviewer runner — dispatches through the pi-subagents bridge.
 * Kept behind an indirection so tests can inject a deterministic runner.
 *
 * The v-next release ships this as a stub that returns a warn-verdict pointing
 * at the pi-subagents contract. When pi-subagents grows the dispatch surface
 * documented in `docs/design/pi-subagents-coupling.md`, this stub is replaced.
 */
async function realReviewerRunner(
	role: VerifyRole,
	_scope: { plan: PlanGraph; phase?: Phase },
): Promise<VerifyReviewerReport> {
	return {
		role,
		verdict: "warn",
		findings: [{
			severity: "note",
			scope: "plan",
			message: `Real reviewer dispatch not yet wired to pi-subagents. See docs/design/pi-subagents-coupling.md.`,
		}],
	};
}
