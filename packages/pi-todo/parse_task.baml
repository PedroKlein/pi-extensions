class ParsedTask {
  title string @description("concise task title — clean rewrite, not just an echo of the input")
  type "feature" | "bug" | "chore" | "research" | "review" | "personal" @description("bug: fixing issues; feature: new capabilities; chore: maintenance; research: investigation or exploration; review: code/PR reviews; personal: non-work tasks")
  priority "high" | "medium" | "low" @description("high: urgent or blocking; low: nice-to-have or someday; medium: normal work item")
  due_date string? @description("due date in YYYY-MM-DD format — only include if a specific date is mentioned or strongly implied; resolve relative dates like 'tomorrow' or 'next Friday' using current_date; omit if no date is mentioned")
  description string? @description("concise 2-3 sentence summary capturing key details, context, and intent — distilled so future-you understands it at a glance")
}

function ParseTask(text: string, current_date: string) -> ParsedTask {
  client PiClient
  prompt #"
    Parse the following task description into structured fields.
    Use current_date to resolve relative dates like "tomorrow", "next Friday", "in 2 weeks".
    Omit due_date unless a specific date is mentioned or strongly implied.

    {{ ctx.output_format }}

    Current date: {{ current_date }}

    Task: {{ text }}
  "#
}
