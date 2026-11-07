/**
 * Dynamic instructions for the skill-runner agent (Phase 2).
 *
 * The run's REAL system prompt — the headless preamble + the skill's
 * persona/context_rules/response_style + the app's base system prompt, layered
 * EXACTLY as the gateway path does (buildSkillSystemPrompt) — is rebuilt
 * server-side and fetched over the internal spec route. Returning it as
 * `defineInstructions` gives it genuine SYSTEM-PROMPT semantics (the invariant:
 * same prompts as system prompts, NOT degraded into user text). The generic
 * static contract in ../instructions.md stays; this per-run persona layers on top.
 *
 * Resolves once per session (session.started) — prompt caches are per model, so
 * a stable session prompt maximizes cache hits. On a fetch failure it returns
 * null: a throwing instructions resolver would be skipped, not fatal, so the
 * model resolver (agent.ts) is what refuses a session without its spec.
 */
import { defineDynamic, defineInstructions } from 'eve/instructions'
import { fetchEveSpec, runTokenFromAuth } from '../lib/spec-client.js'

export default defineDynamic({
  events: {
    'session.started': async (_event, ctx) => {
      const runToken = runTokenFromAuth(ctx.session.auth)
      const spec = await fetchEveSpec(runToken)
      if (!spec?.systemPrompt) return null
      return defineInstructions({ markdown: spec.systemPrompt })
    },
  },
})
