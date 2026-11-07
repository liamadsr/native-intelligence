/**
 * The per-turn context, as a user-role message (chat-ttft P3).
 *
 * The persona (./persona.ts) returns the spec's system prompt, which now holds
 * only what stays the same from turn to turn, so the provider can cache it and
 * the tool list after it. What changes per turn (the clock, the view,
 * attachments, mentions, the mail thread, the live meeting)
 * rides `spec.turnContext`; this resolver sends it as a `<turn-context>` block.
 * eve appends a user-role result to the session's durable history at the
 * turn's boundary, before the user's message, and never twice for a completed
 * step, so everything up to the new message stays a cached prefix.
 *
 * Only the sections that changed go out (and `time` always), measured against
 * the blocks already in the history this resolver is handed: see
 * ../lib/turn-context.ts. The `log` (A2b) goes out append-only instead: only
 * the lines past the cursor its last block carried, every line on a
 * conversation's first turn and near compaction. The `recent` exchange (A3)
 * goes out only on the first turn after a checkpoint. The `away` section (A6)
 * is diffed but never cleared. Two exceptions: a section whose layer failed to load
 * this turn (`spec.turnContextHeld`) is neither sent nor cleared, so a
 * transient read failure never tells the model its live meeting is over; and
 * once the pre-turn history nears eve's compaction threshold every present
 * section goes out again, since compaction would summarize the older blocks
 * away. That check is a history-only proxy for eve's real-token count, made
 * once at turn.started, so two gaps are left until the next turn restores
 * them: a turn that starts under the mark and crosses eve's threshold inside
 * its own tool loop loses the sections last sent in older blocks for the rest
 * of that turn, and a long tool loop can summarize this turn's own block. It
 * reads the turn's one memoized spec fetch, so it adds no request.
 *
 * ── Failure semantics: never throw ──────────────────────────────────────────
 * Any failure (no spec, a spec without turnContext from an older app, a
 * malformed one, anything unexpected) returns null: the turn runs without
 * fresh context, and the blocks already in history still stand. A spec
 * without turnContext also carries the full layered prompt, so nothing is
 * lost there.
 *
 * The device ask (a one-shot session) runs this too: eve dispatches
 * instruction resolvers on every turn.started, which is how that path gets the
 * clock.
 */
import { defineDynamic, defineInstructions } from 'eve/instructions'
import { fetchChatSpec, runTokenFromAuth, turnCtxFromAuth, validModelPolicy } from '../lib/spec-client.js'
import {
  firstTurnAfterCheckpoint,
  lastSentCursors,
  lastSentSections,
  nearCompaction,
  renderTurnContext,
  validHeldKeys,
  validTurnContext,
} from '../lib/turn-context.js'
import { recordCardContextSize, sectionTokens } from '../lib/card-context-size.js'

export default defineDynamic({
  events: {
    'turn.started': async (event, ctx) => {
      const turnId = turnIdOf(event)
      try {
        const runToken = runTokenFromAuth(ctx.session.auth)
        const turnCtx = turnCtxFromAuth(ctx.session.auth)
        const spec = await fetchChatSpec(runToken, turnCtx, { turnContext: true })
        const sections = validTurnContext(spec?.turnContext)
        if (!sections) return null
        const content = renderTurnContext(sections, lastSentSections(ctx.messages), {
          held: validHeldKeys(spec?.turnContextHeld),
          resendAll: nearCompaction(ctx.messages, validModelPolicy(spec?.modelPolicy)?.contextWindowTokens),
          cursors: lastSentCursors(ctx.messages),
          afterCheckpoint: firstTurnAfterCheckpoint(ctx.messages),
        })
        // What the cards note cost this turn, 0 when the diff left it out
        // (pages in the chat: measured, next to the turn's usage).
        const cardTokens = sectionTokens(content, 'cards')
        recordCardContextSize(turnId, cardTokens)
        if (cardTokens > 0) console.log(`[chat-agent] cards section: ~${cardTokens} tokens`)
        return content ? defineInstructions({ content, role: 'user' }) : null
      } catch (err) {
        console.error(`[chat-agent] turn context skipped: ${err instanceof Error ? err.message : String(err)}`)
        return null
      }
    },
  },
})

/** The turn id a turn.started event carries (`data.turnId`), or null. */
function turnIdOf(event: unknown): string | null {
  const id = (event as { data?: { turnId?: unknown } } | null)?.data?.turnId
  return typeof id === 'string' && id ? id : null
}
