/**
 * post_progress — append a log/progress line to the run's log_tail so the
 * (polling) Cloud-run UI can show live progress, AND read back the cancel signal.
 *
 * The event route's response carries `{ canceling }` — the log pump doubles as
 * the cancel channel (design doc §Cancel). When the run has been asked to cancel,
 * this tool returns a HARD STOP instruction so the model halts immediately: it
 * must do no further work and must NOT call finish_run (the watcher settles the
 * row to `canceled`; a late finish_run would 409 anyway).
 *
 * TENANCY: the run token is read from the verified session principal
 * (runTokenFromAuth) — never from model input. The model supplies only the text.
 */
import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { runTokenFromAuth, postEvent } from '../lib/spec-client.js'

export default defineTool({
  description:
    'Report progress on the run. Call this periodically as you work (what you are ' +
    'exploring, implementing, or about to do) so the run is observable. If the ' +
    'response tells you the run is being canceled, STOP immediately — do no ' +
    'further work and do not call finish_run.',
  inputSchema: z.object({
    text: z
      .string()
      .min(1)
      .describe('A short progress note describing what you are doing right now.'),
    kind: z
      .enum(['log', 'progress'])
      .default('progress')
      .describe('"progress" for a status beat (default), "log" for raw output.'),
  }),
  async execute(input, ctx) {
    const runToken = runTokenFromAuth(ctx.session.auth)
    const { canceling } = await postEvent(runToken, input.kind, input.text)
    if (canceling) {
      return {
        canceling: true,
        instruction:
          'This run has been CANCELED. STOP now: do no further work, make no more ' +
          'tool calls, and do NOT call finish_run. End your turn immediately.',
      }
    }
    return { canceling: false, ok: true }
  },
})
