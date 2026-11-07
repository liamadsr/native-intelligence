/**
 * A held call's outcome (GEN-1172): one `approval-…` section per call, diffed
 * by its hash like any other, so each goes out once (and again when it moves
 * from running to ran), and never marked cleared when a later turn lacks it.
 */
import { describe, it, expect } from 'vitest'
import { lastSentSections, renderTurnContext } from '../turn-context.js'

const TIME = { key: 'time', markdown: 'Current date and time: Tuesday, October 27, 2026 at 10:05 AM EDT' }
const RUNNING = { key: 'approval-0b9c1d2e3f40', markdown: '## Approved call running: `mcp__supabase__execute_sql`' }
const RAN = { key: 'approval-0b9c1d2e3f40', markdown: '## Approved call finished: `mcp__supabase__execute_sql`\n[{"count": 42}]' }
const VIEW = { key: 'view', markdown: 'The user is viewing: Mail' }
const block = (content: string) => ({ role: 'user', kind: 'context.instruction', content })

describe('renderTurnContext with a held call’s outcome', () => {
  it('sends it once', () => {
    const first = renderTurnContext([TIME, RAN], new Map())!
    expect(first).toContain('<section key="approval-0b9c1d2e3f40" v="')
    expect(first).toContain('[{"count": 42}]')
    const again = renderTurnContext([TIME, RAN], lastSentSections([block(first)]))!
    expect(again).not.toContain('approval-')
  })

  it('sends it again when the call goes from running to ran', () => {
    const first = renderTurnContext([TIME, RUNNING], new Map())!
    const later = renderTurnContext([TIME, RAN], lastSentSections([block(first)]))!
    expect(later).toContain('Approved call finished')
  })

  it('is never marked cleared when a later turn lacks it, while other sections still are', () => {
    const first = renderTurnContext([TIME, RAN, VIEW], new Map())!
    const later = renderTurnContext([TIME], lastSentSections([block(first)]))!
    expect(later).not.toContain('approval-')
    expect(later).toContain('<section key="view" cleared="true"/>')
  })
})

// A guest's note to the owner (src/lib/guests/guest-notes.ts): what they said stays said.
describe('renderTurnContext with a guest’s note', () => {
  const NOTE = { key: 'guest-note-e63d52a49042', markdown: '## A note from Jess (Wife)' }

  it('sends it once, and never marks it cleared when a later turn lacks it', () => {
    const first = renderTurnContext([TIME, NOTE, VIEW], new Map())!
    expect(first).toContain('<section key="guest-note-e63d52a49042" v="')
    const again = renderTurnContext([TIME, NOTE, VIEW], lastSentSections([block(first)]))!
    expect(again).not.toContain('guest-note-')
    const later = renderTurnContext([TIME], lastSentSections([block(first)]))!
    expect(later).not.toContain('guest-note-')
    expect(later).toContain('<section key="view" cleared="true"/>')
  })
})
