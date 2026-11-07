/**
 * The morning tidy on Inngest (src/lib/inngest/email-auto-archive.ts): one
 * pass per person at a time, waiting for the digest to land first, gated on
 * the Autonomy switch (failing closed) and a dormant workspace, then one
 * archive step for the person and date the event names.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createStepMock } from '@/test/inngest-step-mock'

type Handler = (ctx: { event: { data: Record<string, unknown> }; step: ReturnType<typeof createStepMock> }) => Promise<unknown>

const hoisted = vi.hoisted(() => ({
  fns: new Map<string, { config: Record<string, unknown>; handler: Handler }>(),
  runAutoArchive: vi.fn(),
  pausedState: vi.fn(async (): Promise<string> => 'active'),
  dormant: vi.fn(async () => false),
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: (config: Record<string, unknown>, handler: Handler) => {
      hoisted.fns.set(config.id as string, { config, handler })
      return { id: config.id }
    },
  },
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ service: true }) }))
vi.mock('@/lib/email/auto-archive', () => ({ runAutoArchive: hoisted.runAutoArchive }))
vi.mock('@/lib/work/agent-paused', () => ({ readAgentPausedState: hoisted.pausedState }))
vi.mock('@/lib/inngest/flow-functions', () => ({ workspaceIsDormant: hoisted.dormant }))

import { AUTO_ARCHIVE_AFTER_DIGEST, EMAIL_AUTO_ARCHIVE_EVENT, autoArchiveRequest } from '../email-auto-archive'

const fn = () => hoisted.fns.get('email-auto-archive')!
const DATA = { workspaceId: 'w1', userId: 'u1', date: '2026-10-27' }

beforeEach(() => {
  hoisted.runAutoArchive.mockReset()
  hoisted.runAutoArchive.mockResolvedValue({ status: 'archived', batchId: 'b-1', archived: 3, failed: 0 })
  hoisted.pausedState.mockReset()
  hoisted.pausedState.mockResolvedValue('active')
  hoisted.dormant.mockReset()
  hoisted.dormant.mockResolvedValue(false)
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

describe('emailAutoArchive', () => {
  it('one pass per person at a time, on the tidy’s event', () => {
    expect(fn().config).toMatchObject({
      triggers: [{ event: EMAIL_AUTO_ARCHIVE_EVENT }],
      concurrency: [{ key: 'event.data.userId', limit: 1 }, { limit: 5 }],
    })
  })

  it('waits for the digest, then archives for the person and date the event names', async () => {
    const step = createStepMock()
    const out = await fn().handler({ event: { data: DATA }, step })
    expect(step.sleep).toHaveBeenCalledWith('after-digest', AUTO_ARCHIVE_AFTER_DIGEST)
    expect(step.run.mock.calls.map(([id]) => id)).toEqual(['gate', 'archive'])
    expect(hoisted.runAutoArchive).toHaveBeenCalledWith({ service: true }, DATA)
    expect(out).toEqual({ status: 'archived', batchId: 'b-1', archived: 3, failed: 0 })
  })

  it('autonomy off, or a switch that can’t be read, archives nothing', async () => {
    for (const state of ['paused', 'unknown']) {
      hoisted.pausedState.mockResolvedValueOnce(state)
      const out = await fn().handler({ event: { data: DATA }, step: createStepMock() })
      expect(out).toEqual({ status: 'skipped', reason: 'paused' })
    }
    hoisted.pausedState.mockRejectedValueOnce(new Error('down'))
    expect(await fn().handler({ event: { data: DATA }, step: createStepMock() })).toEqual({ status: 'skipped', reason: 'paused' })
    expect(hoisted.runAutoArchive).not.toHaveBeenCalled()
  })

  it('a dormant workspace archives nothing', async () => {
    hoisted.dormant.mockResolvedValueOnce(true)
    expect(await fn().handler({ event: { data: DATA }, step: createStepMock() })).toEqual({ status: 'skipped', reason: 'dormant' })
    expect(hoisted.runAutoArchive).not.toHaveBeenCalled()
  })

  it('a malformed event is skipped before the wait', async () => {
    const step = createStepMock()
    expect(await fn().handler({ event: { data: { ...DATA, date: 'today' } }, step })).toEqual({ status: 'skipped', reason: 'bad_event' })
    expect(step.sleep).not.toHaveBeenCalled()
  })

  it('the request: one event id per workspace, person and date', () => {
    expect(autoArchiveRequest(DATA)).toEqual({ id: 'email-auto-archive:w1:u1:2026-10-27', name: EMAIL_AUTO_ARCHIVE_EVENT, data: DATA })
  })
})
