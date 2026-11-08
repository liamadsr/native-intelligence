import { defineAgent, defineDynamic } from 'eve'
import {
  fetchUtilitySpec,
  modelSelectionFor,
  runTokenFromAuth,
  stepCeilingError,
  stepIndexOf,
  stepModelSelectionFor,
} from './lib/spec-client.js'

/**
 * Utility agent — the eve home of every one-shot generation (WS-4 of the eve
 * migration): capture and chat titles, skill descriptions, meeting follow-ups,
 * email reply and outreach drafts, knowledge briefs, claim extraction, the
 * knowledge weaver's two judges, reference ingest's PDF classify and
 * per-segment structuring calls, and note continuation (the one kind whose
 * dispatcher streams the answer's text deltas back to the browser).
 *
 * Every session is ONE one-shot generation dispatched server-to-server by
 * src/lib/eve/utility/run-utility.ts. A `kind` in the call's signed token says
 * which generator it is; the Next app's internal spec route turns the token
 * into the model, the kind's system prompt and provider options. Nothing here
 * knows about kinds — it forwards.
 *
 * No tools. Every framework default is disabled under tools/ (bash, file
 * tools, web_search, web_fetch, agent; eve adds its `eve__task_wait` /
 * `eve__task_cancel` only to an agent with a task-running tool, so with `agent`
 * off there are none): a one-shot generator has
 * nothing to call, and web access would be pure liability for prompts built
 * from workspace data. The user prompt arrives as the task message and the
 * answer is the final message (or the outputSchema result).
 *
 * Model: resolved at session.started from the spec, and again at step.started
 * (step wins). The step resolver does two jobs:
 *   - the per-call OUTPUT CAP: kinds whose pre-port call sent
 *     `maxOutputTokens` (knowledge_brief, the reference-ingest calls) get a
 *     Gateway model wrapped to enforce it, and eve only accepts a live model
 *     object from step.started;
 *   - the STEP CEILING: it throws once the step index reaches the kind's
 *     maxSteps (1 for text kinds, 2 for structured ones), so a truncated or
 *     malformed structured answer gets one repair, not a loop that re-sends
 *     the whole message (for reference ingest, the PDF) until a session
 *     token limit trips. eve dispatches this event once per model step; a
 *     call eve re-issues WITHIN a step (once on an empty response, or on a
 *     transient error) does not pass through here again, so the bound on
 *     completed model calls is 2 × maxSteps.
 * A call on the person's own ChatGPT plan (spec.chatgptPlan, the free tier)
 * runs every step on the plan model through the app's plan proxy, under the
 * same contract, and its session selection is the plan's guard, which the
 * Gateway serves from no host (lib/chatgpt-plan-model.ts).
 * The session resolver
 * keeps a serializable selection in place for anything eve does before the
 * first step. There is no default model on purpose — a session whose spec
 * can't be fetched would run a kind without its instructions, so both
 * resolvers THROW instead, which eve turns into a failed turn (a failed task
 * session). The dispatcher then throws, and each call site handles that
 * exactly like the model call failing before.
 *
 * Mounted via the `agents:` map in next.config.mjs → /eve/utility/v1/*.
 */
const NO_SPEC = '[utility] no spec for this session — refusing to run without its instructions'

export default defineAgent({
  model: defineDynamic({
    events: {
      'session.started': async (_event, ctx) => {
        const spec = await fetchUtilitySpec(runTokenFromAuth(ctx.session.auth))
        if (!spec) throw new Error(NO_SPEC)
        return modelSelectionFor(spec)
      },
      'step.started': async (event, ctx) => {
        const spec = await fetchUtilitySpec(runTokenFromAuth(ctx.session.auth))
        if (!spec) throw new Error(NO_SPEC)
        const overCeiling = stepCeilingError(spec, stepIndexOf(event, ctx.messages))
        if (overCeiling) throw overCeiling
        return stepModelSelectionFor(spec, runTokenFromAuth(ctx.session.auth))
      },
    },
  }),
  limits: {
    // eve 0.67+ parks every session after its turn (no task mode), for 30 days
    // by default. A utility session is one generation, read and done within its
    // kind's timeout (at most 270 s, src/lib/eve/utility/spec.ts). runUtilityTask
    // and streamUtilityText retire it as soon as the answer is read; this
    // timeout is the backstop for a session they could not retire. Either way
    // the run then ends, and with `experimental.workflow.retention: 0` below its
    // stored data (which holds the prompt, e.g. mail text) is deleted at once.
    sessionTimeoutMs: 10 * 60 * 1_000,
    // Backstops behind the step ceiling above, NOT per-call caps: eve checks
    // session usage limits BETWEEN model steps, after a step's usage arrives,
    // so neither can cut a single generation short (the per-kind output cap
    // does that). They stop a session from STARTING another model call once
    // it has spent this much: eve 0.78+ then parks the turn on a continuation
    // prompt (turn.waiting) that nobody answers, which runUtilityTask reads as
    // a failure (status `waiting`) and cancels.
    maxOutputTokensPerSession: 32_000,
    // The largest legitimate session is a 25-page reference-ingest segment
    // (~1.5–3k input tokens a page, so ≤ ~75k) plus one repair step. The
    // framework default is 40M.
    maxInputTokensPerSession: 400_000,
  },
  experimental: {
    workflow: {
      // PRIVACY: keep no run data once a utility session ends. Utility prompts
      // carry workspace content, including mail bodies (memory_learn_mail_tone,
      // email_draft_reply), and Native Intelligence never stores mail text. Without this, eve
      // keeps the run input, history checkpoints, model-step payloads, the
      // reply tool input and the event stream in Workflow storage for the
      // plan's retention period (1–30 days) after the session ends. `0` deletes
      // them as soon as the run completes or fails (eve 0.53.1+, see
      // node_modules/eve/docs/agent-config.md "Run data retention"). Safe here
      // because nothing reads a utility session after its turn: the dispatcher
      // reads the answer off the live stream, then retires the session.
      // Pinned by agents/utility/lib/__tests__/privacy-contract.test.ts.
      retention: 0,
    },
  },
})
