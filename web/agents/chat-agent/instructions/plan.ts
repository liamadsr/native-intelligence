/**
 * The plan, re-shown after a checkpoint (A4 slice 1; recitation, the way the
 * expertise packs are re-sent: ./expertise.ts).
 *
 * update_plan (../tools/update_plan.ts) keeps the main chat's plan in durable
 * state and returns the whole plan on every call, which re-states it inside a
 * turn. A checkpoint (eve's compaction) can summarize every one of those calls
 * away between turns. At a turn's start this resolver sends the plan again as
 * a user-role message when a checkpoint left the model unable to see it and
 * it still has open steps (../lib/plan.ts planRecitationDue: once per
 * compaction cycle, read off the history alone), unless the plan is
 * abandoned (planIsStale: too many turns or too long since it was written).
 * It first counts this turn toward that (noteTurnStarted, by turn id). Not a turn-context section:
 * those are built by the app, and the plan lives in this agent's state.
 *
 * Never throws: any failure sends nothing, and the history stands.
 */
import { defineDynamic, defineInstructions } from 'eve/instructions'
import { currentPlan, noteTurnStarted, planRecitation } from '../lib/plan.js'

/** The turn id a turn.started event carries (`data.turnId`), or null. */
function turnIdOf(event: unknown): string | null {
  const id = (event as { data?: { turnId?: unknown } } | null)?.data?.turnId
  return typeof id === 'string' && id ? id : null
}

export default defineDynamic({
  events: {
    'turn.started': async (event, ctx) => {
      try {
        noteTurnStarted(turnIdOf(event))
        const content = planRecitation(currentPlan(), ctx.messages, new Date())
        return content ? defineInstructions({ content, role: 'user' }) : null
      } catch (err) {
        console.error(`[chat-agent] plan recitation skipped: ${err instanceof Error ? err.message : String(err)}`)
        return null
      }
    },
  },
})
