/**
 * finish: the end of the request, with a summary. Ends the turn (endsTurn);
 * the session stays open, so a later message can ask for more. The launcher
 * turns the call into a `finish` event, and in an edit job the desktop
 * commits the worktree on it, outside the sandbox.
 *
 * A Mac host slot (contract C2): the Mac build adds it to the Dial8 agent as
 * tools/finish.ts (scripts/local-agent/mac-body.sh); the cloud body has none.
 *
 * `pull_request` (C5): in an edit job, when the request asks for one, the call
 * asks the person on their Mac (a native prompt, launcher/prompts.ts) before
 * anything leaves it. The desktop commits as soon as this call is the only one
 * running, so the prompt names the commit; on yes it pushes that commit as the
 * person and opens the pull request (gh, or the server with their Dial8 GitHub
 * sign-in), and reports the link itself. The agent never sees a credential.
 */
import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { macToolGuard } from '../../chat-agent/lib/mac-guard.js'
import { askPerson } from '../launcher/prompts.js'

const OUTCOME_NOTES = {
  allowed: 'The person said yes: the app pushes the branch and opens the pull request, and the link shows in this conversation.',
  denied: 'The person said no: the branch stays on their Mac with your commit. Do not ask again unless they do.',
  timeout: 'The person did not answer in time: the branch stays on their Mac with your commit.',
  unavailable: 'There is no one to ask on this Mac right now: the branch stays on their Mac with your commit.',
  invalid: 'The title or body could not be shown (a title is 1–256 characters, a body at most 60,000).',
} as const

export default defineTool({
  description:
    'Finish the request: give a summary of what you found or did, including anything that was blocked. ' +
    'Call it once the request is done. In a job that may change files, add pull_request only when the request asks for a pull request.',
  endsTurn: true,
  inputSchema: z.object({
    summary: z.string().min(1).max(8000).describe('What you found or did, for the person and the Dial8 agent. In a job that changes files, its first line becomes the commit message.'),
    pull_request: z
      .object({
        title: z.string().min(1).max(256).describe('The pull request title.'),
        body: z.string().max(60_000).optional().describe('The pull request description, in Markdown.'),
      })
      .optional()
      .describe('Only when the request asks for a pull request, and only in a job that may change files. The person is asked on their Mac first.'),
  }),
  async execute({ pull_request }, ctx) {
    // No push prompt after a Stop (../../chat-agent/lib/mac-guard.ts). The
    // desktop's local commit follows the launcher's `finish` event, sent when
    // the call is requested, so this check does not stop that commit; nothing
    // leaves the Mac without the prompt.
    await macToolGuard(ctx.session?.auth)
    if (!pull_request) return { ok: true }
    if (process.env.LOCAL_AGENT_MODE !== 'edit') {
      return { ok: true, pullRequest: { asked: false, note: 'This job is read-only: there is no branch to push.' } }
    }
    const outcome = await askPerson('push', pull_request.body === undefined ? { title: pull_request.title } : { title: pull_request.title, body: pull_request.body })
    return { ok: true, pullRequest: { asked: outcome.reason !== 'invalid' && outcome.reason !== 'unavailable', allowed: outcome.allowed, note: OUTCOME_NOTES[outcome.reason] } }
  },
})
