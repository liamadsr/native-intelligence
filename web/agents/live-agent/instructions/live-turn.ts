/**
 * Dynamic instructions for the live-agent — the turn's REAL system prompt.
 *
 * The 7-layer composition (base mechanics or the assist-only base, web-access
 * guidance, recipe preamble, persona, notes-pairing rider, batch riders) is
 * rebuilt server-side by GET /api/internal/live-agent/spec with the SAME code
 * the cloud route runs, and returned here VERBATIM as system-role instructions.
 * There is deliberately no static instructions.md: this resolver is the whole
 * prompt, so nothing is layered in front of the route's text.
 *
 * Resolves once per session (session.started) — a live session is one turn. On
 * a spec failure it returns null (logged by the spec client); the tools resolver
 * fails the same way, so a spec-less turn can write nothing.
 */
import { defineDynamic, defineInstructions } from 'eve/instructions'
import { fetchLiveAgentSpec, runTokenFromAuth } from '../lib/spec-client.js'

export default defineDynamic({
  events: {
    'session.started': async (_event, ctx) => {
      const spec = await fetchLiveAgentSpec(runTokenFromAuth(ctx.session.auth))
      if (!spec?.systemPrompt) return null
      return defineInstructions({ content: spec.systemPrompt })
    },
  },
})
