import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createRedactor, truncateText } from "./redaction.js";
import { parseAnnotation, type Annotation } from "./model.js";

export interface FailureDiagnosisInput {
  runId: number;
  attempt: number;
  sha: string;
  conclusion: string;
  url: string;
  jobs: Array<{
    name: string;
    conclusion: string;
    steps: Array<{ name: string; conclusion: string }>;
  }>;
  annotations: unknown[];
  logs: string | null;
}

export interface FailureDiagnosis extends Omit<FailureDiagnosisInput, "annotations" | "logs"> {
  annotations: Annotation[];
  logExcerpt?: string;
  logsUnavailable?: boolean;
  omittedLogBytes: number;
  fullLogPath?: string;
}

interface DiagnosisOptions {
  maxLogBytes?: number;
  persistDirectory?: string;
  filename?: string;
  secrets?: Array<string | undefined>;
}

export async function formatDiagnosis(
  input: FailureDiagnosisInput,
  options: DiagnosisOptions = {},
): Promise<FailureDiagnosis> {
  if (!/^[0-9a-f]{40}$/i.test(input.sha)) throw new Error("Diagnosis requires a full head SHA.");
  if (!Number.isInteger(input.runId) || input.runId <= 0) throw new Error("Diagnosis requires a run ID.");
  if (!Number.isInteger(input.attempt) || input.attempt <= 0) throw new Error("Diagnosis requires a run attempt.");
  const result: FailureDiagnosis = {
    runId: input.runId,
    attempt: input.attempt,
    sha: input.sha.toLowerCase(),
    conclusion: input.conclusion,
    url: input.url,
    jobs: input.jobs,
    annotations: input.annotations.map(parseAnnotation),
    omittedLogBytes: 0,
  };
  if (input.logs === null) return { ...result, logsUnavailable: true };

  const logs = createRedactor(options.secrets)(input.logs);
  const bounded = truncateText(logs, options.maxLogBytes ?? 8 * 1024);
  result.logExcerpt = bounded.text;
  result.omittedLogBytes = bounded.omittedBytes;
  if (bounded.truncated && options.persistDirectory) {
    await mkdir(options.persistDirectory, { recursive: true, mode: 0o700 });
    result.fullLogPath = join(options.persistDirectory, basename(options.filename ?? `run-${input.runId}.log`));
    await writeFile(result.fullLogPath, logs, { encoding: "utf8", mode: 0o600 });
  }
  return result;
}
