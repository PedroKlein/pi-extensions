import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeSSH {
  command: string;
  sudoPassword: string;
  arguments(): Promise<string[][]>;
  commands(): Promise<string>;
  sudoArguments(): Promise<Array<{ host: string; args: string[] }>>;
  expireSudo(host: string): Promise<void>;
  exits(): Promise<string[]>;
  cleanup(): Promise<void>;
}

export async function installFakeSSH(): Promise<FakeSSH> {
  const directory = await mkdtemp(join(tmpdir(), "pi-ssh-session-test-"));
  const executable = join(directory, "ssh");
  const argumentsLog = join(directory, "arguments.jsonl");
  const commandLog = join(directory, "commands.log");
  const bashEnvironment = join(directory, "bash-env");
  const sudoArgumentsLog = join(directory, "sudo-arguments.jsonl");
  const sudoPassword = `adversarial space-'\"-$()-\\-${randomUUID()}`;
  const sudoExecutable = join(directory, "sudo");
  const sudoStateDirectory = join(directory, "sudo-state");
  const exitLog = join(directory, "exits.log");

  await writeFile(bashEnvironment, `trap 'printf "%s\\n" "$BASH_COMMAND" >> "$PI_SSH_COMMAND_LOG"' DEBUG
if [[ "$PI_SSH_FAKE_HOST" == "transfer-timeout" ]]; then
  base64() { while :; do :; done; }
elif [[ "$PI_SSH_FAKE_HOST" == "transfer-failure" ]]; then
  base64() { printf "fake base64 failure\\n" >&2; return 42; }
elif [[ "$PI_SSH_FAKE_HOST" == "transfer-invalid" ]]; then
  base64() { printf "not-base64!\\n"; }
fi
`);
  await writeFile(
    executable,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { spawn } = require("node:child_process");

const args = process.argv.slice(2);
const host = args.at(-3);
appendFileSync(${JSON.stringify(argumentsLog)}, JSON.stringify(args) + "\\n");

if (host === "stderr-host") {
  process.stderr.write("Permission denied (publickey).\\n");
  process.exit(255);
}
if (host === "slow-connect") {
  process.on("SIGTERM", () => {
    appendFileSync(${JSON.stringify(exitLog)}, host + "\\n");
    process.exit(0);
  });
  setInterval(() => {}, 1000);
} else {
  const env = {
    ...process.env,
    PI_SSH_COMMAND_LOG: ${JSON.stringify(commandLog)},
    PI_SSH_FAKE_HOST: host,
  };
  if (host.startsWith("sudo-") || host.startsWith("transfer-")) env.BASH_ENV = ${JSON.stringify(bashEnvironment)};
  const shell = spawn("bash", ["--noprofile", "--norc"], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  process.stdin.pipe(shell.stdin);
  shell.stdout.pipe(process.stdout);
  shell.stderr.pipe(process.stderr);
  const stop = () => {
    appendFileSync(${JSON.stringify(exitLog)}, host + "\\n");
    shell.kill();
  };
  process.on("SIGTERM", stop);
  shell.on("exit", (code) => process.exit(code ?? 0));
}
`,
  );
  await writeFile(
    sudoExecutable,
    `#!/usr/bin/env node
const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");

const args = process.argv.slice(2);
const host = process.env.PI_SSH_FAKE_HOST;
const state = join(${JSON.stringify(sudoStateDirectory)}, host);
mkdirSync(${JSON.stringify(sudoStateDirectory)}, { recursive: true });
appendFileSync(${JSON.stringify(sudoArgumentsLog)}, JSON.stringify({ host, args }) + "\\n");

if (args[0] === "-n" && args[1] === "true") {
  if (host === "sudo-cached" || existsSync(state)) process.exit(0);
  process.stderr.write("sudo: a password is required\\n");
  process.exit(1);
}

if (args.includes("-S") && args.includes("-v")) {
  if (host === "sudo-timeout") {
    process.on("SIGTERM", () => process.exit(143));
    setTimeout(() => process.exit(124), 2000);
  } else if (host === "sudo-drop") {
    process.kill(process.ppid, "SIGTERM");
    process.exit(1);
  } else {
    const password = readFileSync(0, "utf8").replace(/\\r?\\n$/, "");
    if (password !== ${JSON.stringify(sudoPassword)}) {
      process.stderr.write("Sorry, try again.\\n");
      process.exit(1);
    }
    writeFileSync(state, "valid");
    process.exit(0);
  }
} else {
  const command = [...args];
  if (command[0] === "-n") command.shift();
  if (command[0] === "--") command.shift();
  if (host !== "sudo-cached" && !existsSync(state)) {
    process.stderr.write("sudo: a password is required\\n");
    process.exit(1);
  }
  const result = spawnSync(command[0], command.slice(1), { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
`,
  );
  await Promise.all([chmod(executable, 0o755), chmod(sudoExecutable, 0o755)]);

  return {
    command: executable,
    sudoPassword,
    async arguments() {
      const contents = await readFile(argumentsLog, "utf8").catch(() => "");
      return contents.split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
    },
    async commands() {
      return readFile(commandLog, "utf8").catch(() => "");
    },
    async sudoArguments() {
      const contents = await readFile(sudoArgumentsLog, "utf8").catch(() => "");
      return contents.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { host: string; args: string[] });
    },
    async expireSudo(host: string) {
      await rm(join(sudoStateDirectory, host), { force: true });
    },
    async exits() {
      const contents = await readFile(exitLog, "utf8").catch(() => "");
      return contents.split("\n").filter(Boolean);
    },
    async cleanup() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export async function waitFor(read: () => Promise<string[]>, value: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if ((await read()).includes(value)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${value}`);
}
