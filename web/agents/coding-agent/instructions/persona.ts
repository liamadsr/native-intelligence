/**
 * Dynamic instructions for the coding-agent (Phase 3).
 *
 * The run's REAL system prompt — the composed agent persona (recipe system_prompt
 * + attached skills, layered on the base coding-workflow instructions by the
 * composeEveCodingSystemPrompt) — PLUS the run's task prompt (the XML issue
 * block) are rebuilt server-side and fetched over the internal spec route.
 * Returning them as `defineInstructions` gives them genuine SYSTEM-PROMPT
 * semantics (the invariant: same prompts as system prompts, NOT degraded into
 * user text). The generic static contract in ../instructions.md stays; this
 * per-run persona + task layers on top.
 *
 * Composition order: persona first (who you are / how to work), then the task
 * (what to do). The task is delivered here as a system instruction rather than as
 * the session's first user message so the whole run prompt is stable and
 * cacheable per model (session.started resolves once — prompt caches are per
 * model). On any fetch failure it returns null (the static instructions.md alone
 * remains), so a run degrades rather than crashes.
 */
import { defineDynamic, defineInstructions } from 'eve/instructions'
import { fetchEveSpec, runTokenFromAuth } from '../lib/spec-client.js'

export default defineDynamic({
  events: {
    'session.started': async (_event, ctx) => {
      const runToken = runTokenFromAuth(ctx.session.auth)
      const spec = await fetchEveSpec(runToken)
      if (!spec) return null
      const sections: string[] = []
      if (spec.systemPrompt?.trim()) sections.push(spec.systemPrompt.trim())
      if (spec.taskPrompt?.trim()) {
        sections.push(`# Your task for this run\n\n${spec.taskPrompt.trim()}`)
      }
      if (sections.length === 0) return null
      return defineInstructions({ markdown: sections.join('\n\n') })
    },
  },
})
