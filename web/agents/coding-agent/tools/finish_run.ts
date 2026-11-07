/**
 * finish_run — the mandatory TERMINAL tool for every coding run, and the ONLY
 * way to end one. A pr_open goes through the reviewer first (P10 F6): its
 * changesRequested answer settles nothing, and the model calls again after
 * fixing. It POSTs the run outcome to the internal outcome route, which
 * (server-side, under the run's verified token) settles agent_run terminally,
 * opens the GitHub PR when `pr` is present, and links it — the SINGLE writer of
 * the terminal state + PR link (the design doc consolidates today's three racing
 * writers to this one).
 *
 * TENANCY: the run token is read from the verified session principal
 * (runTokenFromAuth) — NEVER from model input. The model supplies only the
 * outcome CONTENT (result/summary/error and the PR title/body/head/base). It
 * cannot name a workspace, a repo, or a run.
 *
 * IDEMPOTENCY / RACE: on a 409 (the run was already terminally settled with a
 * different outcome — e.g. the watcher marked it canceled/failed after a stream
 * abort), the route returns "already settled"; this tool relays that to the model
 * so it stops rather than retrying. A re-POST of the SAME outcome returns 200.
 */
import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { runTokenFromAuth, postOutcome } from '../lib/spec-client.js'

export default defineTool({
  description:
    'End the coding run, at the very end, after you have committed and pushed ' +
    'your branch. Set result to "pr_open" when you want a pull request opened ' +
    '(provide the pr object), "completed" when the work is done but no PR is ' +
    'needed, or "failed" when you could not complete it (put the reason in ' +
    'error). Before a pull request opens, an independent reviewer reads your ' +
    'diff: when it answers changesRequested, the run is NOT finished: make the ' +
    'changes it lists, commit, push, and call finish_run again (at most two ' +
    'rounds). Any other answer ends the run. The pull request is opened for you ' +
    'by the system — do not open it yourself. This is the only way to finish ' +
    'the run.',
  inputSchema: z.object({
    result: z
      .enum(['pr_open', 'completed', 'failed'])
      .describe('"pr_open" (open the PR), "completed" (done, no PR), or "failed".'),
    summary: z
      .string()
      .min(1)
      .describe('A short summary of what you did (or attempted). Always required.'),
    error: z
      .string()
      .optional()
      .describe('When result is "failed", a concise reason the run could not complete.'),
    pr: z
      .object({
        title: z.string().min(1).describe('The pull request title.'),
        body: z.string().describe('The pull request body (markdown).'),
        head: z.string().min(1).describe('The branch you pushed (the head of the PR).'),
        base: z.string().min(1).describe('The base branch to merge into (e.g. main).'),
      })
      .optional()
      .describe('Provide ONLY when result is "pr_open" — the PR the system should open.'),
  }),
  async execute(input, ctx) {
    const runToken = runTokenFromAuth(ctx.session.auth)
    const outcome = await postOutcome(runToken, {
      result: input.result,
      summary: input.summary,
      error: input.error,
      pr: input.pr,
    })

    if (outcome.alreadySettled) {
      // The run reached a terminal state elsewhere (typically canceled by the
      // watcher). Nothing more to do — tell the model to stop.
      return {
        settled: true,
        alreadySettled: true,
        message: outcome.message ?? 'This run was already settled; stop now.',
        prUrl: outcome.prUrl ?? null,
      }
    }
    if (outcome.changesRequested) {
      // The reviewer sent it back before the PR opened (P10 F6). Not settled.
      return {
        settled: false,
        changesRequested: true,
        message: outcome.message ?? 'The reviewer requested changes.',
      }
    }
    if (outcome.reviewStopped) {
      // Settled without a PR: rejected, or still not right after two rounds. Stop.
      return { settled: true, prUrl: null, message: outcome.message ?? 'No pull request was opened; stop now.' }
    }
    if (!outcome.settled) {
      // The settle failed for a non-409 reason (route/network). Surface it so the
      // model can decide whether to retry finish_run once.
      return { settled: false, error: outcome.error ?? 'failed to settle the run' }
    }
    return {
      settled: true,
      prUrl: outcome.prUrl ?? null,
      message: outcome.message ?? 'Run settled.',
    }
  },
})
