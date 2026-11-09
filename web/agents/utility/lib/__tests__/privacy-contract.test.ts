/**
 * Privacy contract for the utility mount: a utility session keeps no mail text.
 *
 * Utility prompts carry workspace content, including mail bodies (the nightly
 * mail-tone pass `memory_learn_mail_tone`, reply drafting
 * `email_draft_reply`), and Native Intelligence never stores mail text. Two settings make
 * sure eve does not keep it either:
 *
 *   - `experimental.workflow.retention: 0` — eve deletes the run's payloads
 *     (input, history checkpoints, model-step payloads, the reply tool input,
 *     the event stream) as soon as the run completes or fails, instead of
 *     keeping them for the plan's retention period (1–30 days). The
 *     dispatcher (src/lib/eve/utility/run-utility.ts) retires each session
 *     right after reading its answer, so the run ends at once.
 *   - a constant session title — eve otherwise derives `$eve.title` from the
 *     first 125 characters of the first message, and keeps that run metadata
 *     even at retention 0.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('eve/channels/eve', async (importOriginal) => ({
  ...(await importOriginal<typeof import('eve/channels/eve')>()),
  // Hand back the config so the test can call onMessage directly.
  eveChannel: (cfg: unknown) => cfg,
}))

import agent from '../../agent'
import channel from '../../channels/eve'

type ChannelConfig = {
  onMessage?: (ctx: { eve: { caller: unknown; request: Request } }, message: unknown) => unknown
}

describe('utility — keeps no run data', () => {
  it('sets workflow retention to 0', () => {
    const def = agent as unknown as { experimental?: { workflow?: { retention?: unknown } } }
    expect(def.experimental?.workflow?.retention).toBe(0)
  })

  it('pins a constant session title and keeps the default session auth', async () => {
    const cfg = channel as unknown as ChannelConfig
    expect(typeof cfg.onMessage).toBe('function')
    const caller = { authenticator: 'shared-secret', principalId: 'app', principalType: 'service' }
    const mail = 'From: someone@example.com\nSubject: private\n\n' + 'body text '.repeat(40)
    const result = await cfg.onMessage!({ eve: { caller, request: new Request('http://x/eve/v1/session') } }, mail)
    expect(result).toEqual({ auth: caller, title: 'utility' })
  })

  it('a null caller stays null (the default projection, unchanged)', async () => {
    const cfg = channel as unknown as ChannelConfig
    const result = await cfg.onMessage!({ eve: { caller: null, request: new Request('http://x/eve/v1/session') } }, 'm')
    expect(result).toEqual({ auth: null, title: 'utility' })
  })
})
