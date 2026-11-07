/**
 * Dynamic instructions for the work-agent (Loops v3 work proposals).
 *
 * The run's base workspace system prompt (buildSystemPrompt for the run-as user —
 * who the workspace is, its conventions), followed by the teammate's persona and
 * skills when a teammate does the work (B PR 4, composeWorkRunSystemPrompt), is
 * rebuilt server-side and fetched over the internal work-run spec route. Returning it as `defineInstructions` gives it
 * genuine SYSTEM-PROMPT semantics (the invariant: same prompts as system prompts,
 * NOT degraded into user text). The generic standing contract in
 * ../instructions.md stays; this per-run base workspace prompt layers on top.
 *
 * The per-run TASK is NOT layered here — it rides as the session's first user
 * MESSAGE (the JSON brief), because the task is fire-ephemeral (the specific
 * approval's instructions + resources), while the base prompt is stable and
 * cacheable per model (session.started resolves once — prompt caches are per
 * model). On a fetch failure this returns null: a throwing instructions
 * resolver would be skipped, not fatal, so the model resolver (agent.ts) is what
 * refuses a session without its spec.
 */
import { defineDynamic, defineInstructions } from 'eve/instructions'
import { fetchEveSpec, runTokenFromAuth } from '../lib/spec-client.js'

export default defineDynamic({
  events: {
    'session.started': async (_event, ctx) => {
      const runToken = runTokenFromAuth(ctx.session.auth)
      const spec = await fetchEveSpec(runToken)
      if (!spec?.systemPrompt?.trim()) return null
      return defineInstructions({ markdown: spec.systemPrompt.trim() })
    },
  },
})
