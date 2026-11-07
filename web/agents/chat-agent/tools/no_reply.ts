/**
 * no_reply — how a SERVER-started turn ends when it has nothing worth saying.
 *
 * A home turn (a background update the server sends into the person's home
 * thread: a helper's report, a router event, the daily digest; src/lib/chat/
 * home-turn-server.ts) often has nothing the person needs to hear now. eve
 * 0.69's opt-in `no_reply` is the documented way to end such a turn: a tool
 * whose call ends the turn, so the turn completes with no final message
 * (docs/concepts/built-in-tools.md "no_reply"). It replaces the `[quiet]` text
 * marker the home turn used before: an action, not a magic reply string. This
 * is "hide empty widgets" at the agent level.
 *
 * ── STATIC, so the home thread's prompt cache holds ─────────────────────────
 * The home thread's person turns and server turns share one durable session
 * and one cached prompt prefix, and the tool list is part of that prefix
 * (src/lib/chat/chat-ceiling.ts isServerTurnTool says the same for the
 * workspace tools). A tool that appeared only on server turns would change the
 * list on every background update and re-read the whole thread uncached. So
 * the tool is ALWAYS advertised, and the gate is in `execute`, the way
 * ask_user gates on `ctx.session.auth`.
 *
 * ── SERVER TURNS ONLY: the gate ─────────────────────────────────────────────
 * A person's own turn always gets an answer. `execute` ends the turn only when
 * the turn's run token carries `server: 'home_turn'` (spec-client.ts
 * serverFromRunToken); otherwise it answers `{ ended: false }` with a note to
 * answer the person, and `endsTurn` (a function, decided from the output:
 * docs/tools/overview.mdx, harness/step/after-model.js stepEndsTurn /
 * callEndsTurn) keeps the turn going. The claim is read here without the
 * HMAC, but it can't be forged into a turn: the person's own channel entry
 * refuses every server token (lib/auth.ts assertTurnRunToken), and the
 * server's entry (serverCompactionAuth) takes the internal secret and
 * HMAC-verifies the token before a server turn starts.
 *
 * Our own definition, not `noReply()` from `eve/tools/no_reply`: that one ends
 * the turn unconditionally (`endsTurn: true`), and `eve/tools/no_reply` is
 * outside the eve-everywhere tripwire's subpath allow-set. The description is
 * adapted from eve's wording. `availableInSubagents: false` keeps it off any
 * delegated copy (eve ignores `endsTurn` there anyway, and on structured-output
 * turns); the declared helpers have their own tools/ and never get it.
 *
 * The app side: finishHomeTurn writes nothing when the turn ended on a
 * `no_reply` whose output says `ended: true` (home-turn.ts endedWithNoReply),
 * even if the model narrated a line before calling it.
 */
import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { runTokenFromAuth, serverFromRunToken } from '../lib/spec-client.js'

/** The tool's name (the file slug). Mirrored by src/lib/chat/home-turn.ts NO_REPLY_TOOL_NAME. */
export const NO_REPLY_TOOL_NAME = 'no_reply'

/** The server principal whose turns may end in silence. */
const HOME_TURN_SERVER = 'home_turn'

/** True when this turn's run token is a home turn's server token. Never throws. */
export function mayEndTurnSilently(auth: unknown): boolean {
  try {
    return serverFromRunToken(runTokenFromAuth(auth as never)) === HOME_TURN_SERVER
  } catch {
    return false
  }
}

/** What the call returns: `ended` decides whether the turn ends. */
export type NoReplyOutput = { ended: true } | { ended: false; note: string }

/** The answer on a turn a person started: not ended, answer them. */
export const NO_REPLY_REFUSED: NoReplyOutput = {
  ended: false,
  note: 'Not available: a person wrote to you. Answer them.',
}

export default defineTool({
  description:
    'End your turn without sending a reply. Only for a background update ([BACKGROUND UPDATE …]) that has nothing ' +
    'the person needs to hear now: the update already shows in the thread. When the person writes to you, never ' +
    'call this; answer them. Once it ends your turn, write nothing else.',
  availableInSubagents: false,
  inputSchema: z.object({
    reason: z.string().optional().describe('Why no reply is needed. Kept in the session history and traces; never sent.'),
  }),
  execute: (_input, ctx): NoReplyOutput =>
    mayEndTurnSilently(ctx?.session?.auth) ? { ended: true } : NO_REPLY_REFUSED,
  endsTurn: (output: NoReplyOutput) => output.ended === true,
})
