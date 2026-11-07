import { beforeEach, describe, expect, it, vi } from 'vitest'
import { aggregateDecisionReport } from '@/lib/ai/decisions/reporting/aggregate'

const mock = vi.hoisted(() => ({ load: vi.fn(), nudgeWorth: vi.fn() }))
vi.mock('@/lib/ai/decisions/reporting/load', () => ({ loadDecisionReport: mock.load }))
vi.mock('@/lib/ai/decisions/reporting/nudge-worth', () => ({ loadNudgeWorthReadout: mock.nudgeWorth }))
import DecisionsPage from '../page'

beforeEach(() => {
  mock.nudgeWorth.mockReset().mockResolvedValue({ windowDays: 30, from: '', to: '', bar: { minCases: 40, minAgreement: 0.9 }, versions: [], partial: false })
  mock.load.mockReset().mockImplementation(async range => aggregateDecisionReport(range, {
    decisions: [], browserCommands: [], parentUsage: [],
  }))
})

describe('decision admin page loading', () => {
  it('passes the validated exclusive range and selected workspace to the authenticated loader', async () => {
    await DecisionsPage({ searchParams: Promise.resolve({ preset: 'custom', from: '2026-01-01', to: '2026-01-03',
      workspace: 'aa5dc58b-c0cf-4332-bbdc-ac622826d388' }) })
    expect(mock.load).toHaveBeenCalledExactlyOnceWith({ from: '2026-01-01T00:00:00.000Z', to: '2026-01-04T00:00:00.000Z',
      workspaceId: 'aa5dc58b-c0cf-4332-bbdc-ac622826d388' })
  })

  it.each([{ workspace: 'malformed' }, { preset: 'custom', from: '2025-01-01', to: '2026-01-03' }])(
    'does not query broader data when filters are invalid: %j', async filters => {
      await DecisionsPage({ searchParams: Promise.resolve(filters) })
      expect(mock.load).not.toHaveBeenCalled()
      expect(mock.nudgeWorth).not.toHaveBeenCalled()
    })

  it('loads the nudge.worth readout beside the report, with the workspace filter', async () => {
    await DecisionsPage({ searchParams: Promise.resolve({ workspace: 'aa5dc58b-c0cf-4332-bbdc-ac622826d388' }) })
    expect(mock.nudgeWorth).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'aa5dc58b-c0cf-4332-bbdc-ac622826d388' })
  })

  it('does not swallow authorization or loader failures into a successful empty report', async () => {
    const failure = new Error('not authorized')
    mock.load.mockRejectedValue(failure)
    await expect(DecisionsPage({ searchParams: Promise.resolve({}) })).rejects.toBe(failure)
  })
})
