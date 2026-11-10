/**
 * `ask_user` — the chat-agent's clarifying-question tool (Phase 4).
 *
 * RESOLVED DECISION (design doc §"Resolved product decisions" #3): keep Native Intelligence's
 * rich `ask_user` as a CUSTOM tool; do NOT adopt eve's native `ask_question`.
 * eve's `ask_question` is flat (one prompt, flat options); Native Intelligence's `ask_user`
 * batches 1–4 questions, each with a short header chip, 2–4 options with
 * descriptions, and a single/multi-select flag. Porting to native loses that UX,
 * so we carry the existing picker as a custom tool here.
 *
 * ── How it pauses (HITL) ─────────────────────────────────────────────────────
 * eve's only mechanisms that emit `input.requested` for a tool are (a) an
 * `approval` gate and (b) the built-in execute-less `ask_question`. `defineTool`
 * REQUIRES an `execute`, so a bespoke execute-less tool isn't expressible. We
 * therefore gate on `approval: always()`: every call PAUSES the turn at
 * `session.waiting` with an `input.requested` whose `action.toolName` is
 * `ask_user` and whose `action.input` is `{ questions }`. The EveChatTransport
 * detects that (toolName === 'ask_user') and renders it as the EXISTING in-chat
 * picker (a `tool-input-available` dynamic part with toolName 'ask_user'), so
 * chat-message.tsx → QuestionPicker renders with ZERO UI changes. The client
 * answers over the same eve session (chat-panel's handleAnswerQuestion eve
 * branch → inputResponses), which resumes the parked turn.
 *
 * ── Why the ceiling proxy SKIPS this name ────────────────────────────────────
 * `ask_user` is in CORE_TOOL_NAMES, so the spec's ceilingTools lists it — but it
 * has no server-side execute on the Next side, so proxying it to
 * /api/internal/chat/tool would 400 (TOOL_NO_EXECUTE). tools/workspace_tools.ts
 * explicitly skips the `ask_user` name so THIS native tool owns it (no dynamic-
 * name collision).
 *
 * ── The device surface never parks ───────────────────────────────────────────
 * /api/device/ask runs this agent as a one-shot session (one turn, read to
 * its boundary: src/lib/eve/task-session.ts) for a voice device that has no
 * picker and no way to answer. A park there is not a pause: eve 0.70+ holds
 * the turn open at `turn.waiting` on this tool's approval, which nobody will
 * answer there, the read
 * classifies that as `waiting` and cancels it, and the device gets an error
 * instead of its answer (there is no task mode to fail closed since eve
 * 0.67). SURFACE_EXCLUDED_TOOLS cannot remove this tool (it is native, not a
 * ceiling proxy), so the gate is here: when the run token's surface is
 * 'device_ask' the approval policy answers 'not-applicable' (no park) and the
 * execute returns a refusal the model can act on — "no one can answer; decide
 * and say what you assumed". Every other session keeps the always-park picker.
 * The surface is read UNVERIFIED off the token (spec-client.ts
 * surfaceFromRunToken, a routing hint): forging it can only take the picker
 * away from the forger's own chat, and the internal routes verify the token.
 *
 * ── A teammate chat has no picker either (bots v2) ───────────────────────────
 * A conversation with one AI teammate (the token carries `teammateId`,
 * docs/plans/bots-v2.md decision 3) runs in a small bubble with no picker, and
 * v2 leaves `ask_user` out of a teammate's ceiling. The ceiling filters
 * workspace proxies, not this native tool, so the gate is here too: on a
 * teammate token the call answers (no park) with a note telling the model to
 * ask in plain text. Read unverified (spec-client.ts teammateFromRunToken), so
 * forging it can only take the picker away from the forger's own chat.
 *
 * ── Nor does a server-started turn (A4 slice 5) ──────────────────────────────
 * A background update the server sent into a home thread (the token carries
 * `server: 'home_turn'`) has nobody watching: the call answers "not
 * applicable" (no park), like the device ask, so the server's read never
 * hangs on a picker no one sees. Read unverified (spec-client.ts
 * serverFromRunToken), so forging it can only take the picker away.
 *
 * ── Nor does a message from an outside channel ───────────────────────────────
 * A Slack message or a text from the person (`server: 'channel_turn'`,
 * docs/plans/slack-connect.md, docs/plans/text-and-calling.md) IS the person,
 * but in Slack or on a phone: there is no picker there. The call answers (no park) with a note telling the model to
 * ask in the reply itself, options in the sentence; the person's next message
 * answers it, as a new channel turn.
 *
 * NOTE (runtime smoke-test deferred, like the rest of Phase 4 HITL): the precise
 * shape of the resumed answer the model sees depends on how eve threads the
 * approval response text back — verify end-to-end before trusting it. `execute`
 * runs only after the user answers (approval resolved); it acknowledges the
 * answered question so the model continues from the user's choice, which arrives
 * on the session as the resumed input.
 */
