import { describe, it, expect } from "vitest";
import { validateReadonlyBash } from "../../src/bash-policy.js";

describe("validateReadonlyBash", () => {
  // ─── Allowed: basic inspection commands ────────────────────────────────

  describe("allowed commands", () => {
    it("allows ls", () => {
      expect(validateReadonlyBash("ls")).toEqual({ allowed: true });
    });

    it("allows ls with flags", () => {
      expect(validateReadonlyBash("ls -la /tmp")).toEqual({ allowed: true });
    });

    it("allows cat", () => {
      expect(validateReadonlyBash("cat file.txt")).toEqual({ allowed: true });
    });

    it("allows grep", () => {
      expect(validateReadonlyBash("grep pattern file.txt")).toEqual({ allowed: true });
    });

    it("allows find", () => {
      expect(validateReadonlyBash("find . -name '*.ts'")).toEqual({ allowed: true });
    });

    it("allows git status", () => {
      expect(validateReadonlyBash("git status")).toEqual({ allowed: true });
    });

    it("allows git log", () => {
      expect(validateReadonlyBash("git log --oneline -10")).toEqual({ allowed: true });
    });

    it("allows git diff", () => {
      expect(validateReadonlyBash("git diff HEAD~1")).toEqual({ allowed: true });
    });

    it("allows git branch -a", () => {
      expect(validateReadonlyBash("git branch -a")).toEqual({ allowed: true });
    });

    it("allows npm test", () => {
      expect(validateReadonlyBash("npm test")).toEqual({ allowed: true });
    });

    it("allows npm run build", () => {
      expect(validateReadonlyBash("npm run build")).toEqual({ allowed: true });
    });

    it("allows go test", () => {
      expect(validateReadonlyBash("go test ./...")).toEqual({ allowed: true });
    });

    it("allows go build", () => {
      expect(validateReadonlyBash("go build ./...")).toEqual({ allowed: true });
    });

    it("allows cargo test", () => {
      expect(validateReadonlyBash("cargo test")).toEqual({ allowed: true });
    });

    it("allows curl GET", () => {
      expect(validateReadonlyBash("curl https://example.com")).toEqual({ allowed: true });
    });

    it("allows wc", () => {
      expect(validateReadonlyBash("wc -l file.txt")).toEqual({ allowed: true });
    });

    it("allows head/tail", () => {
      expect(validateReadonlyBash("head -n 20 file.txt")).toEqual({ allowed: true });
      expect(validateReadonlyBash("tail -n 20 file.txt")).toEqual({ allowed: true });
    });
  });

  // ─── Allowed: pipes between safe commands ──────────────────────────────

  describe("allowed pipes", () => {
    it("allows grep piped to wc", () => {
      expect(validateReadonlyBash("grep -r pattern . | wc -l")).toEqual({ allowed: true });
    });

    it("allows ls piped to grep", () => {
      expect(validateReadonlyBash("ls -la | grep '.ts'")).toEqual({ allowed: true });
    });

    it("allows cat piped to grep", () => {
      expect(validateReadonlyBash("cat file.txt | grep error")).toEqual({ allowed: true });
    });
  });

  // ─── Blocked: destructive filesystem ───────────────────────────────────

  describe("blocked: destructive filesystem commands", () => {
    it("blocks rm", () => {
      const result = validateReadonlyBash("rm -rf /");
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/blocked/i);
    });

    it("blocks mv", () => {
      const result = validateReadonlyBash("mv a b");
      expect(result.allowed).toBe(false);
    });

    it("blocks cp", () => {
      const result = validateReadonlyBash("cp src dst");
      expect(result.allowed).toBe(false);
    });

    it("blocks mkdir", () => {
      const result = validateReadonlyBash("mkdir /tmp/newdir");
      expect(result.allowed).toBe(false);
    });

    it("blocks chmod", () => {
      const result = validateReadonlyBash("chmod 755 file");
      expect(result.allowed).toBe(false);
    });

    it("blocks touch", () => {
      const result = validateReadonlyBash("touch newfile.txt");
      expect(result.allowed).toBe(false);
    });
  });

  // ─── Blocked: output redirects ─────────────────────────────────────────

  describe("blocked: output redirects", () => {
    it("blocks write redirect >", () => {
      const result = validateReadonlyBash("echo hello > file.txt");
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/redirection/i);
    });

    it("blocks append redirect >>", () => {
      const result = validateReadonlyBash("echo hello >> file.txt");
      expect(result.allowed).toBe(false);
    });

    it("allows 2>/dev/null", () => {
      // stderr redirect to /dev/null is explicitly permitted
      expect(validateReadonlyBash("ls nonexistent 2>/dev/null")).toEqual({ allowed: true });
    });

    it("allows 2>&1", () => {
      expect(validateReadonlyBash("cat file.txt 2>&1")).toEqual({ allowed: true });
    });
  });

  // ─── Blocked: command substitution ────────────────────────────────────

  describe("blocked: command substitution", () => {
    it("blocks $(...)", () => {
      const result = validateReadonlyBash("echo $(whoami)");
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/command substitution/i);
    });

    it("blocks backticks", () => {
      const result = validateReadonlyBash("echo `whoami`");
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/backtick/i);
    });
  });

  // ─── Blocked: shell wrappers and eval ──────────────────────────────────

  describe("blocked: shell wrappers and eval", () => {
    it("blocks bash -c", () => {
      const result = validateReadonlyBash("bash -c 'rm -rf /'");
      expect(result.allowed).toBe(false);
    });

    it("blocks sh -c", () => {
      const result = validateReadonlyBash("sh -c 'echo test'");
      expect(result.allowed).toBe(false);
    });

    it("blocks eval", () => {
      const result = validateReadonlyBash("eval 'ls'");
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/eval/i);
    });
  });

  // ─── Blocked: git mutating subcommands ─────────────────────────────────

  describe("blocked: git mutating subcommands", () => {
    it("blocks git commit", () => {
      const result = validateReadonlyBash("git commit -m 'msg'");
      expect(result.allowed).toBe(false);
    });

    it("blocks git push", () => {
      const result = validateReadonlyBash("git push origin main");
      expect(result.allowed).toBe(false);
    });

    it("blocks git checkout", () => {
      const result = validateReadonlyBash("git checkout main");
      expect(result.allowed).toBe(false);
    });

    it("blocks git branch <name> (creates branch)", () => {
      const result = validateReadonlyBash("git branch new-feature");
      expect(result.allowed).toBe(false);
    });
  });

  // ─── Blocked: package manager installs ────────────────────────────────

  describe("blocked: package manager install subcommands", () => {
    it("blocks npm install", () => {
      const result = validateReadonlyBash("npm install lodash");
      expect(result.allowed).toBe(false);
    });

    it("blocks pnpm install", () => {
      const result = validateReadonlyBash("pnpm install");
      expect(result.allowed).toBe(false);
    });

    it("blocks pip install", () => {
      const result = validateReadonlyBash("pip install requests");
      expect(result.allowed).toBe(false);
    });

    it("blocks brew install", () => {
      const result = validateReadonlyBash("brew install ripgrep");
      expect(result.allowed).toBe(false);
    });
  });

  // ─── Edge cases ────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("blocks empty command", () => {
      const result = validateReadonlyBash("");
      expect(result.allowed).toBe(false);
    });

    it("blocks tee", () => {
      const result = validateReadonlyBash("cat file.txt | tee copy.txt");
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/tee/i);
    });

    it("blocks xargs", () => {
      const result = validateReadonlyBash("find . -name '*.ts' | xargs cat");
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/xargs/i);
    });

    it("blocks find -delete", () => {
      const result = validateReadonlyBash("find . -name '*.tmp' -delete");
      expect(result.allowed).toBe(false);
    });

    it("blocks find -exec rm", () => {
      const result = validateReadonlyBash("find . -name '*.tmp' -exec rm {} ;");
      expect(result.allowed).toBe(false);
    });

    it("allows find -exec cat", () => {
      expect(validateReadonlyBash("find . -name '*.ts' -exec cat {} ;")).toEqual({ allowed: true });
    });

    it("blocks curl with POST data", () => {
      const result = validateReadonlyBash("curl -d '{\"key\":\"val\"}' https://api.example.com");
      expect(result.allowed).toBe(false);
    });

    it("blocks npx", () => {
      const result = validateReadonlyBash("npx some-tool");
      expect(result.allowed).toBe(false);
    });

    it("blocks sed", () => {
      const result = validateReadonlyBash("sed 's/foo/bar/' file.txt");
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/sed/i);
    });

    it("allows --help on denied top-level commands", () => {
      // top-level denied commands (rm, chmod, etc.) are bypassed by --help
      expect(validateReadonlyBash("rm --help")).toEqual({ allowed: true });
    });

    it("subcommand policies take priority over --help", () => {
      // git commit is blocked at the subcommand level before --help is checked
      const result = validateReadonlyBash("git commit --help");
      expect(result.allowed).toBe(false);
    });
  });
});
