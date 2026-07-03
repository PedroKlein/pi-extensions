/**
 * Parse description and body from README.md YAML frontmatter.
 *
 * Frontmatter must appear at the very start of the file between `---` delimiters.
 * No external YAML parser — regex only.
 */

/** Matches frontmatter block at the start of a file: --- ... --- */
const FRONTMATTER_RE = /^\s*---\r?\n([\s\S]*?)\r?\n---/;

/**
 * Parse the description field from README.md YAML frontmatter.
 *
 * Expects format:
 * ```
 * ---
 * description: Some text here
 * ---
 * ```
 *
 * Handles unquoted, double-quoted, and single-quoted values.
 * Returns `undefined` if no frontmatter or no description field is found.
 */
export function parseReadmeDescription(content: string): string | undefined {
  const fm = extractFrontmatter(content);
  if (fm === undefined) {
    return undefined;
  }

  // Match: description: <value>
  // Value may be: plain text, "double quoted", or 'single quoted'
  const match = fm.match(/^description:\s*(.+)$/m);
  const captured = match?.[1];
  if (!captured) {
    return undefined;
  }

  const raw = captured.trim();
  return stripQuotes(raw);
}

/**
 * Extract body content after the closing `---` frontmatter delimiter.
 *
 * Returns everything after the closing `---`, trimmed of leading newlines.
 * Returns `undefined` if no valid frontmatter is found or the body is empty.
 */
export function parseReadmeBody(content: string): string | undefined {
  const fmMatch = FRONTMATTER_RE.exec(content);
  if (!fmMatch) {
    return undefined;
  }

  const afterFrontmatter = content.slice(fmMatch[0].length);
  const body = afterFrontmatter.replace(/^\r?\n+/, "");
  return body.length > 0 ? body : undefined;
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

/** Return the raw frontmatter content (between the --- delimiters). */
function extractFrontmatter(content: string): string | undefined {
  const match = FRONTMATTER_RE.exec(content);
  return match ? match[1] : undefined;
}

/** Strip surrounding double or single quotes from a YAML scalar value. */
function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
