/**
 * `ask_user` — the live agent's clarifying question (LIVE-AGENT-DESIGN §6.2/§6.3).
 *
 * NON-BLOCKING, exactly as on the cloud route: the real tool (createLiveAgentTools'
 * ask_user, run by POST /api/internal/live-agent/tool) writes the question into
 * the capture's chat as a clickable picker and returns at once —
 * `{ asked: true }`, or `{ asked: false }` while an earlier question is still
 * unanswered (its hasPendingLiveQuestion gate runs inside that execute,
 * unchanged). The user answers in the chat on their own time; the NEXT turn's
 * fresh context picks the answer up.
 *
 * Deliberately NOT chat-agent's `approval: always()` shape: every live turn is
 * one turn read to its boundary within seconds and never continued. An approval
 * would hold the turn at `turn.waiting` (eve 0.70+) with nobody to answer it, so
 * the turn would end with no answer. Keeping it a plain tool preserves today's
 * behavior.
 *
 * A dynamic resolver (not a static tool) so the ceiling stays STRUCTURAL: it is
 * returned only when this turn's ceiling holds ask_user — a paired notes turn's
 * never does (the copilot owns the user's ear), so there the tool does not exist.
 * The description + input schema are the real tool's, off the spec.
 * tools/workspace_tools.ts never proxies this name.
 */
import { defineDynamic, defineTool } from 'eve/tools'
import { z } from 'zod'
import { dispatchLiveAgentTool, fetchLiveAgentSpec, runTokenFromAuth } from '../lib/spec-client.js'

/** Permissive FALLBACK schema — only when the spec carries no real one. */
const passThroughInput = z.record(z.string(), z.unknown())

export default defineDynamic({
  events: {
    'session.started': async (_event, ctx) => {
      const runToken = runTokenFromAuth(ctx.session.auth)
      const spec = await fetchLiveAgentSpec(runToken)
      const entry = spec?.ceilingTools.find((t) => t.name === 'ask_user')
      if (!entry) return null // not in this turn's ceiling (or no spec) → absent
      return defineTool({
        description: entry.description,
        inputSchema: entry.inputSchema ?? passThroughInput,
        execute: (input) => dispatchLiveAgentTool('ask_user', runToken, input),
      })
    },
  },
})
