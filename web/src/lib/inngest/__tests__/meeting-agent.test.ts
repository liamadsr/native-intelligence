/**
 * The meeting agent's Inngest functions (src/lib/inngest/meeting-agent.ts):
 * the dial sleeps until a minute before the start and dials once (a cancel
 * stops it); the notes get a recorded meeting's finishing pass.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createStepMock } from '@/test/inngest-step-mock'

type Handler = (ctx: { event: { data: unknown }; step: ReturnType<typeof createStepMock> }) => Promise<unknown>
const h = vi.hoisted(() => ({ handlers: {} as Record<string, Handler>, configs: {} as Record<string, Record<string, unknown>> }))

vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: (config: { id: string }, fn: Handler) => {
      h.handlers[config.id] = fn
      h.configs[config.id] = config
      return { id: config.id }
    },
  },
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ db: true }) }))
const dial = vi.hoisted(() => ({ dialAttendance: vi.fn(async () => 'dialling') }))
vi.mock('@/lib/meeting-agent/dial', () => dial)
const fin = vi.hoisted(() => ({ runOwnerBatch: vi.fn(async () => 'completed'), postExtraction: vi.fn(async () => {}) }))
vi.mock('../capture-finalizer', () => fin)

await import('../meeting-agent')
const { DIAL_LEAD_MS } = await import('../meeting-agent')

beforeEach(() => {
  dial.dialAttendance.mockClear()
  fin.runOwnerBatch.mockClear()
  fin.postExtraction.mockClear()
})

describe('meeting-agent-dial', () => {
  it('is cancelled by a cancel for the same attendance', () => {
    expect(h.configs['meeting-agent-dial'].cancelOn).toEqual([{ event: 'meeting-agent/cancelled', match: 'data.attendanceId' }])
  })
  it('sleeps until a minute before the start, then dials once', async () => {
    const startsAt = new Date(Date.now() + 3_600_000).toISOString()
    const step = createStepMock()
    const out = await h.handlers['meeting-agent-dial']({ event: { data: { attendanceId: 'att-1', startsAt } }, step })
    expect(step.sleepUntil).toHaveBeenCalledWith('until-the-start', new Date(Date.parse(startsAt) - DIAL_LEAD_MS))
    expect(dial.dialAttendance).toHaveBeenCalledWith({ db: true }, { attendanceId: 'att-1', startsAt })
    expect(out).toEqual({ outcome: 'dialling' })
  })
  it('a start already near or past dials at once', async () => {
    const step = createStepMock()
    await h.handlers['meeting-agent-dial']({ event: { data: { attendanceId: 'att-1', startsAt: new Date(Date.now() + 10_000).toISOString() } }, step })
    expect(step.sleepUntil).not.toHaveBeenCalled()
    expect(dial.dialAttendance).toHaveBeenCalledTimes(1)
  })
})

describe('meeting-agent-notes', () => {
  it("runs a recorded meeting's batch and post-extraction as the person", async () => {
    const step = createStepMock()
    await h.handlers['meeting-agent-notes']({ event: { data: { attendanceId: 'att-1', captureId: 'cap-1', workspaceId: 'ws-1', userId: 'u1' } }, step })
    expect(fin.runOwnerBatch).toHaveBeenCalledWith({ db: true }, { captureId: 'cap-1', workspaceId: 'ws-1', ownerId: 'u1' })
    expect(fin.postExtraction).toHaveBeenCalledWith({ db: true }, { captureId: 'cap-1', workspaceId: 'ws-1', ownerId: 'u1', captureProcessed: false })
    expect(step.sleep).not.toHaveBeenCalled()
  })
  it('lets a batch still in flight settle first', async () => {
    fin.runOwnerBatch.mockResolvedValueOnce('in_flight')
    const step = createStepMock()
    await h.handlers['meeting-agent-notes']({ event: { data: { attendanceId: 'att-1', captureId: 'cap-1', workspaceId: 'ws-1', userId: 'u1' } }, step })
    expect(step.sleep).toHaveBeenCalledWith('let-batch-settle', '11m')
  })
})
