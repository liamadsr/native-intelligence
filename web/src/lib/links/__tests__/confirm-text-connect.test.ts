import { describe, expect, it, vi } from 'vitest'
import { confirmTextConnect } from '../oauth-link'

/**
 * After a texted link connects: the confirmation lands in the home thread and
 * goes to the person's verified number, never one that said STOP. During
 * setup by text it asks for the website.
 */
function fakeSupabase(opts: { phone?: { phone_e164: string; workspace_id: string; opted_out_at: string | null; line?: string } | null; progress?: unknown }) {
  const writes: Array<{ table: string; row: unknown }> = []
  const from = (table: string) => {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      not: () => chain,
      is: () => chain,
      limit: () => chain,
      update: () => chain,
      maybeSingle: async () => {
        if (table === 'user_phone') return { data: opts.phone ? { id: 'p1', user_id: 'user-1', ...opts.phone } : null, error: null }
        if (table === 'member') return { data: { onboarding_progress: opts.progress ?? null }, error: null }
        if (table === 'chat_conversations') return { data: { id: 'conv-1' }, error: null }
        return { data: null, error: null }
      },
      insert: async (row: unknown) => (writes.push({ table, row }), { error: null }),
      upsert: async (row: unknown) => (writes.push({ table, row }), { error: null }),
      then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(ok),
    }
    return chain
  }
  return { client: { from, rpc: async () => ({ data: 'conv-1', error: null }) } as never, writes }
}

vi.mock('@/lib/chat/home-message-writer', () => ({ appendHomeMessage: vi.fn(async () => ({ written: true, conversationId: 'conv-1' })) }))
const { appendHomeMessage } = await import('@/lib/chat/home-message-writer')

const ARGS = { userId: 'user-1', workspaceId: 'ws-1', provider: 'google', capabilities: ['email'], email: 'jane@brightweave.com', messageKey: 'nonce-1', first: true, pending: ['calendar'] }

describe('confirmTextConnect', () => {
  it('during setup: the thread and a text, asking whether their address’s domain is the website', async () => {
    const db = fakeSupabase({ phone: { phone_e164: '+15551234567', workspace_id: 'ws-1', opted_out_at: null }, progress: { text_signup: { started_at: '2026-11-02T15:00:00Z' } } })
    const send = vi.fn(async (_to: string, _body: string) => ({ ok: true as const, sid: 'SMout' }))
    const email = vi.fn(async () => true)
    expect(await confirmTextConnect(db.client, ARGS, { send, email })).toEqual({ texted: true })
    // The connected address is told which Native Intelligence account it joined (the forwarded-link defence).
    expect(email).toHaveBeenCalledWith({ to: 'jane@brightweave.com', provider: 'google', maskedPhone: '+1 ••• ••• 4567' })
    const text = send.mock.calls[0][1]
    expect(send.mock.calls[0][0]).toBe('+15551234567')
    expect(text).toContain('Google is connected (jane@brightweave.com): email. Calendar is next on that page.')
    expect(text).toContain('Is brightweave.com your business')
    expect(appendHomeMessage).toHaveBeenCalledWith(db.client, expect.objectContaining({ userId: 'user-1', workspaceId: 'ws-1', messageId: 'text-connect-nonce-1', parts: [{ type: 'text', text }] }))
    expect(db.writes).toContainEqual({ table: 'sms_message', row: expect.objectContaining({ direction: 'out', kind: 'connected', phone_e164: '+15551234567' }) })
  })

  it('a later leg sends one line and no second email', async () => {
    const db = fakeSupabase({ phone: { phone_e164: '+15551234567', workspace_id: 'ws-1', opted_out_at: null } })
    const send = vi.fn(async (_to: string, _body: string) => ({ ok: true as const, sid: 'SMout' }))
    const email = vi.fn(async () => true)
    await confirmTextConnect(db.client, { ...ARGS, capabilities: ['calendar'], first: false, pending: [] }, { send, email })
    expect(send.mock.calls[0][1]).toBe('Google calendar is connected too.')
    expect(email).not.toHaveBeenCalled()
  })

  it('a number that said STOP gets no text (the thread still has it)', async () => {
    const db = fakeSupabase({ phone: { phone_e164: '+15551234567', workspace_id: 'ws-1', opted_out_at: '2026-11-01T00:00:00Z' } })
    const send = vi.fn()
    expect(await confirmTextConnect(db.client, ARGS, { send, email: vi.fn(async () => true) })).toEqual({ texted: false })
    expect(send).not.toHaveBeenCalled()
  })

  it("a business line (migration 464) whose workspace has no business number gets no text: never from the Native Intelligence number, whose replies reach another account", async () => {
    const db = fakeSupabase({ phone: { phone_e164: '+15551234567', workspace_id: 'ws-1', opted_out_at: null, line: 'business' } })
    const send = vi.fn()
    expect(await confirmTextConnect(db.client, ARGS, { send, email: vi.fn(async () => true) })).toEqual({ texted: false })
    expect(send).not.toHaveBeenCalled()
  })

  it('no verified number: nothing is texted', async () => {
    const db = fakeSupabase({ phone: null })
    const send = vi.fn()
    expect(await confirmTextConnect(db.client, ARGS, { send, email: vi.fn(async () => true) })).toEqual({ texted: false })
    expect(send).not.toHaveBeenCalled()
  })
})

describe('a GitHub connect (roadmap track E)', () => {
  it('asks which repo is their website, as a numbered list', async () => {
    const db = fakeSupabase({ phone: { phone_e164: '+15551234567', workspace_id: 'ws-1', opted_out_at: null } })
    const send = vi.fn(async (_to: string, _body: string) => ({ ok: true as const, sid: 'SMout' }))
    const websiteRepos = vi.fn(async () => ['jane/website', 'jane/old-site'])
    await confirmTextConnect(db.client, { ...ARGS, provider: 'github', capabilities: ['github'], email: 'jane@github', pending: [] }, { send, email: vi.fn(async () => true), websiteRepos })
    expect(websiteRepos).toHaveBeenCalledWith('user-1', 'ws-1')
    expect(send.mock.calls[0][1]).toBe("GitHub is connected (jane@github): repositories. Which one is your website? 1) jane/website 2) jane/old-site Reply with its number, or its name if it isn't there.")
  })

  it('asks nothing when there is nothing to ask (a site is already connected), and never for another provider', async () => {
    const db = fakeSupabase({ phone: { phone_e164: '+15551234567', workspace_id: 'ws-1', opted_out_at: null } })
    const send = vi.fn(async (_to: string, _body: string) => ({ ok: true as const, sid: 'SMout' }))
    const websiteRepos = vi.fn(async () => null)
    await confirmTextConnect(db.client, { ...ARGS, provider: 'github', capabilities: ['github'], email: 'jane@github', pending: [] }, { send, email: vi.fn(async () => true), websiteRepos })
    expect(send.mock.calls[0][1]).toBe('GitHub is connected (jane@github): repositories.')
    const google = vi.fn(async () => ['x/y'])
    await confirmTextConnect(db.client, ARGS, { send, email: vi.fn(async () => true), websiteRepos: google })
    expect(google).not.toHaveBeenCalled()
  })
})
