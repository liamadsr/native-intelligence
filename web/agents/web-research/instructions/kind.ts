/**
 * The call's system instructions, from its spec (the utility spec route's,
 * rebuilt from the signed token): the kind's research rules
 * (PLAN_WEB_RESEARCH_PROMPT), layered after the static contract in
 * ../instructions.md. A failed fetch throws, independently of the model
 * resolver: a session must never search without its rules (cite every field,
 * never invent one, stay on the sites it was given).
 */
import { defineDynamic, defineInstructions } from 'eve/instructions'
import { fetchWebResearchSpec, runTokenFromAuth } from '../lib/spec-client.js'

export default defineDynamic({
  events: {
    'session.started': async (_event, ctx) => {
      const spec = await fetchWebResearchSpec(runTokenFromAuth(ctx.session.auth))
      if (!spec) throw new Error('[web-research] no spec for this session — refusing to run without its instructions')
      if (!spec.systemPrompt) return null
      return defineInstructions({ content: spec.systemPrompt })
    },
  },
})
