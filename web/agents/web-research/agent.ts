import { defineAgent, defineDynamic } from 'eve'
import { planSearchStepSelection, planTurnSelection } from './lib/chatgpt-plan-model.js'
import {
  chatGptPlanProxy,
  fetchWebResearchSpec,
  runTokenFromAuth,
  stepCeilingError,
  stepIndexOf,
  webResearchPlan,
} from './lib/spec-client.js'

/**
 * Web-research agent: Exa's deep search, on a free user's own ChatGPT plan
 * (docs/plans/chatgpt-free-tier-handoff.md, 3g). Prospecting, CRM
 * enrichment and the ICP card search the web through Exa (src/lib/exa/
 * deep-search.ts), which Dial8 pays for and so never runs for a free user.
 * For them the app sends the same query and card schema here
 * (src/lib/web-research/plan-deep-search.ts), and this agent answers it with
 * OpenAI's own web search on their plan, a citation per field, in Exa's shape.
 *
 * Every session is one utility call (runUtilityTask, a kind whose spec names
 * this agent: plan_web_search): the same signed token, spec route and
 * internal secret as the utility agent. It is its own agent because it has
 * the web and the utility agent must not: a utility prompt is built from
 * workspace data and written back into the workspace.
 *
 * Model: the person's plan only. session.started selects the plan's guard
 * (the Gateway serves it from no host), and every step runs on the plan's
 * search model through the plan proxy, which eve reads as OpenAI's own, so
 * tools/web_search.ts is OpenAI's hosted search. Both resolvers throw for a
 * spec that isn't this agent's or isn't on the plan (webResearchPlan), which
 * eve turns into a failed session: nothing here can run on Dial8's models.
 * The step resolver also holds the kind's step ceiling.
 *
 * Its steps are named `openai/<plan model>`; nothing reads them. The app logs
 * the call itself, under the plan's name at no cost.
 *
 * Mounted via the `agents:` map in next.config.mjs → /eve/web-research/v1/*.
 */
export default defineAgent({
  model: defineDynamic({
    events: {
      'session.started': async (_event, ctx) => {
        const plan = webResearchPlan(await fetchWebResearchSpec(runTokenFromAuth(ctx.session.auth)))
        if (plan instanceof Error) throw plan
        return planTurnSelection(plan)
      },
      'step.started': async (event, ctx) => {
        const runToken = runTokenFromAuth(ctx.session.auth)
        const spec = await fetchWebResearchSpec(runToken)
        const plan = webResearchPlan(spec)
        if (plan instanceof Error) throw plan
        const overCeiling = stepCeilingError(spec!, stepIndexOf(event, ctx.messages))
        if (overCeiling) throw overCeiling
        return planSearchStepSelection(plan, chatGptPlanProxy(runToken))
      },
    },
  }),
  limits: {
    // One call, read and retired by runUtilityTask within its kind's clock
    // (180 s); this is the backstop for a session it could not retire.
    sessionTimeoutMs: 10 * 60 * 1_000,
    // Backstops behind the step ceiling, checked between steps. A card answer
    // is a few hundred tokens, a discovery list (20 companies, each field
    // cited) several thousand, reasoning included; search results arrive as
    // input, a few thousand tokens a search.
    maxOutputTokensPerSession: 32_000,
    maxInputTokensPerSession: 400_000,
  },
  experimental: {
    workflow: {
      // PRIVACY: keep no run data once a session ends (the message names the
      // person or company researched, and the answer is CRM data). Nothing
      // reads a session after its turn: the dispatcher reads the answer off
      // the live stream, then retires it (agents/utility/agent.ts).
      retention: 0,
    },
  },
})
