/**
 * Extract class and enum type definitions from BAML source.
 *
 * Returns raw BAML blocks as strings (e.g. "class TodoItem {\n  description string\n  ...\n}").
 * Does NOT extract function blocks — only class and enum type definitions.
 *
 * The extractor uses a two-pass approach:
 *   1. Regex to locate block headers (class/enum keyword at line start).
 *   2. Brace-depth counting to find the matching closing brace.
 *
 * String literals are skipped during brace counting to avoid false positives
 * from braces inside @description("...") annotations.
 *
 * Known limitation: a class/enum keyword that appears inside a raw BAML string
 * literal (#"..."#) followed immediately by { could produce a false match.
 * This is extremely uncommon in real .baml files.
 */
export function parseTypeDefinitions(source: string): string[] {
  const results: string[] = [];

  // Match class/enum declarations at line starts.
  // Groups: (1) leading newline or "", (2) optional indent, (3) keyword, (4) name
  const headerPattern = /(^|\n)([ \t]*)(class|enum)(\s+\w+)/g;

  let match: RegExpExecArray | null;
  while ((match = headerPattern.exec(source)) !== null) {
    // Position of the type keyword (after leading newline + any indent)
    const leadingLen = match[1]!.length + match[2]!.length;
    const blockStart = match.index + leadingLen;

    // Find the opening brace (may have whitespace between name and brace)
    const headerEnd = match.index + match[0].length;
    const openBrace = source.indexOf("{", headerEnd);
    if (openBrace === -1) continue;

    // Find the matching closing brace
    const closeBrace = findMatchingBrace(source, openBrace);
    if (closeBrace === -1) continue;

    results.push(source.slice(blockStart, closeBrace + 1));
  }

  return results;
}

/**
 * Find the position of the closing brace matching the opening brace at openPos.
 *
 * Skips double-quoted string literals to avoid counting braces inside
 * annotations like @description("contains {curly} braces").
 *
 * Returns -1 if no matching brace is found (malformed source).
 */
function findMatchingBrace(source: string, openPos: number): number {
  let depth = 0;
  let i = openPos;

  while (i < source.length) {
    const ch = source[i];

    if (ch === '"') {
      // Advance past the string literal, skipping its internal content.
      i++;
      while (i < source.length) {
        const c = source[i];
        if (c === "\\") {
          i += 2; // skip escape sequence (e.g. \", \\)
          continue;
        }
        if (c === '"') {
          i++;
          break; // past closing quote
        }
        i++;
      }
      // i is now past the closing quote; continue without the bottom i++
      continue;
    }

    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }

    i++;
  }

  return -1; // unmatched brace — malformed source
}
