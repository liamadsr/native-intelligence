/**
 * Privacy contract for the web-research mount: a session keeps no run data
 * (`experimental.workflow.retention: 0`; the message names the person or
 * company researched, and the answer is CRM data), and its title is a
 * constant, never derived from the message.
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

describe('web-research — keeps no run data', () => {
  it('sets workflow retention to 0', () => {
    const def = agent as unknown as { experimental?: { workflow?: { retention?: unknown } } }
    expect(def.experimental?.workflow?.retention).toBe(0)
  })

  it('pins a constant session title and keeps the default session auth', async () => {
    const cfg = channel as unknown as ChannelConfig
    const caller = { authenticator: 'shared-secret', principalId: 'app', principalType: 'service' }
    const result = await cfg.onMessage!({ eve: { caller, request: new Request('http://x/eve/v1/session') } }, 'Research Jane Doe at acme.com')
    expect(result).toEqual({ auth: caller, title: 'web-research' })
  })
})
