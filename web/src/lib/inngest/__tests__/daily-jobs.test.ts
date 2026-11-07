/**
 * The daily list's two functions (roadmap F3, ../daily-jobs.ts): the hourly
 * pass sends one deduped event per business at 7 o'clock local, and the send
 * texts the owner and writes their home thread, or does nothing at all on an
 * empty day or with the agent paused. Over the real list on an in-memory
 * database; the text and the home thread are seams.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStepMock } from '@/test/inngest-step-mock'

const hoisted = vi.hoisted(() => ({
  fns: new Map<string, { config: Record<string, unknown>; handler: (ctx: unknown) => Promise<unknown> }>(),
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  text: vi.fn(),
  home: vi.fn(),
  paused: vi.fn(),
}))

vi.mock('../client', () => ({
  inngest: {
    createFunction: (config: Record<string, unknown>, handler: (ctx: unknown) => Promise<unknown>) => {
      hoisted.fns.set(config.id as string, { config, handler })
      return { config }
    },
  },
}))
vi.mock('@/lib/admin', async () => {
  const { memoryDb } = await import('@/test/memory-db')
  return { getServiceClient: () => memoryDb(hoisted.tables) }
})
vi.mock('@/lib/chat/text-turn-server', () => ({ textPerson: hoisted.text }))
vi.mock('@/lib/chat/home-message-writer', () => ({ appendHomeMessage: hoisted.home }))
vi.mock('@/lib/work/agent-paused', () => ({ isAgentPaused: hoisted.paused }))

await import('../daily-jobs')

const WS = 'ws-northside'
const OWNER = 'user-owner'

beforeEach(() => {
  hoisted.text.mockReset().mockResolvedValue({ sent: true, sid: 'SM1' })
  hoisted.home.mockReset().mockResolvedValue({ written: true })
  hoisted.paused.mockReset().mockResolvedValue(false)
  hoisted.tables = {
    business_profile: [
      { workspace_id: WS, owner_user_id: OWNER, business_name: 'Northside Tutoring', customer_facts: null, time_zone: 'America/Denver', booking_days: [1, 2, 3, 4, 5], booking_start: '15:00', booking_end: '19:00', slot_minutes: 60, lead_hours: 12, horizon_days: 14, booking_kind: 'session', booking_slug: null },
      { workspace_id: 'ws-east', owner_user_id: 'user-east', business_name: 'East Side Dog Walks', customer_facts: null, time_zone: 'America/New_York', booking_days: [1, 2, 3, 4, 5], booking_start: '08:00', booking_end: '18:00', slot_minutes: 30, lead_hours: 2, horizon_days: 7, booking_kind: 'walk', booking_slug: null },
    ],
    workspace: [{ id: WS, name: 'Northside', settings: {} }],
    customer_quote: [],
    customer_booking: [
      // Nov 4, 4:00 PM in Denver (UTC-7).
      { id: 'b-1', workspace_id: WS, owner_user_id: OWNER, quote_id: null, contact_id: null, guest_id: null, source: 'owner', kind: 'session', starts_at: '2026-11-04T23:00:00Z', ends_at: '2026-11-05T00:00:00Z', customer_name: 'Lee Park', customer_phone: '+17205550177', address: '9 Elm Ct', note: null, state: 'confirmed', approval_id: null, calendar_event_id: 'evt-1', created_at: '2026-11-01T12:00:00Z' },
    ],
    member: [{ workspace_id: WS, user_id: OWNER, role: 'owner' }],
    user_profiles: [],
  }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('daily-jobs-pass', () => {
  const fn = () => hoisted.fns.get('daily-jobs-pass')!

  it('runs hourly, never two passes at once', () => {
    expect(fn().config).toMatchObject({ triggers: [{ cron: '0 * * * *' }], singleton: { mode: 'skip' } })
  })

  it("sends one event per business whose zone reads 7, with the per-date id Inngest dedupes on", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-04T14:00:00Z')) // 7:00 in Denver, 9:00 in New York
    const step = createStepMock()
    expect(await fn().handler({ step })).toEqual({ businesses: 2, requested: 1 })
    expect(step.sendEvent).toHaveBeenCalledWith('request-daily-jobs', [
      { id: 'daily-jobs:ws-northside:2026-11-04', name: 'customers/daily-jobs.requested', data: { workspaceId: WS, localDate: '2026-11-04' } },
    ])
  })

  it('sends nothing in an hour no business reads 7', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-04T15:00:00Z'))
    const step = createStepMock()
    expect(await fn().handler({ step })).toEqual({ businesses: 2, requested: 0 })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })
})

describe('daily-jobs-send', () => {
  const fn = () => hoisted.fns.get('daily-jobs-send')!
  const event = (localDate: string) => ({ data: { workspaceId: WS, localDate } })

  it("texts the profile's owner one message (from the workspace's number: textPerson takes the workspace) and writes the same words home", async () => {
    const step = createStepMock()
    expect(await fn().handler({ event: event('2026-11-04'), step })).toEqual({ outcome: 'sent', jobs: 1, home: true, texted: true })
    const body = 'Northside Tutoring, today (Wed, Nov 4): 1 booked\n4:00 PM - Lee Park - 9 Elm Ct - +1 (720) 555-0177 - session'
    expect(hoisted.text).toHaveBeenCalledWith(expect.anything(), { userId: OWNER, workspaceId: WS, body, kind: 'notice' })
    expect(hoisted.home).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: OWNER, workspaceId: WS, parts: [{ type: 'text', text: body }], messageId: 'daily-jobs-ws-northside-2026-11-04' }))
    // Each send is its own step: a retry never sends a text that already went.
    expect(step.run.mock.calls.map((c: unknown[]) => c[0])).toEqual(['build', 'home-thread', 'text-owner'])
  })

  it('an empty day, or a paused agent, sends nothing at all', async () => {
    const step = createStepMock()
    expect(await fn().handler({ event: event('2026-11-05'), step })).toEqual({ outcome: 'empty' })
    hoisted.paused.mockResolvedValue(true)
    expect(await fn().handler({ event: event('2026-11-04'), step })).toEqual({ outcome: 'paused' })
    expect(hoisted.text).not.toHaveBeenCalled()
    expect(hoisted.home).not.toHaveBeenCalled()
  })

  it('ignores an event without its workspace and date', async () => {
    expect(await fn().handler({ event: { data: {} }, step: createStepMock() })).toEqual({ outcome: 'invalid_event' })
  })
})
