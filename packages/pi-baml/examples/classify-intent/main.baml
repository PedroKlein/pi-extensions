// Classification example: literal unions, @description annotations, dynamic input

class IntentMatch {
  intent "question" | "command" | "statement" | "greeting" @description("the primary intent category")
  confidence "high" | "medium" | "low" @description("how confident the classification is")
  reasoning string @description("brief explanation of why this intent was chosen")
}

function ClassifyIntent(message: string, context: string?) -> IntentMatch {
  client PiClient
  prompt #"
    Classify the intent of the user's message.

    {% if context %}
    Previous context: {{ context }}
    {% endif %}

    {{ ctx.output_format }}

    Message: {{ message }}
  "#
}
