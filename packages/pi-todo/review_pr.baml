class PrReview {
  what string @description("brief description of what this PR does — 2-3 sentences")
  why string @description("the motivation or problem being solved — infer from the diff context if not explicitly stated")
  scope string @description("files changed and rough scope — e.g. '3 files, ~120 lines added, ~40 removed' — plus key areas touched")
  risks string[] @description("list of potential issues: missing error handling, edge cases, security concerns, breaking changes, test coverage gaps — one item per risk; empty array if none found")
  verdict string @description("one-line assessment of the PR: is it straightforward, needs attention, or concerning?")
}

function ReviewPR(owner: string, repo: string, number: int, title: string, author: string, branch: string, state: string, diff: string) -> PrReview {
  client PiClient
  prompt #"
    Review this pull request. Analyze the diff and produce a structured review.
    Be concise and practical. No filler. If you can't determine something from the diff, say so.

    PR: {{ owner }}/{{ repo }} #{{ number }}
    Title: {{ title }}
    Author: {{ author }}
    Branch: {{ branch }}
    State: {{ state }}

    {{ ctx.output_format }}

    Diff:
    {{ diff }}
  "#
}
