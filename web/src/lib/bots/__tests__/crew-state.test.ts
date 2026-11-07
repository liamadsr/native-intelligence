/**
 * Who the AI limit stopped (crew-state.ts; docs/plans/bots-v4.md Phase 4b).
 *
 * Pinned:
 *   - the AI limit: the answer's teammates, moved on by the held rows started
 *     after it was read (a run stopped by the limit stops its teammate, any
 *     other run wakes it, in the order they started), and only within 48 hours.
 */
import { describe, expect, it } from 'vitest'
import type { WorkStatus } from '@/lib/work/types'
import { AI_LIMIT_WINDOW_MS } from '@/lib/work/presentation'
import { aiLimitedTeammates } from '../crew-state'
import { AI_LIMIT_SLEEP_HOURS } from '../bot-page'

const HOUR = 3_600_000
const NOW = Date.parse('2026-10-07T12:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

describe('aiLimitedTeammates', () => {
  const asOf = iso(NOW - 10 * 60_000)
  const answer = [{ teammate_id: 'w', workspace_id: 'ws', at: iso(NOW - 2 * HOUR) }]
  const row = (id: string, teammate: string, status: WorkStatus, at: number, error: string | null = null) => ({
    id,
    ai_team_member_id: teammate,
    status,
    error_message: error,
    created_at: iso(at),
    finished_at: status === 'failed' || status === 'done' ? iso(at + 1000) : null,
  })

  it('is the answer, with no rows started since it was read', () => {
    expect([...aiLimitedTeammates(answer, asOf, [row('old', 'w', 'failed', NOW - 3 * HOUR, 'AI usage limit exceeded')], NOW)]).toEqual([
      ['w', answer[0].at],
    ])
    expect(aiLimitedTeammates(answer, null, null, NOW).has('w')).toBe(true)
  })

  it('a run pushed since that the limit stopped stops its teammate from then', () => {
    const pushed = row('r1', 'x', 'failed', NOW - 60_000, 'AI usage limit exceeded (plan limit) — skill run skipped')
    const stopped = aiLimitedTeammates([], asOf, [pushed], NOW)
    expect(stopped.get('x')).toBe(pushed.finished_at)
  })

  it('any other run started since wakes it: done, running, or a plain failure', () => {
    for (const status of ['done', 'running', 'queued', 'needs_review'] as const) {
      expect(aiLimitedTeammates(answer, asOf, [row('r', 'w', status, NOW - 60_000)], NOW).has('w')).toBe(false)
    }
    expect(aiLimitedTeammates(answer, asOf, [row('r', 'w', 'failed', NOW - 60_000, 'timed out')], NOW).has('w')).toBe(false)
  })

  it('takes the runs in the order they moved (settled, else started): the last one decides', () => {
    const woke = row('a', 'w', 'done', NOW - 5 * 60_000)
    const stoppedAgain = row('b', 'w', 'failed', NOW - 60_000, 'usage limit reached')
    expect(aiLimitedTeammates(answer, asOf, [stoppedAgain, woke], NOW).get('w')).toBe(stoppedAgain.finished_at)
    expect(aiLimitedTeammates(answer, asOf, [row('c', 'w', 'done', NOW - 30_000), stoppedAgain], NOW).has('w')).toBe(false)
  })

  // Review of #650: a run already going when the answer was read, stopped by the limit after it.
  it('a run in flight at the read that the limit stops after it stops its teammate; one that finishes fine after it wakes one', () => {
    const inFlight = { ...row('long', 'x', 'failed', NOW - 30 * 60_000, 'AI usage limit exceeded'), finished_at: iso(NOW - 60_000) }
    expect(aiLimitedTeammates([], asOf, [inFlight], NOW).get('x')).toBe(inFlight.finished_at)
    const finishedFine = { ...row('long-ok', 'w', 'done', NOW - 30 * 60_000), finished_at: iso(NOW - 60_000) }
    expect(aiLimitedTeammates(answer, asOf, [finishedFine], NOW).has('w')).toBe(false)
    // Started before the read and still going: says nothing yet.
    expect(aiLimitedTeammates(answer, asOf, [row('going', 'w', 'running', NOW - 30 * 60_000)], NOW).has('w')).toBe(true)
  })

  it('only within 48 hours, the page’s window', () => {
    expect(AI_LIMIT_SLEEP_HOURS * HOUR).toBe(AI_LIMIT_WINDOW_MS)
    const old = [{ teammate_id: 'w', workspace_id: 'ws', at: iso(NOW - AI_LIMIT_WINDOW_MS - 1) }]
    expect(aiLimitedTeammates(old, asOf, [], NOW).size).toBe(0)
  })

  it('a row with no teammate moves nothing', () => {
    const lane = { ...row('l', 'w', 'done', NOW - 60_000), ai_team_member_id: null }
    expect(aiLimitedTeammates(answer, asOf, [lane], NOW).has('w')).toBe(true)
  })
})
