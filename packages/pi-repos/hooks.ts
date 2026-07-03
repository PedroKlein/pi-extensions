/**
 * pi-repos — Hook system.
 *
 * Executes user-configured commands at lifecycle events (post-add, post-sync, pre-remove).
 * All hooks fire async (non-blocking). Failures are logged to hooks.log and emit a toast.
 *
 * Variables in args: {path}, {id}, {branch}, {host}, {owner}, {name}
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { HookEvent, HookEntry, ReposConfig } from "./types.js";
import { getPaths } from "./config.js";

export interface HookVariables {
  path: string;
  id: string;
  branch: string;
  host: string;
  owner: string;
  name: string;
}

/** Interpolate {var} placeholders in a string. */
function interpolate(template: string, vars: HookVariables): string {
  return template
    .replace(/\{path\}/g, vars.path)
    .replace(/\{id\}/g, vars.id)
    .replace(/\{branch\}/g, vars.branch)
    .replace(/\{host\}/g, vars.host)
    .replace(/\{owner\}/g, vars.owner)
    .replace(/\{name\}/g, vars.name);
}

/** Append a log line to hooks.log. */
function appendLog(config: ReposConfig, line: string): void {
  const logPath = join(getPaths(config).base, "hooks.log");
  try {
    mkdirSync(getPaths(config).base, { recursive: true });
    appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`, "utf-8");
  } catch { /* best-effort logging */ }
}

/**
 * Execute all hooks for a given event. Fire-and-forget — never blocks the caller.
 * Each hook spawns as a detached subprocess with a timeout.
 */
export function executeHooks(
  config: ReposConfig,
  event: HookEvent,
  vars: HookVariables,
  toast?: (msg: string) => void,
): void {
  const hooks = config.hooks?.[event];
  if (!hooks || hooks.length === 0) return;

  for (const hook of hooks) {
    runHook(config, event, hook, vars, toast);
  }
}

/** Run a single hook entry. */
function runHook(
  config: ReposConfig,
  event: HookEvent,
  hook: HookEntry,
  vars: HookVariables,
  toast?: (msg: string) => void,
): void {
  const args = hook.args.map(a => interpolate(a, vars));
  const timeout = hook.timeout ?? 180_000;
  const label = `${hook.command} ${args.join(" ")}`;

  appendLog(config, `[${event}] START: ${label}`);

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(hook.command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
  } catch (err: any) {
    appendLog(config, `[${event}] SPAWN_ERROR: ${label} — ${err.message}`);
    toast?.(`Hook failed: ${hook.command} (${event}) — spawn error`);
    return;
  }

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
  child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

  const timer = setTimeout(() => {
    try { child.kill("SIGKILL"); } catch {}
    appendLog(config, `[${event}] TIMEOUT: ${label} (${timeout}ms)`);
    toast?.(`Hook timed out: ${hook.command} (${event})`);
  }, timeout);

  child.on("close", (code) => {
    clearTimeout(timer);
    if (code === 0) {
      appendLog(config, `[${event}] OK: ${label}`);
    } else {
      const errSnippet = stderr.trim().slice(0, 200) || stdout.trim().slice(0, 200);
      appendLog(config, `[${event}] FAILED (exit ${code}): ${label} — ${errSnippet}`);
      toast?.(`Hook failed: ${hook.command} (${event}) — exit ${code}`);
    }
  });

  child.on("error", (err) => {
    clearTimeout(timer);
    appendLog(config, `[${event}] ERROR: ${label} — ${err.message}`);
    toast?.(`Hook error: ${hook.command} (${event}) — ${err.message}`);
  });
}
