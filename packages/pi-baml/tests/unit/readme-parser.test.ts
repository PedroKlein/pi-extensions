import { describe, it, expect } from "vitest";
import {
  parseReadmeDescription,
  parseReadmeBody,
} from "../../src/lib/readme-parser.js";

describe("parseReadmeDescription", () => {
  it("returns description from valid frontmatter", () => {
    const content = `---
description: Extract TODOs from text
---

# My Skill`;
    expect(parseReadmeDescription(content)).toBe("Extract TODOs from text");
  });

  it("returns undefined when no frontmatter (no opening ---)", () => {
    const content = "# My Skill\n\nSome content here";
    expect(parseReadmeDescription(content)).toBeUndefined();
  });

  it("returns undefined when frontmatter has no description field", () => {
    const content = `---
title: My Skill
author: someone
---

Body here`;
    expect(parseReadmeDescription(content)).toBeUndefined();
  });

  it("handles description with colons in value", () => {
    const content = `---
description: Extract TODOs: meeting notes, changelogs
---`;
    expect(parseReadmeDescription(content)).toBe(
      "Extract TODOs: meeting notes, changelogs",
    );
  });

  it("handles double-quoted description", () => {
    const content = `---
description: "Text with: special chars"
---`;
    expect(parseReadmeDescription(content)).toBe("Text with: special chars");
  });

  it("handles single-quoted description", () => {
    const content = `---
description: 'Text here'
---`;
    expect(parseReadmeDescription(content)).toBe("Text here");
  });

  it("trims whitespace from value", () => {
    const content = `---
description:   lots of spaces   
---`;
    expect(parseReadmeDescription(content)).toBe("lots of spaces");
  });

  it("returns undefined for empty string input", () => {
    expect(parseReadmeDescription("")).toBeUndefined();
  });

  it("returns undefined when frontmatter is not at start of file", () => {
    const content = `Some text before\n---\ndescription: Oops\n---`;
    expect(parseReadmeDescription(content)).toBeUndefined();
  });
});

describe("parseReadmeBody", () => {
  it("returns body content after closing ---", () => {
    const content = `---
description: Some skill
---

# My Skill

This is the body.`;
    expect(parseReadmeBody(content)).toBe("# My Skill\n\nThis is the body.");
  });

  it("returns undefined when no frontmatter", () => {
    const content = "# No frontmatter here";
    expect(parseReadmeBody(content)).toBeUndefined();
  });

  it("returns undefined when content is only frontmatter with no body", () => {
    const content = `---
description: Just frontmatter
---`;
    expect(parseReadmeBody(content)).toBeUndefined();
  });

  it("trims leading newlines from body", () => {
    const content = `---
description: hi
---


Body starts here`;
    expect(parseReadmeBody(content)).toBe("Body starts here");
  });

  it("preserves internal body formatting", () => {
    const body = `# Title

Paragraph one.

- item one
- item two

\`\`\`typescript
const x = 1;
\`\`\``;
    const content = `---
description: skill
---

${body}`;
    expect(parseReadmeBody(content)).toBe(body);
  });
});
