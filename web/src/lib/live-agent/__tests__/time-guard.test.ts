/**
 * The live agent's time guard (time-guard.ts): pure arithmetic on the token's
 * claims. Pins the two boundaries (assist-only reads at 25 s, say_to_user at
 * 45 s on every copilot tick), what stays allowed past them, that only a
 * copilot tick is guarded, and the server-clock flush time from a client age.
 */
import { describe, expect, it } from 'vitest'
import {
  STALE_NUDGE_MESSAGE,
  TIME_UP_MESSAGE,
  WINDOW_AGE_MAX_MS,
  liveTimeGuard,
  windowStartFromAge,
} from '../time-guard'
import { LIVE_NUDGE_EXPIRY_MS, LIVE_RESEARCH_CUTOFF_MS } from '../turn-budget'

const START = 1_000_000
type GuardInput = Parameters<typeof liveTimeGuard>[0]
/** An assist-only copilot tick by default (the talk-only turn). */
const at = (toolName: string, ageMs: number, over: Partial<GuardInput> = {}) =>
  liveTimeGuard({
    toolName,
    turnKind: 'tick',
    turnType: 'copilot',
    assistOnly: true,
    windowStartedAt: START,
    now: START + ageMs,
    ...over,
  })

describe('liveTimeGuard', () => {
  it('pins the constants', () => {
    expect(LIVE_RESEARCH_CUTOFF_MS).toBe(25_000)
    expect(LIVE_NUDGE_EXPIRY_MS).toBe(45_000)
  })

  it('assist-only reads: allowed at 24.9 s, refused at 25.1 s with a normal tool result', () => {
    expect(at('find', 24_900)).toEqual({ action: 'run' })
    expect(at('find', 25_100)).toEqual({
      action: 'refuse',
      ageMs: 25_100,
      output: { refused: 'time_up', message: TIME_UP_MESSAGE },
    })
    expect(at('get_capture_transcript', 30_000).action).toBe('refuse')
  })

  it('a record-writing copilot (not assist-only) keeps its reads at 30 s, but its nudge still goes stale at 46 s', () => {
    for (const name of ['list_workspace_members', 'list_actions', 'find']) {
      expect(at(name, 30_000, { assistOnly: false })).toEqual({ action: 'run' })
    }
    expect(at('say_to_user', 46_000, { assistOnly: false }).action).toBe('drop')
  })

  it('say_to_user: allowed at 44 s (past the research cutoff), dropped as stale at 46 s', () => {
    expect(at('say_to_user', 44_000)).toEqual({ action: 'run' })
    expect(at('say_to_user', 46_000)).toEqual({
      action: 'drop',
      ageMs: 46_000,
      output: { dropped: 'stale', delivered: false, message: STALE_NUDGE_MESSAGE },
    })
  })

  it('write / staging tools always run, however late (notes and commitments still land)', () => {
    for (const name of ['propose_change', 'record_commitment', 'write_summary', 'update_summary', 'search_projects', 'ask_user']) {
      expect(at(name, 60_000)).toEqual({ action: 'run' })
    }
  })

  it('guards a copilot tick only: batch, record, notes and an old token without turnKind run unguarded', () => {
    expect(at('find', 60_000, { turnKind: 'batch', turnType: 'batch' })).toEqual({ action: 'run' })
    expect(at('say_to_user', 60_000, { turnKind: 'record' })).toEqual({ action: 'run' })
    expect(at('find', 60_000, { turnType: 'notes' })).toEqual({ action: 'run' })
    expect(at('say_to_user', 60_000, { turnKind: undefined })).toEqual({ action: 'run' })
  })

  it('a window clock in the future counts as age 0', () => {
    expect(at('find', -5_000)).toEqual({ action: 'run' })
  })
})

describe('liveTimeGuard: connected-app lookups are reads (prefix AND catalog membership)', () => {
  const LOOKUPS = new Set(['mcp__jira__getJiraIssue'])

  it('assist-only: a lookup runs at 24.9 s and is refused at 25.1 s', () => {
    expect(at('mcp__jira__getJiraIssue', 24_900, { mcpLookups: LOOKUPS })).toEqual({ action: 'run' })
    expect(at('mcp__jira__getJiraIssue', 25_100, { mcpLookups: LOOKUPS })).toEqual({
      action: 'refuse',
      ageMs: 25_100,
      output: { refused: 'time_up', message: TIME_UP_MESSAGE },
    })
  })

  it('a record-writing copilot keeps its lookups past the cutoff', () => {
    expect(at('mcp__jira__getJiraIssue', 30_000, { assistOnly: false, mcpLookups: LOOKUPS })).toEqual({ action: 'run' })
  })

  it('the prefix alone decides nothing: a name outside the catalog is not treated as a read here', () => {
    expect(at('mcp__jira__other', 30_000, { mcpLookups: LOOKUPS })).toEqual({ action: 'run' })
    expect(at('mcp__jira__getJiraIssue', 30_000)).toEqual({ action: 'run' })
  })

  it('record, batch and notes turns are unguarded', () => {
    expect(at('mcp__jira__getJiraIssue', 30_000, { turnKind: 'record', mcpLookups: LOOKUPS })).toEqual({ action: 'run' })
    expect(at('mcp__jira__getJiraIssue', 30_000, { turnType: 'notes', mcpLookups: LOOKUPS })).toEqual({ action: 'run' })
  })
})

describe('windowStartFromAge — the server-clock flush time from a client-measured age', () => {
  const NOW = 2_000_000_000_000
  it('subtracts the age from the server clock, clamped to [0, 10 min]', () => {
    expect(windowStartFromAge(5_000, NOW)).toBe(NOW - 5_000)
    expect(windowStartFromAge(0, NOW)).toBe(NOW)
    expect(windowStartFromAge(60 * 60_000, NOW)).toBe(NOW - WINDOW_AGE_MAX_MS)
    expect(windowStartFromAge(-3_000, NOW)).toBe(NOW)
  })

  it('ignores garbage', () => {
    for (const bad of [undefined, null, '5000', NaN, Infinity, {}, [5_000]]) {
      expect(windowStartFromAge(bad, NOW)).toBeUndefined()
    }
  })
})
