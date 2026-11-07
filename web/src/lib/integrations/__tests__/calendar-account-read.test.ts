/**
 * listAccountEvents as the agent's meeting pass reads it
 * (docs/plans/email-through-the-agent.md E4): a strict read throws on a
 * failed calendar instead of answering with no meetings (which the
 * meeting-changes watch would take for every meeting cancelled), and an
 * Outlook meeting its organizer cancelled carries Google's word for it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/oauth/token-manager', () => ({ getValidToken: vi.fn(), getValidTokenForAccount: vi.fn() }))
vi.mock('@/lib/admin', () => ({ getServiceClient: vi.fn() }))

const { listAccountEvents } = await import('@/lib/integrations/calendar')

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

const window = { timeMin: '2026-10-20T14:00:00.000Z', timeMax: '2026-10-21T14:00:00.000Z' }

function respond(ok: boolean, payload: unknown = {}) {
  globalThis.fetch = vi.fn(async () => ({ ok, status: ok ? 200 : 503, json: async () => payload })) as unknown as typeof fetch
}

describe('listAccountEvents: strict reads', () => {
  it('Google: a failed read throws when strict, and still answers [] when not (the calendar page’s behaviour)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    respond(false)
    await expect(listAccountEvents('google', 'token', { ...window, strict: true })).rejects.toThrow('Google Calendar API error: 503')
    respond(false)
    await expect(listAccountEvents('google', 'token', window)).resolves.toEqual([])
  })

  it('Outlook: a failed read throws either way', async () => {
    respond(false)
    await expect(listAccountEvents('microsoft', 'token', { ...window, strict: true })).rejects.toThrow('Microsoft Calendar API error: 503')
  })
})

describe('listAccountEvents: an Outlook meeting its organizer cancelled', () => {
  it('carries status "cancelled" (isCancelled); a live one carries none', async () => {
    respond(true, {
      value: [
        { id: 'gone', subject: 'Canceled: Board prep', isCancelled: true, start: { dateTime: '2026-10-20T20:00:00.0000000' }, end: { dateTime: '2026-10-20T21:00:00.0000000' } },
        { id: 'live', subject: 'Standup', isCancelled: false, start: { dateTime: '2026-10-20T15:00:00.0000000' }, end: { dateTime: '2026-10-20T15:15:00.0000000' } },
      ],
    })
    const events = await listAccountEvents('microsoft', 'token', { ...window, strict: true })
    expect(events.map((e) => [e.id, e.status])).toEqual([['gone', 'cancelled'], ['live', undefined]])
  })
})
