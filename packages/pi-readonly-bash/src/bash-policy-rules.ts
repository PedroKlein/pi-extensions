/**
 * Declarative rules for readonly bash validation.
 *
 * This file contains only data — no logic. Easy to scan, extend, and diff.
 * Import from bash-policy.ts which contains the validation engine.
 *
 * APPROACH: Denylist. We list what's dangerous. Everything else is allowed.
 * The structural BLOCK_RULES (no redirects, no heredocs, no eval, etc.)
 * remain as the safety net against novel mutation vectors.
 */

// ─── Structural block rules (patterns that indicate mutation) ──────────────

interface Rule {
	pattern: RegExp;
	reason: string;
}

export const BLOCK_RULES: Rule[] = [
	{ pattern: /[\r\n]/, reason: "multiline commands are not allowed" },
	{ pattern: /<<[-]?\s*\w+/, reason: "heredoc is blocked" },
	{ pattern: /[<>]\(/, reason: "process substitution is blocked" },
	{ pattern: /`/, reason: "backticks are blocked" },
	{ pattern: /\$\(/, reason: "command substitution is blocked" },
	{ pattern: /\btee\b/, reason: "tee is blocked" },
	{ pattern: /\bxargs\b/, reason: "xargs is blocked" },
	{ pattern: /\beval\b/, reason: "eval is blocked" },
	{ pattern: /\bsed\b/, reason: "sed is blocked in readonly mode" },
	{ pattern: /\b(?:bash|sh|zsh|fish|ksh|dash)\s+-c\b/, reason: "shell wrapper with -c is blocked" },
	{ pattern: /\bsource\s+\S/, reason: "sourcing scripts is blocked" },
	{ pattern: /(^|[;&|]\s*)\.\s+[/~]/, reason: "sourcing scripts is blocked" },
];

// ─── Dangerous top-level commands (always blocked) ─────────────────────────
// These commands are inherently destructive or mutating — no safe readonly usage.

export const DENIED_COMMANDS = new Set([
	// Filesystem destruction / mutation
	"rm", "rmdir", "unlink", "shred", "srm",
	"mv", "rename",
	"cp", "rsync", "install", "scp",
	"mkdir",
	"touch", "truncate",
	"ln", "link", "symlink",
	"dd", "cpio",

	// File content mutation (sed already in BLOCK_RULES, but belt-and-suspenders)
	"sed", "awk", "gawk", "mawk", "nawk", "perl",
	"patch", "ed",

	// Permissions / ownership
	"chmod", "chown", "chgrp", "chattr", "setfacl", "umask",

	// Filesystem / disk
	"mkfs", "mkfs.ext4", "mkfs.xfs", "mkfs.btrfs", "mkfs.vfat",
	"mount", "umount", "fsck", "e2fsck",
	"fdisk", "gdisk", "parted", "sfdisk", "cfdisk",
	"lvm", "pvcreate", "vgcreate", "lvcreate",
	"mkswap", "swapon", "swapoff",
	"losetup", "cryptsetup",

	// Process / system control
	"kill", "killall", "pkill", "skill",
	"reboot", "shutdown", "halt", "poweroff", "init",
	"nohup", "disown",

	// User / group management
	"useradd", "userdel", "usermod", "groupadd", "groupdel", "groupmod",
	"passwd", "chpasswd", "newgrp",
	"adduser", "deluser", "addgroup", "delgroup",

	// Network mutation
	"iptables", "ip6tables", "nft", "nftables",
	"ifconfig", "ip", "route", "brctl",
	"nmcli", "networkctl",
	"ufw", "firewall-cmd",

	// Cron / scheduling
	"crontab", "at", "batch",

	// Container / VM (top-level; docker/podman have subcommand rules)
	"podman-compose", "docker-compose",
	"vagrant",
	"virsh", "virt-install",

	// Infrastructure / cloud CLI (terraform/pulumi have subcommand rules)
	"ansible", "ansible-playbook",
	"chef-client", "puppet",
	"salt", "salt-call",
	"cdktf",

	// Database clients (can mutate data)
	"mysql", "psql", "sqlite3", "mongosh", "mongo", "redis-cli",
	"cqlsh", "influx",

	// Dangerous utilities
	"nc", "ncat", "netcat", "socat",       // network I/O
	"expect", "screen", "tmux",             // interactive / session control
	"su", "sudo", "doas", "pkexec",         // privilege escalation
	"chroot", "unshare", "nsenter",         // namespace / isolation escape
	"strace", "ltrace", "ptrace",           // process tracing (can modify)
	"gdb", "lldb",                          // debuggers (can modify memory/state)
	"write", "wall", "mesg",                // messaging
	"logger",                               // syslog writing
	"tee",                                  // writes to files (also in BLOCK_RULES)
	"xargs",                                // executes arbitrary commands (also in BLOCK_RULES)

	// Compilers / linkers (always mutate: produce output files)
	"gcc", "g++", "cc", "c++", "clang", "clang++",
	"ld", "ar", "as", "strip", "objcopy",
	"rustc",
	"javac", "jar",
	"swift", "swiftc",
	"dotnet", "msbuild",
	"cmake", "ninja", "meson",
]);

// ─── Subcommand policies ───────────────────────────────────────────────────
// For commands with both safe and dangerous subcommands.
// Only denied subcommands are listed — everything else is allowed.

export interface SubcommandPolicy {
	denied: Set<string>;
	label: string;
}

// ─── Git ───────────────────────────────────────────────────────────────────

const DENIED_GIT_SUBCOMMANDS = new Set([
	"add", "commit", "merge", "rebase", "cherry-pick", "revert",
	"reset", "restore", "checkout", "switch",
	"stash",
	"am", "apply",
	"pull", "fetch", "push",
	"submodule", "subtree",
	"clean",
	"gc", "prune",
	"filter-branch", "filter-repo",
	"replace", "graft",
	"bisect",
	"init", "clone",
	"mv", "rm",
	"config",
	"lfs",
	"notes",
	"archive", "bundle", "format-patch",
	"maintenance",
	"sparse-checkout",
]);

// Git subcommands that need extra validation (not denied, but have conditions).
// Handled in bash-policy.ts validateGitSpecialCases().
export const GIT_SPECIAL_CASE_SUBCOMMANDS = new Set([
	"branch",       // readonly only with --list/-a/-r, no branch creation
	"remote",       // readonly only with -v/show
	"tag",          // readonly only with -l/--list
	"reflog",       // readonly only with show
	"hash-object",  // readonly only without -w
]);

// ─── Docker / Podman ───────────────────────────────────────────────────────

const DENIED_DOCKER_SUBCOMMANDS = new Set([
	// Container lifecycle
	"run", "create", "start", "stop", "restart", "kill", "rm", "remove",
	"pause", "unpause", "update", "rename", "wait",
	"attach", "exec", "commit",
	// Image mutation
	"build", "buildx", "push", "pull", "tag", "rmi", "image",
	"load", "save", "import",
	// Volume/network/system mutation
	"volume", "network", "system", "prune",
	// Compose / orchestration
	"compose",
	// Swarm / service
	"swarm", "service", "stack", "secret", "config", "node",
	// Other
	"context", "plugin", "trust", "manifest",
]);

// ─── Kubectl ───────────────────────────────────────────────────────────────

const DENIED_KUBECTL_SUBCOMMANDS = new Set([
	"create", "apply", "delete", "replace", "patch",
	"edit", "set",
	"scale", "autoscale", "rollout",
	"cordon", "uncordon", "drain", "taint", "certificate",
	"exec", "cp", "attach", "run", "expose", "debug",
	"port-forward", "proxy",
	"label", "annotate",
	"config",
]);

// ─── NPM / Yarn / PNPM / Bun ──────────────────────────────────────────────

const DENIED_NPM_SUBCOMMANDS = new Set([
	"install", "i", "add", "ci",
	"uninstall", "remove", "rm", "un",
	"update", "upgrade", "up",
	"publish", "unpublish", "deprecate",
	"link", "unlink",
	"init", "create",
	"exec", "x",
	// Allowed: "run", "run-script", "start", "stop", "test", "build",
	"rebuild",
	"cache", "pack",
	"set", "config",
	"login", "logout", "adduser",
	"owner", "access", "team",
	"token", "profile",
	"audit", "fund", "prune", "dedupe", "shrinkwrap",
	"version", "tag", "dist-tag",
]);

// ─── Cargo ─────────────────────────────────────────────────────────────────

const DENIED_CARGO_SUBCOMMANDS = new Set([
	// Allowed: "build", "b", "run", "r", "test", "t", "bench",
	"install", "uninstall",
	"new", "init", "add", "remove", "rm",
	"update", "publish", "package", "pack",
	"clean", "fix", "fetch",
	"generate-lockfile", "vendor", "yank",
	"login", "logout", "owner",
]);

// ─── Helm ──────────────────────────────────────────────────────────────────

const DENIED_HELM_SUBCOMMANDS = new Set([
	"install", "upgrade", "uninstall", "delete",
	"rollback", "create", "package", "push",
	"repo", "plugin", "dependency",
]);

// ─── Terraform / Tofu ──────────────────────────────────────────────────────

const DENIED_TERRAFORM_SUBCOMMANDS = new Set([
	"apply", "destroy",
	"import", "taint", "untaint",
	"init",       // downloads providers, modifies .terraform
	"workspace",  // can create/delete workspaces
	"push",
	"force-unlock",
	"login", "logout",
]);

// ─── Brew ──────────────────────────────────────────────────────────────────

const DENIED_BREW_SUBCOMMANDS = new Set([
	"install", "uninstall", "remove", "rm",
	"reinstall",
	"upgrade", "update",
	"link", "unlink", "relink",
	"pin", "unpin",
	"tap", "untap",
	"cleanup", "autoremove",
	"create", "edit",
	"postinstall",
	"services",
	"cask",  // cask install/uninstall
	"bundle",
]);

// ─── Pip / Pip3 ────────────────────────────────────────────────────────────

const DENIED_PIP_SUBCOMMANDS = new Set([
	"install", "uninstall",
	"download",
	"wheel",
	"cache",
	"config",
	"debug",
]);

// ─── Go ────────────────────────────────────────────────────────────────────

const DENIED_GO_SUBCOMMANDS = new Set([
	// Allowed: "build", "run", "test",
	"install",
	"get",        // modifies go.mod
	"mod",        // mod tidy/download/edit modify
	"generate",
	"clean",
	"fix",
	"work",       // workspace init/edit
]);

// ─── Systemctl ─────────────────────────────────────────────────────────────

const DENIED_SYSTEMCTL_SUBCOMMANDS = new Set([
	"start", "stop", "restart", "reload", "reload-or-restart",
	"enable", "disable", "reenable",
	"mask", "unmask",
	"isolate", "kill",
	"reset-failed",
	"set-property", "set-default",
	"edit",
	"add-wants", "add-requires",
	"daemon-reload", "daemon-reexec",
	"halt", "poweroff", "reboot", "kexec",
	"suspend", "hibernate", "hybrid-sleep",
	"rescue", "emergency",
	"link",
	"preset", "preset-all",
	"import-environment",
	"switch-root",
]);

// ─── Apt / Apt-get ─────────────────────────────────────────────────────────

const DENIED_APT_SUBCOMMANDS = new Set([
	"install", "remove", "purge", "autoremove",
	"update", "upgrade", "full-upgrade", "dist-upgrade",
	"build-dep",
	"source",
	"download",
	"clean", "autoclean",
	"mark",
	"edit-sources",
	"reinstall",
	"satisfy",
]);

// ─── Conda ─────────────────────────────────────────────────────────────────

const DENIED_CONDA_SUBCOMMANDS = new Set([
	"install", "remove", "uninstall",
	"update", "upgrade",
	"create",
	"clean",
	"build",
	"develop",
	"init",
	"activate", "deactivate",  // modify shell environment
	"run",
	"package",
]);

export const MAKE_READONLY_FLAGS = new Set([
	"-n", "--just-print", "--dry-run", "--recon",
	"-p", "--print-data-base",
	"-q", "--question",
	"--version",
	"--help",
	"-v", "--version",
]);

// ─── Tar ───────────────────────────────────────────────────────────────────

export const TAR_READONLY_FLAGS = new Set([
	"-t", "--list",
	"-tf",
	"--help", "--version",
]);

export const TAR_MUTATING_FLAGS = new Set([
	"-x", "--extract", "--get",
	"-c", "--create",
	"-r", "--append",
	"-u", "--update",
	"--delete",
]);

// ─── Curl / Wget ───────────────────────────────────────────────────────────
// curl is allowed for readonly GET requests but blocked for mutations.

export const CURL_MUTATING_FLAGS = new Set([
	"-X", "--request",       // custom method (could be POST/PUT/DELETE)
	"-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--data-ascii",
	"-F", "--form", "--form-string",
	"-T", "--upload-file",
	"-o", "--output",        // writes to file
	"-O", "--remote-name",   // writes to file
	"--create-dirs",
]);

export const WGET_MUTATING_FLAGS = new Set([
	"-O", "--output-document",
	"-P", "--directory-prefix",
	"--post-data", "--post-file",
	"--method",
	"--body-data", "--body-file",
	"-r", "--recursive",
	"-m", "--mirror",
	"-p", "--page-requisites",
	"-c", "--continue",
]);

// ─── Gem ───────────────────────────────────────────────────────────────────

const DENIED_GEM_SUBCOMMANDS = new Set([
	"install", "uninstall", "update",
	"build", "push", "yank",
	"cleanup", "pristine",
	"lock", "generate_index",
	"signin", "signout",
]);

// ─── Pulumi ────────────────────────────────────────────────────────────────

const DENIED_PULUMI_SUBCOMMANDS = new Set([
	"up", "update", "destroy", "cancel",
	"import",
	"new", "init",
	"refresh",
	"config",  // config set modifies
	"stack",   // stack init/rm/rename modify
	"login", "logout",
	"plugin",  // plugin install modifies
]);

// ─── npx (always blocked — executes arbitrary code) ────────────────────────

const DENIED_NPX_ALL = new Set(["*"]);

// ─── Assemble all subcommand policies ──────────────────────────────────────

export const SUBCOMMAND_POLICIES: Record<string, SubcommandPolicy> = {
	git:        { denied: DENIED_GIT_SUBCOMMANDS, label: "git" },
	docker:     { denied: DENIED_DOCKER_SUBCOMMANDS, label: "docker" },
	podman:     { denied: DENIED_DOCKER_SUBCOMMANDS, label: "podman" },
	kubectl:    { denied: DENIED_KUBECTL_SUBCOMMANDS, label: "kubectl" },
	npm:        { denied: DENIED_NPM_SUBCOMMANDS, label: "npm" },
	yarn:       { denied: DENIED_NPM_SUBCOMMANDS, label: "yarn" },
	pnpm:       { denied: DENIED_NPM_SUBCOMMANDS, label: "pnpm" },
	bun:        { denied: DENIED_NPM_SUBCOMMANDS, label: "bun" },
	npx:        { denied: DENIED_NPX_ALL, label: "npx" },
	cargo:      { denied: DENIED_CARGO_SUBCOMMANDS, label: "cargo" },
	helm:       { denied: DENIED_HELM_SUBCOMMANDS, label: "helm" },
	terraform:  { denied: DENIED_TERRAFORM_SUBCOMMANDS, label: "terraform" },
	tofu:       { denied: DENIED_TERRAFORM_SUBCOMMANDS, label: "tofu" },
	brew:       { denied: DENIED_BREW_SUBCOMMANDS, label: "brew" },
	pip:        { denied: DENIED_PIP_SUBCOMMANDS, label: "pip" },
	pip3:       { denied: DENIED_PIP_SUBCOMMANDS, label: "pip3" },
	go:         { denied: DENIED_GO_SUBCOMMANDS, label: "go" },
	systemctl:  { denied: DENIED_SYSTEMCTL_SUBCOMMANDS, label: "systemctl" },
	apt:        { denied: DENIED_APT_SUBCOMMANDS, label: "apt" },
	"apt-get":  { denied: DENIED_APT_SUBCOMMANDS, label: "apt-get" },
	conda:      { denied: DENIED_CONDA_SUBCOMMANDS, label: "conda" },
	gem:        { denied: DENIED_GEM_SUBCOMMANDS, label: "gem" },
	pulumi:     { denied: DENIED_PULUMI_SUBCOMMANDS, label: "pulumi" },
};

// ─── AWS CLI action-word matching ──────────────────────────────────────────
// AWS uses `aws <service> <action>` pattern. We match action prefixes.

export const DENIED_AWS_ACTIONS = new Set([
	"delete", "remove", "terminate", "destroy", "put", "create", "update",
	"modify", "start", "stop", "reboot", "invoke", "execute", "run",
	"deregister", "detach", "attach", "associate", "disassociate",
	"enable", "disable", "revoke", "authorize", "grant",
	"tag", "untag",
	"import", "export",
	"publish", "send", "push",
	"cancel", "abort",
	"restore", "copy", "move",
	"set", "reset", "configure",
	"register", "deregister",
	"accept", "reject",
	"release", "allocate",
	"apply", "deploy",
]);

// ─── gcloud action-word matching ───────────────────────────────────────────

export const DENIED_GCLOUD_ACTIONS = new Set([
	"create", "delete", "update", "patch", "add", "remove",
	"deploy", "undeploy",
	"start", "stop", "restart", "reset",
	"resize", "scale",
	"set", "unset",
	"apply", "rollback",
	"import", "export",
	"ssh", "scp",
	"connect",
]);

// ─── Special-case flags for commands with mixed safety ─────────────────────

export const DANGEROUS_FIND_ARGS = new Set(["-ok", "-okdir", "-delete"]);
export const YQ_INPLACE_FLAGS = new Set(["-i", "--inplace", "--in-place"]);
