/**
 * Per-turn timings off the eve events the route already streams
 * (turn-timing.ts): tool time from request to result, the first delivered
 * nudge, and what the time guard cut. A controlled clock, no eve.
 */
import { describe, expect, it } from 'vitest'
import { TOOL_MS_MAX_KEYS, createLiveTurnTiming } from '../turn-timing'
import { ev } from './helpers/fake-eve-turn'

function clocked(start: number) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

describe('createLiveTurnTiming', () => {
  it('times each tool from actions.requested to action.result, summed per name with a count', () => {
    const c = clocked(1_000)
    const timing = createLiveTurnTiming(1_000, c.now)
    c.advance(500)
    timing.observe(ev.toolCall(0, 'a', 'find', { query: 'x' }))
    timing.observe(ev.toolCall(0, 'b', 'find', { query: 'y' }))
    c.advance(1_200)
    timing.observe(ev.toolResult(0, 'a', 'find', { results: [] }))
    c.advance(300)
    timing.observe(ev.toolResult(0, 'b', 'find', { results: [] }))
    timing.observe(ev.toolCall(1, 'c', 'propose_change', {}))
    c.advance(200)
    timing.observe(ev.toolResult(1, 'c', 'propose_change', { success: true }))
    expect(timing.summary()).toEqual({
      tool_ms: { find: { ms: 2_700, n: 2 }, propose_change: { ms: 200, n: 1 } },
    })
  })

  it('a result whose request was never seen is not timed', () => {
    const timing = createLiveTurnTiming(0, () => 0)
    timing.observe(ev.toolResult(0, 'ghost', 'web_search', { results: [] }))
    expect(timing.summary()).toEqual({})
  })

  it('time_to_first_say_ms: the first say_to_user that ran, from the turn start; stale drops are counted apart', () => {
    const c = clocked(10_000)
    const timing = createLiveTurnTiming(10_000, c.now)
    timing.observe(ev.toolCall(0, 's1', 'say_to_user', { message: 'a' }))
    c.advance(4_000)
    timing.observe(ev.toolResult(0, 's1', 'say_to_user', { dropped: 'stale', delivered: false }))
    timing.observe(ev.toolCall(0, 's2', 'say_to_user', { message: 'b' }))
    c.advance(2_000)
    timing.observe(ev.toolResult(0, 's2', 'say_to_user', 'boom', true))
    timing.observe(ev.toolCall(1, 's3', 'say_to_user', { message: 'c' }))
    c.advance(1_000)
    timing.observe(ev.toolResult(1, 's3', 'say_to_user', { delivered: true, id: 'n' }))
    timing.observe(ev.toolCall(1, 'r1', 'find', {}))
    timing.observe(ev.toolResult(1, 'r1', 'find', { refused: 'time_up', message: '…' }))
    expect(timing.summary()).toMatchObject({
      time_to_first_say_ms: 7_000,
      stale_nudge_drops: 1,
      time_up_refusals: 1,
    })
  })

  it(`caps tool_ms at ${TOOL_MS_MAX_KEYS} names, the slowest kept, the rest folded into _other`, () => {
    const c = clocked(0)
    const timing = createLiveTurnTiming(0, c.now)
    for (let i = 0; i < TOOL_MS_MAX_KEYS + 5; i++) {
      timing.observe(ev.toolCall(0, `c${i}`, `tool_${i}`, {}))
      c.advance(i + 1)
      timing.observe(ev.toolResult(0, `c${i}`, `tool_${i}`, {}))
    }
    const toolMs = timing.summary().tool_ms!
    expect(Object.keys(toolMs)).toHaveLength(TOOL_MS_MAX_KEYS)
    expect(toolMs).toHaveProperty(`tool_${TOOL_MS_MAX_KEYS + 4}`)
    expect(toolMs).not.toHaveProperty('tool_0')
    // The 6 fastest (1..6 ms) fold into _other.
    expect(toolMs._other).toEqual({ ms: 21, n: 6 })
  })
})

describe('connected-app lookups in the timings', () => {
  it('fold every mcp__ name into one mcp key and count the lookups that ran', () => {
    const c = clocked(0)
    const timing = createLiveTurnTiming(0, c.now)
    timing.observe(ev.toolCall(0, 'm1', 'mcp__jira__getJiraIssue', { key: 'A-1' }))
    timing.observe(ev.toolCall(0, 'm2', 'mcp__linear__list_issues', {}))
    c.advance(800)
    timing.observe(ev.toolResult(0, 'm1', 'mcp__jira__getJiraIssue', { success: true, content: [] }))
    c.advance(400)
    timing.observe(ev.toolResult(0, 'm2', 'mcp__linear__list_issues', { success: false, code: 'MCP_TIMEOUT' }))
    // Refusals did not run: the cap and the time guard.
    timing.observe(ev.toolCall(1, 'm3', 'mcp__jira__getJiraIssue', {}))
    timing.observe(ev.toolResult(1, 'm3', 'mcp__jira__getJiraIssue', { refused: 'mcp_limit', message: '…' }))
    timing.observe(ev.toolCall(1, 'm4', 'mcp__jira__getJiraIssue', {}))
    timing.observe(ev.toolResult(1, 'm4', 'mcp__jira__getJiraIssue', { refused: 'time_up', message: '…' }))
    const summary = timing.summary()
    expect(summary.tool_ms).toEqual({ mcp: { ms: 2_000, n: 4 } })
    expect(summary.mcp_lookups).toBe(2)
    expect(summary.time_up_refusals).toBe(1)
    expect(JSON.stringify(summary)).not.toContain('jira')
  })

  it('a turn without lookups carries no mcp fields', () => {
    const timing = createLiveTurnTiming(0, () => 0)
    timing.observe(ev.toolCall(0, 'a', 'find', {}))
    timing.observe(ev.toolResult(0, 'a', 'find', {}))
    expect(timing.summary()).toEqual({ tool_ms: { find: { ms: 0, n: 1 } } })
  })

  it('a say_to_user a nudge.worth gate held counts as held_nudge_drops, never as the first say', () => {
    const timing = createLiveTurnTiming(0, () => 5)
    timing.observe(ev.toolCall(0, 'h', 'say_to_user', { message: 'x' }))
    timing.observe(ev.toolResult(0, 'h', 'say_to_user', { dropped: 'held', delivered: false }))
    const summary = timing.summary()
    expect(summary.held_nudge_drops).toBe(1)
    expect(summary).not.toHaveProperty('stale_nudge_drops')
    expect(summary).not.toHaveProperty('time_to_first_say_ms')
  })
})
