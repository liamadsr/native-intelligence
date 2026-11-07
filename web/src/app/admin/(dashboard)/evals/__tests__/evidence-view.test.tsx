/**
 * /admin/evals evidence for a rated live nudge: its pointers (kind, capture,
 * when, the call's goal) and the thumbs-down reason chip, by its label. An
 * unknown chip value shows nothing.
 */
import { describe, it, expect } from 'vitest'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { EvidenceView } from '../evidence-view'
import type { AdminEvalCandidate } from '../labels'

const row = (evidence: Record<string, unknown>) =>
  ({ id: 'ec1', source: 'thumbs_down', reason: null, evidence }) as unknown as AdminEvalCandidate

const nudge = {
  kind: 'chat_turn',
  request: '(nobody typed this: a nudge the live agent sent on its own)',
  reply: 'Ask who signs off.',
  steps: [],
  loads: [],
  messageId: 'n1',
  nudge_kind: 'reminder',
  capture_id: 'cap-1',
  nudge_at: '2026-10-16T10:01:00.000Z',
  meeting_goal_id: 'goal-1',
}

describe('EvidenceView: a nudge', () => {
  it('shows the pointers and the reason chip by its label', () => {
    const html = renderToStaticMarkup(h(EvidenceView, { row: row({ ...nudge, nudge_reason: 'too_late' }) }))
    for (const text of ['Nudge kind', 'reminder', 'cap-1', '2026-10-16T10:01:00.000Z', 'goal-1', 'Nudge reason', 'Too late']) expect(html).toContain(text)
  })

  it('an unknown chip value is not shown', () => {
    const html = renderToStaticMarkup(h(EvidenceView, { row: row({ ...nudge, nudge_reason: 'boring' }) }))
    expect(html).not.toContain('Nudge reason')
    expect(html).not.toContain('boring')
  })
})
