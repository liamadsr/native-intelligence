/**
 * `request_user_input` — the work-agent's mid-run clarifying-question tool (Loops
 * v3 Phase 3; docs/loop-engine/INTERACTIVE-WORK-RUNS-DESIGN.md).
 *
 * A running work agent that hits a genuine fork — missing info that materially
 * changes the deliverable — calls this to PARK the run and ask the user, instead
 * of guessing or fabricating. The run enters `needs_input`, the user answers from
 * the run drill-in, and the run resumes exactly where it parked.
 *
 * ── Why NOT named `ask_user` ─────────────────────────────────────────────────
 * `isReadShapedToolName` in the tool-registry special-cases the literal name
 * `ask_user`; naming this tool that would collide with that read-shaped handling.
 * A distinct name (`request_user_input`) keeps it a plain gated tool.
 *
 * ── How it pauses (HITL) ─────────────────────────────────────────────────────
 * eve emits `input.requested` for a tool through (a) an `approval` gate or (b)
 * `ctx.ask()` from a workflow tool (eve 0.65+: `ask_question` is now an opt-in
 * workflow tool built on it, no longer a default). `defineTool` REQUIRES an
 * `execute`, and the dispatcher classifies the approval shape, so we gate on
 * `approval: always()`: every call PAUSES the turn at
 * `session.waiting` with an `input.requested` whose `action.toolName` is
 * `request_user_input` and whose `action.input` is `{ questions }`. The work-run
 * dispatcher (run-work-eve.ts) detects that, persists `pending_input` + the resume
 * snapshot, flips the run to `needs_input`, and files a `work_run_input`
 * notification.
 *
 * ── The resume choreography (the already-debugged eve quirk) ─────────────────
 * The resume is ONE `respond()`: `inputResponses: [{ requestId, optionId: <approve
 * id> }]`, with the answers as the turn's `clientContext` and on the response's
 * `text` (src/lib/eve/conversation-session.ts). eve 0.31+ answers a `message` sent
 * together with `inputResponses` with a 400, so the answers do NOT ride as a
 * follow-up message in the same send. eve discards `text` on an approval
 * response, and clientContext is one-turn model context. Skip = deny optionId + a
 * "user skipped the question" note. The answers reach the model as context on
 * the resumed turn, NOT as this tool's result.
 *
 * ── Why there IS an execute (framework constraint) ──────────────────────────
 * The design doc calls for NO execute, but `defineTool` REQUIRES one in every
 * overload — an execute-less tool isn't expressible (same constraint the
 * chat-agent's ask_user hit). So we mirror ask_user EXACTLY: `approval: always()`
 * IS the pause mechanism, and this execute runs ONLY after the approval resolves,
 * returning a one-beat acknowledgment. eve resolves the approval, runs this
 * execute, calls the model once with just this result, and delivers the user's
 * answers as a QUEUED message at the NEXT step boundary — so the model always
 * produces one short beat before it can see the answers; this note makes that beat
 * a deliberate "Got it." instead of a confused "still waiting…".
 */
import { defineTool } from 'eve/tools'
import { always } from 'eve/tools/approval'
import { z } from 'zod'

/** Rich schema — mirrors the cloud/chat `ask_user` (src/lib/ai/tools/ask-user.ts,
 *  agents/chat-agent/tools/ask_user.ts) so QuestionPicker renders it unchanged. */
const requestUserInputSchema = z.object({
  questions: z
    .array(
      z.object({
        // `.min(1)` after trim: a blank question string is a degenerate emission that
        // would park the run with an EMPTY questions array (normalizeQuestions drops
        // blank-text entries) → a dead picker with no answer path. Reject it at the
        // schema so eve surfaces a tool-validation error the model retries, instead.
        question: z
          .string()
          .trim()
          .min(1)
          .describe('The full question text to display.'),
        header: z
          .string()
          .describe('A short label for the question (≤12 chars), shown as a chip.'),
        options: z
          .array(
            z.object({
              // Same reasoning as `question`: a blank label is dropped downstream and
              // would leave a choice-less question — require real text.
              label: z.string().trim().min(1).describe('The choice shown to the user.'),
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
})

export default defineTool({
  description:
    'Ask the user one or more multiple-choice questions and PAUSE the run until ' +
    'they answer. Use this ONLY when you are genuinely blocked — a piece of ' +
    'information is missing that materially changes the deliverable and you cannot ' +
    'reasonably infer it. Do NOT ask for permission to proceed (the user already ' +
    'approved this work by starting it), and ask at most twice per run. The run ' +
    'enters a "needs your input" state; the user answers from the run view and you ' +
    'continue exactly where you left off. 1–4 questions, each with 2–4 options.',
  inputSchema: requestUserInputSchema,
  // always() PAUSES the turn on every call → input.requested (the picker). The
  // dispatcher parks the run at needs_input; the user's answer resumes it over the
  // same session.
  approval: always(),
  // Runs after the user has answered (approval resolved). It does NOT re-ask; it
  // acknowledges so the model proceeds from the user's choice, which arrives as the
  // next user message (delivered immediately after this result). Mirrors the
  // chat-agent ask_user execute — the framework requires an execute, and this
  // wording keeps the mandatory one-step beat a clean "Got it." rather than a
  // confused "still waiting for your answer…".
  execute: (input) => ({
    asked: input.questions.map((q) => q.question),
    note:
      'The user has answered. Their answers arrive as the next user message, delivered ' +
      'immediately after this result — you cannot see them yet. Respond with ONLY a brief ' +
      'acknowledgment (e.g. "Got it."), nothing else; then act on the answers when they arrive.',
  }),
})
