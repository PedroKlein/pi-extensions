const DEFAULT_MAX_BYTES = 64 * 1024;

export interface TruncatedText {
  text: string;
  truncated: boolean;
  omittedBytes: number;
}

export function truncateText(value: string, maxBytes = DEFAULT_MAX_BYTES): TruncatedText {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) {
    return { text: value, truncated: false, omittedBytes: 0 };
  }

  let text = bytes.subarray(0, maxBytes).toString("utf8");
  while (Buffer.byteLength(text) > maxBytes) text = text.slice(0, -1);
  return {
    text,
    truncated: true,
    omittedBytes: bytes.length - Buffer.byteLength(text),
  };
}

export function createRedactor(secrets: Array<string | undefined> = []): (value: string) => string {
  const known = secrets.filter((secret): secret is string => Boolean(secret && secret.length >= 4));
  return (value) => {
    let result = value;
    for (const secret of known) result = result.split(secret).join("[REDACTED]");
    return result
      .replace(/(authorization\s*:\s*(?:bearer|token)\s+)\S+/gi, "$1[REDACTED]")
      .replace(/\b((?:GH|GITHUB)_[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD)\s*=\s*)\S+/gi, "$1[REDACTED]")
      .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@");
  };
}
