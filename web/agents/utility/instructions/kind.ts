/**
 * The call's system instructions, per kind (WS-4).
 *
 * Each generator's system prompt (a chat-title rule set, the claim-extraction
 * rules, a tone-templated email brief, …) is rebuilt by the Next app's
 * internal spec route from the call's signed token and returned here with
 * genuine SYSTEM-prompt semantics — the same role it had as `instructions:` on
 * the old generateText/generateObject call. It layers after the static
 * contract in ../instructions.md.
 *
 * Resolves once per session. A kind with no system prompt (generate_title
 * always sent a single prompt) returns null and contributes nothing. A FAILED
 * fetch throws — fail closed, independently of the model resolver: the spec
 * memo can evict (or drop a failure) between the two resolvers, and a kind
 * must never run with the model but without its rules (claim extraction's
 * grounding, outreach's "never invent facts").
 */
import { defineDynamic, defineInstructions } from 'eve/instructions'
import { fetchUtilitySpec, runTokenFromAuth } from '../lib/spec-client.js'

export default defineDynamic({
  events: {
    'session.started': async (_event, ctx) => {
      const spec = await fetchUtilitySpec(runTokenFromAuth(ctx.session.auth))
      if (!spec) throw new Error('[utility] no spec for this session — refusing to run without its instructions')
      if (!spec.systemPrompt) return null
      return defineInstructions({ content: spec.systemPrompt })
    },
  },
})
