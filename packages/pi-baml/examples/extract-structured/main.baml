// Structured extraction example: classes, nested types, arrays, optionals

class ActionItem {
  description string @description("what needs to be done")
  assignee string? @description("who is responsible, if mentioned")
  due_date string? @description("ISO 8601 date, if mentioned")
  priority "high" | "medium" | "low" @description("inferred urgency")
}

class MeetingSummary {
  title string @description("meeting topic or subject")
  attendees string[] @description("names of people present")
  key_points string[] @description("main topics discussed")
  action_items ActionItem[] @description("tasks assigned during the meeting")
  next_meeting string? @description("date/time of follow-up, if scheduled")
}

function ExtractMeetingSummary(transcript: string) -> MeetingSummary {
  client PiClient
  prompt #"
    Extract a structured summary from this meeting transcript.
    Include all action items with assignees when mentioned.

    {{ ctx.output_format }}

    ---
    {{ transcript }}
  "#
}
