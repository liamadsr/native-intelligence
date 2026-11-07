/**
 * The promote editor's draft (case-editor.tsx): prefilled from a case saved
 * on the row before, else from buildCaseDraft; the form's fields go back into
 * a draft that validateCaseDraft accepts, keeping what the form doesn't edit.
 */
import { describe, it, expect } from 'vitest'
import { validateCaseDraft } from '@/lib/evals/flywheel/case-schema'
import { draftFromFields, initialDraft } from '../case-editor'
import { candidateSummary, type AdminEvalCandidate } from '../labels'

const row = (over: Partial<AdminEvalCandidate> = {}): AdminEvalCandidate => ({
  id: 'c1',
  workspace_id: 'w1',
  user_id: 'u1',
  source: 'input_invalid',
  polarity: 'bad',
  ref_type: 'chat_message',
  ref_id: 'm1',
  conversation_id: 'conv-1',
  skill_slugs: ['meeting-prep'],
  tools: ['get_meeting_prep'],
  reason: null,
  evidence: {
    kind: 'chat_turn',
    request: 'Prep me for my 3pm',
    steps: [{ name: 'get_meeting_prep', ok: false, code: 'INPUT_INVALID', error: 'event_id required' }],
    loads: ['meeting-prep'],
    messageId: 'm1',
  },
  dedupe_key: 'chat:m1:INPUT_INVALID',
  status: 'new',
  case_draft: null,
  reviewed_by: null,
  reviewed_at: null,
  exported_at: null,
  created_at: '2026-10-16T10:00:00Z',
  updated_at: '2026-10-16T10:00:00Z',
  ...over,
})

const fields = {
  skill: 'meeting-prep',
  request: 'Prep me for my 3pm',
  loads: 'meeting-prep',
  tools: 'get_calendar_events, get_meeting_prep',
  avoid: '',
  params: '',
  why: '',
  noToolErrors: true,
}

describe('initialDraft', () => {
  it('drafts from the evidence', () => {
    const d = initialDraft(row())
    expect(d.skill).toBe('meeting-prep')
    expect(d.case.request).toBe('Prep me for my 3pm')
    expect(d.case.tools).toEqual(['get_meeting_prep'])
  })

  it('prefers a case saved on the row', () => {
    const saved = { skill: 'instructions', case: { request: 'Saved', loads: [], tools: ['find'] } }
    expect(initialDraft(row({ case_draft: saved }))).toEqual(saved)
  })
})

describe('draftFromFields', () => {
  it('builds a draft validateCaseDraft accepts', () => {
    const built = draftFromFields(initialDraft(row()), {
      ...fields,
      avoid: 'delete_action',
      params: '{ "get_meeting_prep": { "event_id": "e1" } }',
      why: '  needs the event first ',
    })
    expect(built.ok).toBe(true)
    const checked = validateCaseDraft(built.ok ? built.value : null)
    expect(checked.ok).toBe(true)
    if (!checked.ok) return
    expect(checked.value.case).toEqual({
      request: 'Prep me for my 3pm',
      loads: ['meeting-prep'],
      tools: ['get_calendar_events', 'get_meeting_prep'],
      avoid: ['delete_action'],
      params: { get_meeting_prep: { event_id: 'e1' } },
      why: 'needs the event first',
      noToolErrors: true,
    })
  })

  it('drops cleared optional fields and keeps the ones it does not edit', () => {
    const base = { skill: 'x', case: { request: 'r', loads: [], tools: [], avoid: ['a'], why: 'w', noToolErrors: true, forbidParams: { create_flow: { confirmed_with_user: true } } } }
    const built = draftFromFields(base, { ...fields, noToolErrors: false })
    expect(built.ok && (built.value as { case: Record<string, unknown> }).case).toEqual({
      request: 'Prep me for my 3pm',
      loads: ['meeting-prep'],
      tools: ['get_calendar_events', 'get_meeting_prep'],
      forbidParams: { create_flow: { confirmed_with_user: true } },
    })
  })

  it('refuses params that are not JSON', () => {
    expect(draftFromFields(initialDraft(row()), { ...fields, params: '{ nope' })).toEqual({ ok: false, error: 'params: not valid JSON' })
  })
})

describe('candidateSummary', () => {
  it('names the request, the job or the rewrite', () => {
    expect(candidateSummary(row())).toBe('Prep me for my 3pm')
    expect(candidateSummary(row({ source: 'loop_failed', evidence: { kind: 'loop_run', jobKind: 'flow_run', title: 'Weekly digest' } }))).toBe('Weekly digest')
    expect(
      candidateSummary(row({ source: 'draft_rewrite', evidence: { kind: 'draft_rewrite', similarity: 0.234, wordsBefore: 80, wordsAfter: 60, origin: 'chat' } })),
    ).toBe('Draft rewritten: 23% of its words kept')
  })
})
