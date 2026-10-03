export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

export interface RemoteRepository {
  host: string;
  owner: string;
  name: string;
}

export interface RepositoryIdentity extends RemoteRepository {
  remote: string;
  defaultBranch: string;
  currentBranch: string;
  headSha: string;
  remoteTrackingSha?: string;
}

export function parseGitHubRemote(remote: string): RemoteRepository {
  const value = remote.trim();
  let host: string;
  let pathname: string;

  const scp = value.match(/^[^@\s]+@([^:\s]+):(.+)$/);
  if (scp) {
    host = scp[1];
    pathname = scp[2];
  } else {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`Unsupported GitHub remote: ${JSON.stringify(value)}.`);
    }
    if (!['http:', 'https:', 'ssh:'].includes(url.protocol)) {
      throw new Error(`Unsupported GitHub remote: ${JSON.stringify(value)}.`);
    }
    host = url.hostname;
    pathname = url.pathname.replace(/^\//, "");
  }

  const parts = pathname.replace(/\.git$/, "").split("/").filter(Boolean);
  if (!host || parts.length !== 2) {
    throw new Error(`Unsupported GitHub remote: ${JSON.stringify(value)}.`);
  }
  return { host, owner: parts[0], name: parts[1] };
}

export async function discoverRepository(
  run: CommandRunner,
  remote = "origin",
): Promise<RepositoryIdentity> {
  const remoteResult = await run("git", ["remote", "get-url", remote]);
  if (remoteResult.exitCode !== 0 || !remoteResult.stdout.trim()) {
    throw new Error(`Git remote ${JSON.stringify(remote)} is unavailable.`);
  }
  const repository = parseGitHubRemote(remoteResult.stdout);

  const branchResult = await run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branchResult.exitCode !== 0 || !branchResult.stdout.trim()) {
    throw new Error("Cannot operate from a detached HEAD.");
  }
  const currentBranch = branchResult.stdout.trim();

  const headResult = await run("git", ["rev-parse", "HEAD"]);
  const headSha = requireSha(headResult, "local HEAD");

  const trackingResult = await run("git", [
    "rev-parse",
    "--verify",
    `refs/remotes/${remote}/${currentBranch}`,
  ]);
  const remoteTrackingSha = trackingResult.exitCode === 0
    ? requireSha(trackingResult, "remote tracking branch")
    : undefined;

  const repoResult = await run("gh", [
    "api",
    "--hostname",
    repository.host,
    `repos/${repository.owner}/${repository.name}`,
    "--jq",
    ".default_branch",
  ]);
  if (repoResult.exitCode !== 0 || !repoResult.stdout.trim()) {
    throw new Error(`Cannot resolve the default branch for ${repository.owner}/${repository.name}.`);
  }

  return {
    ...repository,
    remote,
    defaultBranch: repoResult.stdout.trim(),
    currentBranch,
    headSha,
    remoteTrackingSha,
  };
}

function requireSha(result: CommandResult, subject: string): string {
  const sha = result.stdout.trim();
  if (result.exitCode !== 0 || !/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error(`Cannot resolve ${subject} to a full commit SHA.`);
  }
  return sha.toLowerCase();
}
