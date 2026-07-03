/**
 * Pin persistence — saves/loads pinned notes to ~/.pi/adhd/.
 *
 * Storage layout:
 *   ~/.pi/adhd/
 *     <org-repo>.json   → project-pinned notes
 *     global.json       → globally-pinned notes
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import type { Note, PinScope } from "./model.js";

const ADHD_ROOT = join(homedir(), ".pi", "adhd");

interface PinnedState {
  notes: Note[];
  version: number;
}

/** Resolve repo slug from git remote (same pattern as pi-todo) */
export function resolveRepoSlug(cwd: string): string {
  try {
    const remote = execSync("git remote get-url origin", { cwd, encoding: "utf-8" }).trim();
    const slug = parseRemoteToSlug(remote);
    if (slug) return slug;
  } catch {
    // No git remote
  }

  // Fallback: git root directory name
  try {
    const root = execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf-8" }).trim();
    const parts = root.split("/");
    return parts[parts.length - 1] ?? "global";
  } catch {
    // Not a git repo at all
  }

  return "global";
}

function parseRemoteToSlug(remoteUrl: string): string | null {
  // SSH: git@github.com:org/repo.git
  const sshMatch = remoteUrl.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) return `${sshMatch[1]}-${sshMatch[2]}`;

  // HTTPS: https://github.com/org/repo.git
  const httpsMatch = remoteUrl.match(/\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (httpsMatch) return `${httpsMatch[1]}-${httpsMatch[2]}`;

  return null;
}

function getFilePath(scope: PinScope, repoSlug: string): string {
  if (scope === "global") return join(ADHD_ROOT, "global.json");
  return join(ADHD_ROOT, `${repoSlug}.json`);
}

function readPinnedFile(filePath: string): Note[] {
  if (!existsSync(filePath)) return [];
  try {
    const raw = readFileSync(filePath, "utf-8");
    const state: PinnedState = JSON.parse(raw);
    return state.notes ?? [];
  } catch {
    return [];
  }
}

function writePinnedFile(filePath: string, notes: Note[]): void {
  mkdirSync(ADHD_ROOT, { recursive: true });
  const state: PinnedState = { notes, version: 1 };
  writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
}

/** Load all pinned notes (project + global) */
export function loadPinned(repoSlug: string): Note[] {
  const projectNotes = readPinnedFile(getFilePath("project", repoSlug));
  const globalNotes = readPinnedFile(getFilePath("global", repoSlug));
  return [...projectNotes, ...globalNotes];
}

/** Save a single note as pinned */
export function savePinned(note: Note, scope: PinScope, repoSlug: string): void {
  const filePath = getFilePath(scope, repoSlug);
  const existing = readPinnedFile(filePath);
  // Remove existing with same ID if re-pinning
  const filtered = existing.filter((n) => n.id !== note.id);
  filtered.push(note);
  writePinnedFile(filePath, filtered);
}

/** Remove a pinned note from persistence */
export function removePinned(noteId: string, scope: PinScope, repoSlug: string): void {
  const filePath = getFilePath(scope, repoSlug);
  const existing = readPinnedFile(filePath);
  const filtered = existing.filter((n) => n.id !== noteId);
  writePinnedFile(filePath, filtered);
}
