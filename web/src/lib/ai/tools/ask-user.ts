import { tool } from 'ai'
import { z } from 'zod'

/**
 * `ask_user` — the clarifying-question tool's registry entry and schema. It
 * has **no `execute` function**. The eve chat-agent owns the live tool
 * (agents/chat-agent/tools/ask_user.ts, an approval-gated native tool): the call
 * parks the turn, the client (chat-message.tsx → QuestionPicker) collects the
 * answer, and the transport's answerPermission sends it back on the same eve
 * session, which resumes the turn. This entry keeps `ask_user` in the tool
 * registry (createTools), and the chat-agent's tool mirrors its schema.
 *
 * Because it has no execute, the MCP registrar skips it (it requires `.execute`,
 * see src/lib/mcp/tools/index.ts) — so it is NOT exported over MCP: the picker
 * only exists in Dial8's own chats.
 *
 * The schema: 1–4 questions, each with a short header chip, 2–4 options
 * (label + description), and a single/multi-select flag.
 */
export function createAskUserTools() {
  return {
    ask_user: tool({
      description:
        'Ask the user one or more multiple-choice clarifying questions when a task has several valid approaches and you need their decision to proceed. Renders as a clickable picker in the chat (with an "Other" free-text option). Prefer this over asking in prose when you can offer concrete choices. 1–4 questions, each with 2–4 options.',
      inputSchema: z.object({
        questions: z
          .array(
            z.object({
              question: z.string().describe('The full question text to display.'),
              header: z
                .string()
                .describe('A short label for the question (≤12 chars), shown as a chip.'),
              options: z
                .array(
                  z.object({
                    label: z.string().describe('The choice shown to the user.'),
                    description: z
                      .string()
                      .optional()
                      .describe('A brief explanation of what this choice means.'),
                  }),
                )
                .min(2)
                .max(4)
                .describe('2–4 mutually-exclusive choices.'),
              multiSelect: z
                .boolean()
                .describe('Whether the user may select more than one option.'),
            }),
          )
          .min(1)
          .max(4)
          .describe('1–4 clarifying questions to ask at once.'),
      }),
      // NO execute — resolved client-side via addToolResult.
    }),
  }
}
