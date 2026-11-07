/**
 * `delegate_work` — hand a piece of this run's work to a teammate and wait for
 * what they hand back (docs/plans/agent-orchestration-product.md, Part 3).
 *
 * ── How it works ─────────────────────────────────────────────────────────────
 * Gated `approval: always()`, like `request_user_input`: every call PAUSES the
 * turn at `input.requested` before `execute` runs. The work-run watcher
 * (src/lib/agent-run/run-work-eve.ts, delegation.ts) reads the call off the
 * event, checks it against the workspace's policy, starts a work run for the
 * teammate, and parks this run until that run settles. Nothing is created
 * here: this tool has no authority of its own.
 *
 * The approval is answered by the server, never by a person: at once when the
 * handoff is refused, or when the teammate's run settles. Only then does this
 * `execute` run, and it FETCHES what happened (by its own call id) and returns
 * it as this tool's result, so the model reads the teammate's summary and
 * deliverables (or the refusal and why) in its own history.
 *
 * Not a registry tool: it never reaches chat or MCP.
 */
import { defineTool } from 'eve/tools'
import { always } from 'eve/tools/approval'
import { z } from 'zod'
import { fetchDelegationResult, runTokenFromAuth } from '../lib/spec-client.js'

export default defineTool({
  description:
    'Hand one self-contained piece of your work to a teammate and PAUSE until they finish. ' +
    'Use it when part of the task is another role\'s job — most often asking the Researcher ' +
    'to find something out and write it up so you can use it — not for work you can do ' +
    'yourself with your own tools. Call it on its own in a step (never together with ' +
    'request_user_input), with a brief the teammate can act on without seeing your context: ' +
    'what to do, the names, facts and quotes they need, and what to hand back. You get their ' +
    'result as this tool\'s result: their summary, their deliverables (with ids you can open), ' +
    'and whether they produced what you asked for. A handoff can be refused (the workspace ' +
    'limits how much work can be handed on); then carry on without it.',
  inputSchema: z.object({
    role: z
      .enum(['researcher', 'writer', 'correspondent', 'developer'])
      .describe('Which teammate to hand this to. The researcher finds things out and writes them up.'),
    brief: z.object({
      task: z
        .string()
        .trim()
        .min(1)
        .describe('What the teammate should do, self-contained: they cannot see your conversation.'),
      context: z
        .string()
        .optional()
        .describe('The facts, names, quotes and links they need to do it well.'),
      hand_back: z
        .string()
        .optional()
        .describe('What you need back from them, in words (e.g. "a one-page brief with sources").'),
    }),
    expects: z
      .array(
        z.object({
          type: z.enum(['document', 'email_draft', 'action', 'entity']),
          min: z.number().int().min(0).max(20).optional(),
          entity_type: z.string().optional(),
        }),
      )
      .optional()
      .describe('The deliverables you need, e.g. [{"type":"document","min":1}]. Defaults to the role\'s usual one.'),
    resources: z
      .array(
        z.object({
          type: z.string().describe('The entity type, e.g. capture, document, contact, project.'),
          id: z.string().describe('Its id, exactly as a tool returned it.'),
          label: z.string().optional(),
        }),
      )
      .optional()
      .describe('Workspace items the teammate should read.'),
  }),
  approval: always(),
  async execute(_input, ctx) {
    const result = await fetchDelegationResult(runTokenFromAuth(ctx.session.auth), ctx.callId)
    const status = typeof result.status === 'string' ? result.status : 'unknown'
    const note =
      status === 'completed'
        ? 'The teammate finished. Use their result: open a deliverable with its id when you need its content. If expects_met is false, they did not produce everything you asked for; decide whether you can finish without it.'
        : status === 'refused'
          ? 'The handoff was refused, for the reason given. Carry on without it: do the part yourself if you can, or say in your summary what is missing.'
          : status === 'failed' || status === 'canceled'
            ? 'The teammate did not finish. Carry on without their result, and say so in your summary.'
            : 'The result of this handoff could not be read. Carry on without it, and say so in your summary.'
    return { ...result, note }
  },
})
