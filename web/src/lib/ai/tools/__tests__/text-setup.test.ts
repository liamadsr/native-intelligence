import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The two setup-by-text tools: connect_link makes a texted link for the
 * person's own account; save_business_profile saves what the owner confirmed
 * to the business memory and ends setup. Neither runs on an unattended turn,
 * and the profile needs the owner's yes.
 */
vi.mock('@/lib/links/oauth-link', async (orig) => ({
  ...(await orig<typeof import('@/lib/links/oauth-link')>()),
  mintConnectLink: vi.fn(async () => ({ ok: true, token: 't', url: 'https://nativeintelligence.dev/l/AbCdEfGhIjKlMnOpQrStUv12', expiresAt: 'x' })),
}))
vi.mock('@/lib/packs/memory-write', () => ({ saveMemoryLine: vi.fn(async (_s, args) => ({ ok: true, line: { text: args.text } })) }))
vi.mock('@/lib/sms/store', async (orig) => ({
  ...(await orig<typeof import('@/lib/sms/store')>()),
  linkedPhoneForUser: vi.fn(async () => ({ id: 'p1', userId: 'user-1', workspaceId: 'ws-1', phone: '+15551234567', optedOut: false, line: 'dial8' as const })),
  recordOutbound: vi.fn(async () => {}),
}))
vi.mock('@/lib/onboarding/text-setup', async (orig) => ({
  ...(await orig<typeof import('@/lib/onboarding/text-setup')>()),
  finishTextSetup: vi.fn(async () => ({ success: true, ended: true })),
}))

const { createTextSetupTools, TEXT_TURN_ONLY_TOOL_NAMES } = await import('../text-setup')
const { linkedPhoneForUser, recordOutbound } = await import('@/lib/sms/store')
const { mintConnectLink } = await import('@/lib/links/oauth-link')
const { saveMemoryLine } = await import('@/lib/packs/memory-write')
const { finishTextSetup } = await import('@/lib/onboarding/text-setup')

function fakeSupabase(role = 'owner') {
  const updates: Array<{ table: string; patch: unknown }> = []
  const from = (table: string) => {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({ data: { role }, error: null }),
      update: (patch: unknown) => (updates.push({ table, patch }), chain),
      then: (ok: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(ok),
    }
    return chain
  }
  return { client: { from } as never, updates }
}

