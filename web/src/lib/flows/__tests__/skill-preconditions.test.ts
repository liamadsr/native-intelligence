/**
 * Tests for skill preconditions (GEN-145) — the honest empty-state gate.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  parsePreconditions,
  checkPreconditions,
  buildEmptyStateMessage,
  type PreconditionKey,
} from '../skill-preconditions'

describe('parsePreconditions', () => {
  it('keeps known keys, drops unknown ones and non-strings', () => {
    expect(parsePreconditions(['calendar_connected', 'inbox_synced', 'bogus', 42, null])).toEqual([
      'calendar_connected',
      'inbox_synced',
    ])
  })
  it('returns [] for non-arrays', () => {
    expect(parsePreconditions(undefined)).toEqual([])
    expect(parsePreconditions('calendar_connected')).toEqual([])
    expect(parsePreconditions(null)).toEqual([])
  })
})

/**
 * Mock the service client's `.select(..., {count, head}).eq()...` chain, which
 * every probe uses, resolving to a fixed count per table/capability.
 */
function mockService(counts: {
  calendar?: number
  email?: number
  email_thread_index?: number
  contact?: number
  captures?: number
  actions?: number
}) {
  const from = vi.fn((table: string) => {
    // Track the capability filter for connected_account (calendar vs email).
    let capability: string | null = null
    const chain: Record<string, unknown> = {}
    const passthrough = (...args: unknown[]) => {
      if (args[0] === 'capability') capability = args[1] as string
      return chain
    }
    for (const m of ['select', 'eq', 'limit']) chain[m] = vi.fn(passthrough)
    chain.then = (res: (r: unknown) => unknown) => {
      let count = 0
      if (table === 'connected_account') count = capability === 'calendar' ? counts.calendar ?? 0 : counts.email ?? 0
      else if (table === 'email_thread_index') count = counts.email_thread_index ?? 0
      else if (table === 'contact') count = counts.contact ?? 0
      else if (table === 'captures') count = counts.captures ?? 0
      else if (table === 'actions') count = counts.actions ?? 0
      return Promise.resolve({ count, error: null }).then(res)
    }
    return chain
  })
  return { from } as never
}

const CTX = { runAsUserId: 'u1', workspaceId: 'w1' }

describe('checkPreconditions', () => {
  it('is always met for an empty precondition list (no queries)', async () => {
    const svc = mockService({})
    const r = await checkPreconditions(svc, [], CTX)
    expect(r.met).toBe(true)
    expect(r.unmet).toEqual([])
    expect((svc as { from: ReturnType<typeof vi.fn> }).from).not.toHaveBeenCalled()
  })

  it('met when the calendar is connected', async () => {
    const r = await checkPreconditions(mockService({ calendar: 1 }), ['calendar_connected'], CTX)
    expect(r.met).toBe(true)
  })

  it('unmet with an honest message when the calendar is not connected', async () => {
    const r = await checkPreconditions(mockService({ calendar: 0 }), ['calendar_connected'], CTX)
    expect(r.met).toBe(false)
    expect(r.unmet[0].key).toBe('calendar_connected')
    expect(r.unmet[0].message).toMatch(/connected calendar/i)
  })

  it('inbox_synced is met via a connected email account', async () => {
    const r = await checkPreconditions(mockService({ email: 1 }), ['inbox_synced'], CTX)
    expect(r.met).toBe(true)
  })

  it('inbox_synced falls back to indexed threads when no account is connected', async () => {
    const r = await checkPreconditions(mockService({ email: 0, email_thread_index: 5 }), ['inbox_synced'], CTX)
    expect(r.met).toBe(true)
  })

  it('inbox_synced unmet when neither account nor threads exist', async () => {
    const r = await checkPreconditions(mockService({ email: 0, email_thread_index: 0 }), ['inbox_synced'], CTX)
    expect(r.met).toBe(false)
    expect(r.unmet[0].message).toMatch(/synced inbox/i)
  })

  it('data preconditions check workspace row counts', async () => {
    expect((await checkPreconditions(mockService({ contact: 3 }), ['has_contacts'], CTX)).met).toBe(true)
    expect((await checkPreconditions(mockService({ contact: 0 }), ['has_contacts'], CTX)).met).toBe(false)
    expect((await checkPreconditions(mockService({ captures: 1 }), ['has_captures'], CTX)).met).toBe(true)
    expect((await checkPreconditions(mockService({ actions: 0 }), ['has_actions'], CTX)).met).toBe(false)
  })

  it('reports ALL unmet preconditions, not just the first', async () => {
    const r = await checkPreconditions(
      mockService({ calendar: 0, email: 0, email_thread_index: 0 }),
      ['calendar_connected', 'inbox_synced'],
      CTX,
    )
    expect(r.met).toBe(false)
    expect(r.unmet.map((u) => u.key)).toEqual(['calendar_connected', 'inbox_synced'])
  })

  it('met when all declared preconditions pass', async () => {
    const r = await checkPreconditions(
      mockService({ calendar: 1, contact: 2 }),
      ['calendar_connected', 'has_contacts'] as PreconditionKey[],
      CTX,
    )
    expect(r.met).toBe(true)
  })
})

describe('buildEmptyStateMessage', () => {
  it('renders the skill name + each unmet message as bullets', () => {
    const msg = buildEmptyStateMessage('Morning Brief', [
      { key: 'calendar_connected', message: 'This needs a connected calendar — link it first.' },
    ])
    expect(msg).toMatch(/\*\*Morning Brief\*\*/)
    expect(msg).toMatch(/- This needs a connected calendar/)
  })
})