import { defineTool } from 'eve/tools'
import type { SessionAuth } from 'eve/context'
import { z } from 'zod'
import { runTokenFromAuth, serverFromRunToken, surfaceFromRunToken, teammateFromRunToken } from '../lib/spec-client.js'
import { isMacHost } from '../lib/host.js'

/**
 * True when this session is a surface run nobody can answer a picker on. Never
 * throws: a missing session/auth reads as an ordinary (attended) chat.
 */
export function isUnattendedSurface(auth: SessionAuth | undefined): boolean {
  return auth !== undefined && surfaceFromRunToken(runTokenFromAuth(auth)) === 'device_ask'
}

/**
 * True when this session is a teammate chat (bots v2), which has no picker.
 * Never throws: a missing session/auth reads as an ordinary chat.
 */
export function isTeammateChat(auth: SessionAuth | undefined): boolean {
  return auth !== undefined && teammateFromRunToken(runTokenFromAuth(auth)) !== undefined
}

/**
 * True when this turn was started by the server (a background update in a
 * home thread, A4 slice 5): nobody is there to answer a picker, and a park
 * would leave the server's read hanging on a question no one sees. Never
 * throws: a missing session/auth reads as an ordinary chat.
 */
export function isServerTurn(auth: SessionAuth | undefined): boolean {
  return auth !== undefined && serverFromRunToken(runTokenFromAuth(auth)) !== undefined
}

/**
 * True when this turn is the person messaging from an outside channel (a
 * Slack message, a text): no picker there. Read unverified, like the rest. Never throws.
 */
export function isChannelTurn(auth: SessionAuth | undefined): boolean {
  return auth !== undefined && serverFromRunToken(runTokenFromAuth(auth)) === 'channel_turn'
}

/** The tool result a channel turn gets instead of a picker. */
export const CHANNEL_TURN_ASK_USER_RESULT = {
  asked: false,
  note:
    'There is no picker here: the person is messaging you from outside the Native Intelligence app. Do not call ask_user again. ' +
    'If you need them to choose, ask one short question in your reply, with the options in the sentence ' +
    '(for example "Tuesday or Wednesday?"), and stop there: their next message is the answer.',
} as const

/** The tool result a server-started turn gets instead of a picker. */
export const SERVER_TURN_ASK_USER_RESULT = {
  asked: false,
  note:
    'Not applicable: this is a background update the server started, and the person is not here to ' +
    'answer a picker. Do not call ask_user again. If they need to decide something, say so in one short ' +
    'message, with the options in the sentence, and they will answer when they are back.',
} as const

/** The tool result a teammate chat gets instead of a picker. */
export const TEAMMATE_ASK_USER_RESULT = {
  asked: false,
  note:
    'There is no picker in this conversation. Do not call ask_user again. If you need the ' +
    'person to choose, ask one short question in plain text, with the options in the sentence, ' +
    'and wait for their reply.',
} as const

