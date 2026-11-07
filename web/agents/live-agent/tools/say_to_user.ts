/**
 * `say_to_user` — the live agent's proactive nudge (LIVE-AGENT-DESIGN §6.1).
 * Chat has no analogue.
 *
 * The real tool (createLiveAgentTools' say_to_user, run by POST
 * /api/internal/live-agent/tool) does TWO deliveries under ONE id: an
 * assistant chat message (appendAgentMessage, every delivered nudge) AND an
 * ephemeral Realtime nudge to the floating HUD (broadcastNudge on
 * agent-nudge:<captureId>), with its drop telemetry. Both run inside that
 * execute, exactly as they do for the cloud route and /stage — this file only
 * dispatches to it.
 *
 * A dynamic resolver (not a static tool) so the ceiling stays STRUCTURAL: it is
 * returned only when this turn's ceiling holds say_to_user — a paired notes
 * turn's never does, so two agents on one call can never both speak. The
 * description + input schema are the real tool's, off the spec.
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
      const entry = spec?.ceilingTools.find((t) => t.name === 'say_to_user')
      if (!entry) return null // not in this turn's ceiling (or no spec) → absent
      return defineTool({
        description: entry.description,
        inputSchema: entry.inputSchema ?? passThroughInput,
        execute: (input) => dispatchLiveAgentTool('say_to_user', runToken, input),
      })
    },
  },
})
