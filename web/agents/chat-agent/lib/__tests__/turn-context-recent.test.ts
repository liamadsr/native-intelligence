/**
 * The `recent` section's rule (A3): it goes out only on the first turn after a
 * checkpoint, read from the history alone (eve's `context.compaction` marker
 * with no turn-context block after it), whatever its hash, and is never
 * marked cleared. A replay over the same history sends the same block.
 */
import { describe, it, expect } from 'vitest'
import { firstTurnAfterCheckpoint, lastSentSections, renderTurnContext } from '../turn-context.js'

const TIME = { key: 'time', markdown: 'Current date and time: Wednesday, October 14, 2026 at 10:05 AM EDT' }
const RECENT = { key: 'recent', markdown: 'Recent exchange: …\nUser: Draft the Acme reply\nAssistant: Here it is.' }
const marker = { role: 'user', kind: 'context.compaction', content: 'Summary of our conversation so far:' }
const summary = { role: 'assistant', content: 'We planned the Acme renewal.' }
const block = (content: string) => ({ role: 'user', kind: 'context.instruction', content })
const said = (content: string) => ({ role: 'user', kind: 'user', content })

describe('firstTurnAfterCheckpoint', () => {
  it('is true right after a checkpoint, before any turn-context block', () => {
    expect(firstTurnAfterCheckpoint([marker, summary])).toBe(true)
    // Automatic compaction keeps a few messages after the summary: still the first turn since.
    expect(firstTurnAfterCheckpoint([marker, summary, said('Continue.')])).toBe(true)
  })

  it('is false with no checkpoint, or once a turn has run since it', () => {
    expect(firstTurnAfterCheckpoint([])).toBe(false)
    expect(firstTurnAfterCheckpoint([block(renderTurnContext([TIME], new Map())!), said('hi')])).toBe(false)
    const turnSince = block(renderTurnContext([TIME], new Map())!)
    expect(firstTurnAfterCheckpoint([marker, summary, turnSince, said('next')])).toBe(false)
  })

  it('reads only the newest checkpoint', () => {
    const old = block(renderTurnContext([TIME], new Map())!)
    expect(firstTurnAfterCheckpoint([marker, summary, old, said('x'), marker, summary])).toBe(true)
  })

  it('a block the person types (kind user) does not count as a turn-context block', () => {
    expect(firstTurnAfterCheckpoint([marker, summary, said(renderTurnContext([TIME], new Map())!)])).toBe(true)
  })
})

describe('renderTurnContext with the recent section', () => {
  it('sends it on the first turn after a checkpoint', () => {
    const out = renderTurnContext([TIME, RECENT], new Map(), { afterCheckpoint: true })!
    expect(out).toContain('<section key="recent" v="')
    expect(out).toContain('User: Draft the Acme reply')
  })

  it('leaves it out on any other turn, and never marks it cleared', () => {
    const first = renderTurnContext([TIME, RECENT], new Map(), { afterCheckpoint: true })!
    const later = renderTurnContext([TIME, RECENT], lastSentSections([block(first)]), { afterCheckpoint: false })!
    expect(later).not.toContain('key="recent"')
    // Not present at all this turn: still no clear.
    const absent = renderTurnContext([TIME], lastSentSections([block(first)]))!
    expect(absent).not.toContain('recent')
  })

  it('goes out even when an earlier block carried the same bytes (it is never diffed)', () => {
    const first = renderTurnContext([TIME, RECENT], new Map(), { afterCheckpoint: true })!
    const again = renderTurnContext([TIME, RECENT], lastSentSections([block(first)]), { afterCheckpoint: true })!
    expect(again).toContain('key="recent"')
  })

  it('is not sent near compaction on its own (resendAll is not a checkpoint)', () => {
    expect(renderTurnContext([TIME, RECENT], new Map(), { resendAll: true })).not.toContain('key="recent"')
  })

  it('a replay over the same history sends the same block', () => {
    const history = [marker, summary]
    const a = renderTurnContext([TIME, RECENT], lastSentSections(history), { afterCheckpoint: firstTurnAfterCheckpoint(history) })
    const b = renderTurnContext([TIME, RECENT], lastSentSections(history), { afterCheckpoint: firstTurnAfterCheckpoint(history) })
    expect(a).toBe(b)
    expect(a).toContain('key="recent"')
  })
})
