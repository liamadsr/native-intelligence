/**
 * finish_work — the mandatory TERMINAL tool for every work run, and the ONLY way
 * to end one. It POSTs the run outcome to the SHARED internal agent-run outcome
 * route, which (server-side, under the run's verified token) settles the run's
 * terminal state, moves the tracked action to REVIEW (never Done: the person
 * marks it Done, decision 9 — src/lib/actions/agent-finish.ts), and
 * files the `work_run_ready` notification — the SINGLE writer of the terminal
 * state (docs/loop-engine/WORK-PROPOSALS-DESIGN.md).
 *
 * TENANCY: the run token is read from the verified session principal
 * (runTokenFromAuth) — NEVER from model input. The model supplies only the
 * outcome CONTENT (the summary + the deliverables it actually created). It cannot
 * name a workspace, an action, or a run.
 *
 * HONESTY CONTRACT: `deliverables` must be the artifacts the run REALLY produced —
 * every id comes from a tool RESULT (the canonical id the tool returned), never
 * invented. An empty deliverables list is valid (the run may have concluded no
 * artifact was warranted); a FABRICATED id is not.
 *
 * IDEMPOTENCY / RACE: on a 409 (the run was already terminally settled — e.g. the
 * watcher marked it canceled after a stream abort), the route returns "already
 * settled"; this tool relays that to the model so it stops rather than retrying.
 * A re-POST of the same outcome returns 200.
 */
import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { runTokenFromAuth, postWorkOutcome } from '../lib/spec-client.js'

export default defineTool({
  description:
    'End the work run. Call this EXACTLY ONCE, at the very end, after you have ' +
    'completed the work with your tools. Provide an honest one-paragraph summary ' +
    'of what you did, and list the deliverables you ACTUALLY produced — each with ' +
    "the id the tool returned (never invented). Use type 'email_draft' for a " +
    "created email draft, 'document' for a created/edited document, 'action' for " +
    "a board action you created or updated, and 'entity' (with entity_type) for " +
    'any other workspace entity. If you produced no artifact, pass an empty list. ' +
    'This is the only way to finish the run.',
  inputSchema: z.object({
    summary: z
      .string()
      .min(1)
      .describe('A short, honest summary of what you did (or attempted). Always required.'),
    deliverables: z
      .array(
        z.object({
          type: z
            .enum(['email_draft', 'document', 'action', 'entity'])
            .describe("The artifact kind. Use 'entity' for anything not draft/document/action."),
          id: z.string().min(1).describe('The id the tool returned for this artifact. Never invent one.'),
          label: z.string().min(1).describe('A short human label for the artifact (e.g. its title).'),
          entity_type: z
            .string()
            .optional()
            .describe("For type 'entity': the entity kind, e.g. 'contact', 'claim', 'project'."),
        }),
      )
      .describe('The artifacts you actually created or updated. Empty list if none.'),
  }),
  async execute(input, ctx) {
    const runToken = runTokenFromAuth(ctx.session.auth)
    const outcome = await postWorkOutcome(runToken, {
      summary: input.summary,
      deliverables: input.deliverables,
    })

    if (outcome.alreadySettled) {
      // The run reached a terminal state elsewhere (typically canceled by the
      // watcher). Nothing more to do — tell the model to stop.
      return {
        settled: true,
        alreadySettled: true,
        message: outcome.message ?? 'This run was already settled; stop now.',
      }
    }
    if (!outcome.settled) {
      // The settle failed for a non-409 reason (route/network). Surface it so the
      // model can decide whether to retry finish_work once.
      return { settled: false, error: outcome.error ?? 'failed to settle the run' }
    }
    return { settled: true, message: outcome.message ?? 'Run settled.' }
  },
})