/** The tool result an unattended (device) run gets instead of a picker. */
export const UNATTENDED_ASK_USER_RESULT = {
  asked: false,
  note:
    'No one can answer questions here: this request came from a voice device with no screen, ' +
    'and it expects one spoken answer. Do not ask again. Choose the most reasonable option ' +
    'yourself, say in one short clause what you assumed, and answer the request directly.',
} as const

/**
 * The Mac body (contract C2, ../lib/host.ts): the desktop relays words, not
 * pickers, so nothing could answer one. The call answers instead of parking.
 */
export const MAC_ASK_USER_RESULT = {
  asked: false,
  note:
    'There is no picker on this Mac. Do not call ask_user again. If you need the person to choose, ' +
    'ask one short question in words, with the options in the sentence (with report_to_person, or ' +
    'message_teammate for the Native Intelligence agent in the cloud, when you have them; otherwise in your finish ' +
    'summary). Then end your turn: the answer arrives as your next message.',
} as const

/** Rich schema — twin of the cloud `ask_user` (src/lib/ai/tools/ask-user.ts). */
const askUserInput = z.object({
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
})

export default defineTool({
  description:
    'Ask the user one or more multiple-choice clarifying questions when a task has several valid approaches and you need their decision to proceed. Renders as a clickable picker in the chat (with an "Other" free-text option). Prefer this over asking in prose when you can offer concrete choices. 1–4 questions, each with 2–4 options.',
  inputSchema: askUserInput,
  // Every call PAUSES the turn (always()'s 'user-approval') → input.requested
  // (the picker); the user's answer resumes the parked turn over the same eve
  // session. The device surface and a teammate chat are the exceptions: nobody
  // can answer a picker there, so no park — the execute below answers the call
  // instead (see the header).
  approval: ({ session }) =>
    isMacHost() || isUnattendedSurface(session?.auth) || isTeammateChat(session?.auth) || isServerTurn(session?.auth)
      ? 'not-applicable'
      : 'user-approval',
  // Runs after the user has answered (approval resolved). It doesn't re-ask; it
  // acknowledges so the model proceeds from the user's choice, which arrives on
  // the resumed session.
  // Wording matters (verified live via scripts/eve-ask-user-repro.ts): eve
  // resolves the approval, runs THIS execute, and calls the model once with just
  // this result — the user's answers ride a QUEUED message that is only delivered
  // at the NEXT step boundary (tool-loop consumeDeferredStepInput). So the model
  // ALWAYS produces one short step before it can see the answers; this note makes
  // that step a deliberate one-word beat instead of a confused "I'm still waiting
  // for your answer…" (both steps render into the same assistant bubble).
  // An answer can be words the person typed into the composer instead of a
  // picked option (the #681 rule; the transport approves the call and sends the
  // words as the answer), so the note says that counts and is not to be re-asked.
  // On the device surface (never parked) it answers the call instead.
  execute: (input, ctx) => {
    if (isMacHost()) return MAC_ASK_USER_RESULT
    if (isUnattendedSurface(ctx?.session?.auth)) return UNATTENDED_ASK_USER_RESULT
    if (isTeammateChat(ctx?.session?.auth)) return TEAMMATE_ASK_USER_RESULT
    // A channel turn is a server principal too: its own note comes first.
    if (isChannelTurn(ctx?.session?.auth)) return CHANNEL_TURN_ASK_USER_RESULT
    if (isServerTurn(ctx?.session?.auth)) return SERVER_TURN_ASK_USER_RESULT
    return {
      asked: input.questions.map((q) => q.question),
      note:
        'The user has answered. Their answers arrive as the next user message, delivered ' +
        'immediately after this result — you cannot see them yet. Respond with ONLY a brief ' +
        'acknowledgment (e.g. "Got it."), nothing else; then act on the answers when they arrive. ' +
        'An answer may be their own words instead of one of your options: that is their answer, ' +
        'so act on it and do not ask the same question again.',
    }
  },
})
