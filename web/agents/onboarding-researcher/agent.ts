import { defineAgent } from 'eve'
import { researcherModel } from './lib/model.js'

/**
 * Onboarding research agent — Phase 1 (see docs/plans/eve-migration-plan.md).
 *
 * The FIRST real eve agent: when a user signs up, this agent researches them
 * (email domain -> company via web search/fetch) and seeds their workspace's
 * world model, streaming progress so the onboarding wizard can show a live
 * "getting to know you" experience. It runs UNATTENDED (no one may be watching
 * the stream), server-dispatched from POST /api/account/onboarding/research.
 *
 * Mounted as a dedicated top-level agent via the `agents:` form of withEve in
 * next.config.mjs, so its routes live at
 *   /eve/onboarding-researcher/v1/*
 * — its own mount. This isolation is deliberate: the researcher has a spend
 * guard and its own locked-down tool surface (the authored enrich/save/finish
 * tools, no sandbox). Web is NOT what separates it any more — web_search/
 * web_fetch are an always-on capability of every Native Intelligence agent. What IS unique
 * here is the pair of CRM enrichment tools, tools/enrich_company.ts and
 * tools/enrich_me.ts. Neither
 * talks to Exa itself: each POSTs to the Next app's internal
 * /api/internal/crm-enrichment route, which creates/links the row and runs the
 * app's ONE enrichment pipeline (src/lib/crm/enrichment.ts — an Exa Deep Search
 * plus fill-empty column write-back and a cited metadata blob). Going over HTTP
 * rather than reimplementing it here is the point: the eve compile bundles only
 * this agent's tree, so a local copy would fork the CRM's single source of truth
 * and drift. Those two calls are the primary company/person sources;
 * web_search/web_fetch corroborate them.
 *
 * Model (lib/model.ts): DeepSeek at chat's Light on the Vercel AI Gateway;
 * for a person on their own ChatGPT plan (the free tier), their plan, through
 * the app's plan proxy, with OpenAI's own web search.
 *
 * Spend guard: an unattended research run can't ask a human whether to keep
 * spending (at the token limit eve 0.78+ holds the turn on a session-limit
 * prompt that nobody answers), so cap output at 32k tokens/session — enough for a handful of
 * searches + a warm brief, not enough to run away.
 */
export default defineAgent({
  // Chat's Light on the Gateway, or a free user's own ChatGPT plan
  // (lib/model.ts).
  model: researcherModel,
  limits: {
    // eve 0.67+ parks every session after its turn (no task mode), for 30 days
    // by default. A research run is one turn the wizard reads to its end within
    // minutes, and nobody ever continues it, so it ends 30 minutes after creation.
    sessionTimeoutMs: 30 * 60 * 1_000,
    // Output is the runaway axis for a research loop (long briefs, repeated
    // tool calls). 32k is a generous ceiling for the intended shape: a few
    // web_search/web_fetch calls plus save_* tool calls plus one short brief.
    maxOutputTokensPerSession: 32_000,
  },
})
