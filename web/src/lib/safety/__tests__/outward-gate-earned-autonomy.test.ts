/**
 * The outward gate with earned autonomy (docs/plans/earned-autonomy.md phase
 * 3): a hold the trust authority answers `ask` and graduationFor says may run
 * is still raised as the person's card, worded as going on its own in 5
 * minutes, and scheduled; a no from graduationFor is the plain card, as
 * before; a hold the authority denies is never asked about at all; a schedule
 * that fails tells the person the card is waiting after all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const mocks = vi.hoisted(() => ({
  decide: vi.fn(async (): Promise<unknown> => ({ status: 'accepted', inferenceId: 'inf-a', value: { allow: true, probability: 0.97 } })),
  approve: vi.fn(async (): Promise<unknown> => ({ ok: true, approvalId: 'appr-1', cardId: 'card-1' })),
  graduation: vi.fn(),
  schedule: vi.fn(async () => true),
  append: vi.fn(async () => ({ written: true })),
}))
vi.mock('@/lib/ai/decisions/run-decision', () => ({ runDecision: mocks.decide }))
vi.mock('../approvals', () => ({ createToolApproval: mocks.approve }))
vi.mock('@/lib/integrations/calendar', () => ({ getCalendarEventAttendees: async () => null }))
vi.mock('@/lib/email/thread-mailbox', () => ({ mailboxesForThread: async function* () {} }))
vi.mock('@/lib/workspace-member-emails', () => ({ findMembersByEmail: async () => new Map() }))
vi.mock('@/lib/autonomy/graduate', () => ({ graduationFor: mocks.graduation, UNDO_WINDOW_MINUTES: 5 }))
vi.mock('@/lib/chat/home-message-writer', () => ({ appendHomeMessage: mocks.append }))
vi.mock('@/lib/autonomy/actions', async () => {
  const real = await vi.importActual<typeof import('@/lib/autonomy/actions')>('@/lib/autonomy/actions')
  return { ...real, scheduleAutonomousAction: mocks.schedule }
})
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))

import { gateRiskyCall, type GateRequest } from '../action-review'

const supabase = { db: true } as never
const base = {
  door: 'chat' as const, userId: 'u', workspaceId: 'w', toolName: 'create_calendar_event',
  input: { title: 'Sync', start: '2026-12-01T15:00:00Z', end: '2026-12-01T15:30:00Z', attendees: ['dana@example.com'] },
  sideEffect: 'external-write' as const, personMessages: ['Set up a sync with Dana'],
  source: 'person' as const, personMessageSeq: 3, runId: 'conv-1', caller: 'person' as const,
  approval: { supabase, conversationId: 'conv-1' },
} satisfies GateRequest
const run = vi.fn(async () => ({ success: true }))
const GO = { run: true, level: 'tell', kind: { key: 'create_calendar_event|calendar|one', tool: 'create_calendar_event', channel: 'calendar', audience: 'one', recipients: ['dana@example.com'] }, runAt: '2026-12-01T00:05:00Z' }

beforeEach(() => {
  for (const m of [mocks.approve, mocks.graduation, mocks.schedule, mocks.append, run]) m.mockClear()
  mocks.schedule.mockResolvedValue(true)
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

describe('a granted kind at the outward gate', () => {
  it('is still the person\'s card, worded as going on its own, and is scheduled; nothing runs now', async () => {
    mocks.graduation.mockResolvedValue(GO)
    const gated = await gateRiskyCall({ ...base, defer: () => {} }, run, false)
    expect(run).not.toHaveBeenCalled()
    expect(gated).toMatchObject({ held: true, output: { code: 'APPROVAL_REQUIRED', approval_id: 'appr-1', message: expect.stringContaining('runs on its own in 5 minutes') } })
    expect(mocks.approve).toHaveBeenCalledWith(supabase, expect.objectContaining({ card: expect.objectContaining({ why: expect.stringContaining('goes on its own in 5 minutes. Dismiss it to stop it.') }) }))
    expect(mocks.schedule).toHaveBeenCalledWith(supabase, expect.objectContaining({ graduation: GO, approvalId: 'appr-1', workspaceId: 'w', userId: 'u' }))
    expect(mocks.graduation).toHaveBeenCalledWith(supabase, expect.objectContaining({ tool: 'create_calendar_event', caller: 'person', decision: 'ask' }))
  })

  it('a no from graduationFor is the plain card, unscheduled, exactly as before', async () => {
    mocks.graduation.mockResolvedValue({ run: false, reason: 'not_granted' })
    const gated = await gateRiskyCall({ ...base, defer: () => {} }, run, false)
    expect(gated).toMatchObject({ held: true, output: { code: 'APPROVAL_REQUIRED' } })
    expect(mocks.approve).toHaveBeenCalledWith(supabase, expect.objectContaining({ card: expect.not.objectContaining({ why: expect.stringContaining('on its own') }) }))
    expect(mocks.schedule).not.toHaveBeenCalled()
  })

  it('graduationFor throwing is the plain card', async () => {
    mocks.graduation.mockRejectedValue(new Error('down'))
    expect(await gateRiskyCall({ ...base, defer: () => {} }, run, false)).toMatchObject({ held: true, output: { code: 'APPROVAL_REQUIRED' } })
    expect(mocks.schedule).not.toHaveBeenCalled()
  })

  it('a hold the authority denies (an unattended loop outside a flow step) is never offered to graduation', async () => {
    mocks.graduation.mockResolvedValue(GO)
    const gated = await gateRiskyCall({ ...base, caller: 'agent_unattended', door: 'skill_run', defer: () => {} }, run, false)
    expect(gated).toMatchObject({ held: true, output: { code: 'NEEDS_PERSON' } })
    expect(mocks.graduation).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('a loop step (an unattended run on its flow step) of a granted kind goes the same way: its card, scheduled', async () => {
    mocks.graduation.mockResolvedValue(GO)
    const gated = await gateRiskyCall({ ...base, caller: 'agent_unattended', door: 'skill_run', flowStep: true, defer: () => {} }, run, false)
    expect(run).not.toHaveBeenCalled()
    expect(gated).toMatchObject({ held: true, output: { code: 'APPROVAL_REQUIRED', approval_id: 'appr-1' } })
    expect(mocks.graduation).toHaveBeenCalledWith(supabase, expect.objectContaining({ caller: 'agent_unattended', decision: 'ask' }))
    expect(mocks.schedule).toHaveBeenCalledWith(supabase, expect.objectContaining({ approvalId: 'appr-1' }))
  })

  it('a schedule that fails: the person hears the card is waiting after all, and the model reads a plain hold', async () => {
    mocks.graduation.mockResolvedValue(GO)
    mocks.schedule.mockResolvedValue(false)
    const gated = await gateRiskyCall({ ...base, defer: () => {} }, run, false)
    expect(gated).toMatchObject({ held: true, output: { code: 'APPROVAL_REQUIRED', message: expect.not.stringContaining('on its own') } })
    expect(mocks.append).toHaveBeenCalledWith(supabase, expect.objectContaining({ parts: [{ type: 'text', text: expect.stringContaining('waiting for your yes') }] }))
  })
})