const run = (tools: ReturnType<typeof createTextSetupTools>, name: keyof ReturnType<typeof createTextSetupTools>, input: unknown) =>
  (tools[name] as unknown as { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute(input, { toolCallId: 't', messages: [] })

beforeEach(() => vi.clearAllMocks())

describe('connect_link', () => {
  const send = () => vi.fn(async (_to: string, _body: string) => ({ ok: true as const, sid: 'SMlink' }))

  it("on the person's own text: texts the link to their verified number itself, and the model never sees the url", async () => {
    const db = fakeSupabase()
    const sms = send()
    const out = await run(createTextSetupTools('user-1', db.client, 'ws-1', { textTurn: true, send: sms }), 'connect_link', { provider: 'google' })
    expect(out).toMatchObject({ success: true, texted: true })
    expect(JSON.stringify(out)).not.toContain('/l/')
    expect(mintConnectLink).toHaveBeenCalledWith(db.client, expect.objectContaining({ userId: 'user-1', workspaceId: 'ws-1', provider: 'google' }))
    expect(sms).toHaveBeenCalledWith('+15551234567', expect.stringContaining('Connect your Google account: https://nativeintelligence.dev/l/AbCdEfGhIjKlMnOpQrStUv12'))
    expect(recordOutbound).toHaveBeenCalledWith(db.client, { phone: '+15551234567', kind: 'reply', sid: 'SMlink', userId: 'user-1' })
  })

  it('anywhere else (the app, a run, an unattended turn, MCP) it makes no link: a link handed out could be forwarded', async () => {
    for (const opts of [{}, { textTurn: false }, { textTurn: true, unattended: true }, { unattended: true }]) {
      const sms = send()
      const out = await run(createTextSetupTools('user-1', fakeSupabase().client, 'ws-1', { ...opts, send: sms }), 'connect_link', { provider: 'google' })
      expect(out.success, JSON.stringify(opts)).toBe(false)
      expect(sms).not.toHaveBeenCalled()
    }
    expect(mintConnectLink).not.toHaveBeenCalled()
    expect(TEXT_TURN_ONLY_TOOL_NAMES).toContain('connect_link')
  })

  it('a work run never sends one: its tools are built unattended (src/app/api/internal/work-run/tool/route.ts), which connect_link refuses', async () => {
    const sms = send()
    const out = await run(createTextSetupTools('user-1', fakeSupabase().client, 'ws-1', { unattended: true, send: sms }), 'connect_link', { provider: 'google' })
    expect(out.success).toBe(false)
    expect(sms).not.toHaveBeenCalled()
    expect(mintConnectLink).not.toHaveBeenCalled()
  })

  it('a number that said STOP, or none, gets no link', async () => {
    for (const phone of [null, { id: 'p1', userId: 'user-1', workspaceId: 'ws-1', phone: '+15551234567', optedOut: true, line: 'dial8' as const }]) {
      vi.mocked(linkedPhoneForUser).mockResolvedValueOnce(phone)
      const sms = send()
      expect((await run(createTextSetupTools('user-1', fakeSupabase().client, 'ws-1', { textTurn: true, send: sms }), 'connect_link', { provider: 'google' })).success).toBe(false)
      expect(sms).not.toHaveBeenCalled()
    }
  })
})

describe('save_business_profile', () => {
  const INPUT = {
    confirmed_by_owner: true,
    business_name: 'Bright Weave',
    owner_name: 'Jane',
    website: 'brightweave.com',
    services: 'Hand-washes and repairs handmade rugs',
    service_area: 'Pasadena and 15 miles around',
    pickup_days: 'Tuesdays and Fridays',
    prices: '$4 per sq ft to wash; repairs quoted',
  }

  it('saves each confirmed answer as a workspace line of the knowledge memory, renames the workspace, and ends setup', async () => {
    const db = fakeSupabase()
    const out = await run(createTextSetupTools('user-1', db.client, 'ws-1'), 'save_business_profile', INPUT)
    expect(out).toMatchObject({ success: true, setup_finished: true })
    expect(vi.mocked(saveMemoryLine).mock.calls.map((c) => c[1])).toEqual(
      ['Business: Bright Weave', 'Website: brightweave.com', 'Services: Hand-washes and repairs handmade rugs', 'Service area: Pasadena and 15 miles around', 'Pickup days: Tuesdays and Fridays', 'Prices: $4 per sq ft to wash; repairs quoted'].map(
        (text) => ({ workspaceId: 'ws-1', userId: 'user-1', area: 'knowledge', scope: 'workspace', text, source: 'told' }),
      ),
    )
    expect(db.updates).toEqual([
      { table: 'workspace', patch: { name: 'Bright Weave' } },
      { table: 'member', patch: { display_name: 'Jane' } },
    ])
    expect(finishTextSetup).toHaveBeenCalledWith(db.client, { workspaceId: 'ws-1', userId: 'user-1' })
  })

  it("without the owner's yes it saves nothing", async () => {
    const out = await run(createTextSetupTools('user-1', fakeSupabase().client, 'ws-1'), 'save_business_profile', { ...INPUT, confirmed_by_owner: false })
    expect(out.success).toBe(false)
    expect(saveMemoryLine).not.toHaveBeenCalled()
    expect(finishTextSetup).not.toHaveBeenCalled()
  })

  it('refuses an unattended turn', async () => {
    const out = await run(createTextSetupTools('user-1', fakeSupabase().client, 'ws-1', { unattended: true }), 'save_business_profile', INPUT)
    expect(out.success).toBe(false)
    expect(saveMemoryLine).not.toHaveBeenCalled()
  })

  it('only the owner renames the workspace; a line that fails to save keeps setup on', async () => {
    const db = fakeSupabase('member')
    vi.mocked(saveMemoryLine).mockResolvedValueOnce({ ok: false, code: 'NOTE_FULL', error: 'full' } as never)
    const out = await run(createTextSetupTools('user-1', db.client, 'ws-1'), 'save_business_profile', INPUT)
    expect(out.success).toBe(false)
    expect(db.updates.find((u) => u.table === 'workspace')).toBeUndefined()
    expect(finishTextSetup).not.toHaveBeenCalled()
  })
})
