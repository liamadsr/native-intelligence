/**
 * The `away` section's rule (A6, "while you were away"): diffed by its hash
 * like any section, so the same section never goes out twice (a retried
 * build of the same turn renders the same bytes), but never marked cleared
 * when a later turn lacks it (the spec sends it only on the first turn after
 * a gap).
 */
import { describe, it, expect } from 'vitest'
import { lastSentSections, renderTurnContext } from '../turn-context.js'

const TIME = { key: 'time', markdown: 'Current date and time: Wednesday, October 14, 2026 at 10:05 AM EDT' }
const AWAY = { key: 'away', markdown: 'While you were away: …\n1 waiting on you\n- Waiting on you: Acme (it has a question)' }
const VIEW = { key: 'view', markdown: 'The user is viewing: Mail' }
const block = (content: string) => ({ role: 'user', kind: 'context.instruction', content })

describe('renderTurnContext with the away section', () => {
  it('sends it when present and new', () => {
    const out = renderTurnContext([TIME, AWAY], new Map())!
    expect(out).toContain('<section key="away" v="')
    expect(out).toContain('Waiting on you: Acme')
  })

  it('does not send the same section twice', () => {
    const first = renderTurnContext([TIME, AWAY], new Map())!
    const again = renderTurnContext([TIME, AWAY], lastSentSections([block(first)]))!
    expect(again).not.toContain('key="away"')
  })

  it('is never marked cleared when a later turn lacks it, while other sections still are', () => {
    const first = renderTurnContext([TIME, AWAY, VIEW], new Map())!
    const later = renderTurnContext([TIME], lastSentSections([block(first)]))!
    expect(later).not.toContain('away')
    expect(later).toContain('<section key="view" cleared="true"/>')
  })
})
