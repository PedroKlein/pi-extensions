export interface TokenizerProvenance {
  name: string;
  provenance: string;
  accuracy: "exact" | "estimate";
  count(text: string): number;
}

export interface SourceInfoInput {
  source: string;
  origin: "package" | "top-level";
}

export interface SkillInput {
  name: string;
  description: string;
  filePath: string;
  disableModelInvocation: boolean;
  sourceInfo: SourceInfoInput;
}

export interface ToolInput {
  name: string;
  description: string;
  parameters: unknown;
  sourceInfo: SourceInfoInput;
}

export interface StaticBurdenInput {
  systemPrompt: string;
  skills: SkillInput[];
  tools: ToolInput[];
  activeToolNames: string[];
  branchEntries: unknown[];
}

export interface MeasuredValue {
  chars: number;
  tokens: number;
}

export interface StaticBurdenReport {
  schemaVersion: 1;
  tokenizer: Omit<TokenizerProvenance, "count">;
  categories: {
    systemPrompt: MeasuredValue;
    skills: {
      personal: MeasuredValue & { count: number };
      package: MeasuredValue & { count: number };
      total: MeasuredValue & { count: number };
    };
    activeToolSchemas: MeasuredValue & { count: number };
    modelVisibleCustomMessages: MeasuredValue & { count: number };
  };
}

function measure(text: string, tokenizer: TokenizerProvenance): MeasuredValue {
  return { chars: text.length, tokens: tokenizer.count(text) };
}

function sumMeasurements(values: MeasuredValue[]): MeasuredValue {
  return values.reduce(
    (total, value) => ({
      chars: total.chars + value.chars,
      tokens: total.tokens + value.tokens,
    }),
    { chars: 0, tokens: 0 },
  );
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function serializeSkill(skill: SkillInput): string {
  return [
    "  <skill>",
    `    <name>${escapeXml(skill.name)}</name>`,
    `    <description>${escapeXml(skill.description)}</description>`,
    `    <location>${escapeXml(skill.filePath)}</location>`,
    "  </skill>",
  ].join("\n");
}

function customMessageContent(entry: unknown): unknown {
  if (!entry || typeof entry !== "object") return undefined;
  const value = entry as Record<string, unknown>;
  if (value.type === "custom_message") return value.content;
  if (value.type !== "message") return undefined;

  const message = value.message;
  if (!message || typeof message !== "object") return undefined;
  const normalized = message as Record<string, unknown>;
  return normalized.role === "custom" ? normalized.content : undefined;
}

function serializeContent(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

export function measureStaticBurden(
  input: StaticBurdenInput,
  tokenizer: TokenizerProvenance,
): StaticBurdenReport {
  const visibleSkills = input.skills.filter(
    (skill) => !skill.disableModelInvocation,
  );
  const personalSkills = visibleSkills.filter(
    (skill) => skill.sourceInfo.origin === "top-level",
  );
  const packageSkills = visibleSkills.filter(
    (skill) => skill.sourceInfo.origin === "package",
  );
  const activeTools = input.tools.filter((tool) =>
    input.activeToolNames.includes(tool.name),
  );
  const customMessages = input.branchEntries
    .map(customMessageContent)
    .filter((content) => content !== undefined);

  const measureSkills = (skills: SkillInput[]) =>
    sumMeasurements(
      skills.map((skill) => measure(serializeSkill(skill), tokenizer)),
    );
  const measureTools = () =>
    sumMeasurements(
      activeTools.map((tool) =>
        measure(
          JSON.stringify({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          }),
          tokenizer,
        ),
      ),
    );
  const measureCustomMessages = () =>
    sumMeasurements(
      customMessages.map((content) =>
        measure(serializeContent(content), tokenizer),
      ),
    );

  const personal = measureSkills(personalSkills);
  const packageOwned = measureSkills(packageSkills);
  const allSkills = sumMeasurements([personal, packageOwned]);
  const toolSchemas = measureTools();
  const modelVisibleCustomMessages = measureCustomMessages();

  return {
    schemaVersion: 1,
    tokenizer: {
      name: tokenizer.name,
      provenance: tokenizer.provenance,
      accuracy: tokenizer.accuracy,
    },
    categories: {
      systemPrompt: measure(input.systemPrompt, tokenizer),
      skills: {
        personal: { ...personal, count: personalSkills.length },
        package: { ...packageOwned, count: packageSkills.length },
        total: { ...allSkills, count: visibleSkills.length },
      },
      activeToolSchemas: { ...toolSchemas, count: activeTools.length },
      modelVisibleCustomMessages: {
        ...modelVisibleCustomMessages,
        count: customMessages.length,
      },
    },
  };
}
