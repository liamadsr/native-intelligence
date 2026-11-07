import { describe, it, expect } from 'vitest'
import { buildCaseDraft, type CaseDraftInput } from '../case-draft'
import { validateCaseDraft } from '../case-schema'
import type { ChatTurnEvidence, DraftDismissedEvidence, DraftRewriteEvidence, LoopRunEvidence } from '../types'

const turn: ChatTurnEvidence = {
  kind: 'chat_turn',
  request: "what's on my plate today?",
  reply: 'Here is your list…',
  messageId: 'm-1',
  loads: ['my-todo-list'],
  steps: [
    { name: 'load_skill', input: '{"skill":"my-todo-list"}', ok: true },
    { name: 'list_actions', input: '{"filter":"today_and_overdue"}', ok: false, code: 'INPUT_INVALID', error: 'list_actions: filter is not an option [INPUT_INVALID]' },
    { name: 'list_actions', input: '{"filter":"today"}', ok: true },
    { name: 'list_actions', input: '{"filter":"overdue"}', ok: true },
    { name: 'show', input: '{}', ok: true },
  ],
}

function row(over: Partial<CaseDraftInput>): CaseDraftInput {
  return { source: 'thumbs_down', polarity: 'bad', evidence: turn, reason: null, skill_slugs: ['my-todo-list'], tools: ['load_skill', 'list_actions', 'show'], ...over }
}

describe('buildCaseDraft', () => {
  it('thumbs_up: keep doing this, the successful calls in order (a run of retries kept once)', () => {
    const d = buildCaseDraft(row({ source: 'thumbs_up', polarity: 'good', reason: 'exactly right' }))
    expect(d).toEqual({
      skill: 'my-todo-list',
      case: {
        request: "what's on my plate today?",
        loads: ['my-todo-list'],
        tools: ['load_skill', 'list_actions', 'show'],
        noToolErrors: true,
        why: 'Thumbs-up: keep doing this. "exactly right"',
      },
    })
    expect(validateCaseDraft(d).ok).toBe(true)
  })

  it('input_invalid: the same request, the tool that failed, no errors this time', () => {
    const d = buildCaseDraft(row({ source: 'input_invalid' }))
    expect(d.skill).toBe('my-todo-list')
    expect(d.case).toEqual({
      request: "what's on my plate today?",
      loads: ['my-todo-list'],
      tools: ['list_actions'],
      noToolErrors: true,
      why: 'INPUT_INVALID on list_actions: list_actions: filter is not an option [INPUT_INVALID]',
    })
  })

  it('repeated_failure: the step with that code, else the first failed step', () => {
    const steps = [
      { name: 'search_tools', ok: true },
      { name: 'create_action', ok: false, code: 'NOT_FOUND', error: 'no project' },
      { name: 'update_action', ok: false, code: 'REPEATED_FAILURE', error: 'This exact call failed 3 times.' },
    ]
    const d = buildCaseDraft(row({ source: 'repeated_failure', evidence: { ...turn, steps } }))
    expect(d.case.tools).toEqual(['update_action'])
    expect(d.case.why).toBe('REPEATED_FAILURE on update_action: This exact call failed 3 times.')
    const first = buildCaseDraft(row({ source: 'repeated_failure', evidence: { ...turn, steps: steps.slice(0, 2) } }))
    expect(first.case.tools).toEqual(['create_action'])
    expect(first.case.why).toBe('REPEATED_FAILURE on create_action (failed with NOT_FOUND): no project')
    // No step failed in the evidence: the row's first tool.
    expect(buildCaseDraft(row({ source: 'repeated_failure', evidence: { ...turn, steps: [] }, tools: ['create_action'] })).case.tools).toEqual(['create_action'])
  })

  it('thumbs_down: the request and loads; tools and avoid empty for the reviewer; the reason and failed steps in why', () => {
    const d = buildCaseDraft(row({ reason: 'it ignored my overdue work' }))
    expect(d).toEqual({
      skill: 'my-todo-list',
      case: {
        request: "what's on my plate today?",
        loads: ['my-todo-list'],
        tools: [],
        avoid: [],
        why: 'Thumbs-down: "it ignored my overdue work". Failed steps: list_actions [INPUT_INVALID]: list_actions: filter is not an option [INPUT_INVALID].',
      },
    })
    expect(buildCaseDraft(row({ evidence: { ...turn, steps: [] } })).case.why).toBe('Thumbs-down (no reason given).')
  })

  it('the skill: the first loaded skill, else instructions', () => {
    expect(buildCaseDraft(row({ evidence: { ...turn, loads: [] }, skill_slugs: [] })).skill).toBe('instructions')
    expect(buildCaseDraft(row({ evidence: { ...turn, loads: [] }, skill_slugs: ['crm-playbook'] })).skill).toBe('crm-playbook')
    expect(buildCaseDraft(row({ evidence: { ...turn, loads: ['Not A Slug', 'meeting-prep'] } })).skill).toBe('meeting-prep')
  })

  it('loop_failed: no request; the job and its error in why; the skill it ran when known', () => {
    const job: LoopRunEvidence = {
      kind: 'loop_run',
      jobKind: 'flow_run',
      title: 'Daily brief',
      error: 'list_emails: provider token expired',
      flowErrors: [{ action: 'send_digest', error: 'no recipients' }],
      skill: 'clear-inbox',
    }
    const d = buildCaseDraft(row({ source: 'loop_failed', evidence: job, skill_slugs: [] }))
    expect(d).toEqual({
      skill: 'clear-inbox',
      case: {
        request: '',
        loads: ['clear-inbox'],
        tools: [],
        why: 'Background job failed (flow_run: Daily brief). Error: list_emails: provider token expired Failed actions: send_digest: no recipients. Write the chat request that reproduces it.',
      },
    })
    // The admin editor requires the request before it saves.
    expect(validateCaseDraft(d).ok).toBe(false)
    const unknown = buildCaseDraft(row({ source: 'loop_failed', evidence: { kind: 'loop_run', jobKind: 'helper' }, skill_slugs: [] }))
    expect(unknown.skill).toBe('instructions')
    expect(unknown.case.loads).toEqual([])
  })

  it('draft_rewrite: write-in-your-tone, the similarity in why, never mail text', () => {
    const draft: DraftRewriteEvidence = { kind: 'draft_rewrite', similarity: 0.214, wordsBefore: 120, wordsAfter: 64, origin: 'automatic', providerThreadId: 't-1' }
    const d = buildCaseDraft(row({ source: 'draft_rewrite', evidence: draft, skill_slugs: [] }))
    expect(d.skill).toBe('write-in-your-tone')
    expect(d.case).toEqual({
      request: '',
      loads: ['write-in-your-tone'],
      tools: [],
      why: 'Draft rewritten heavily before sending: 21% of its words kept (120 → 64 words; automatic draft). Read the thread live, then write the request that drafts it.',
    })
  })

  it('draft_dismissed: the inbox’s case, or the drafter’s for a wrong draft; the reason in why, never mail text', () => {
    const noReply: DraftDismissedEvidence = { kind: 'draft_dismissed', reason: 'no_reply_needed', origin: 'automatic', by: 'agent', recipientDomain: 'reply2.squareup.com' }
    const d = buildCaseDraft(row({ source: 'draft_dismissed', evidence: noReply, reason: 'a receipt', skill_slugs: [] }))
    expect(d.skill).toBe('clear-inbox')
    expect(d.case).toEqual({
      request: '',
      loads: ['clear-inbox'],
      tools: [],
      why: 'Draft dismissed by the agent at their word: nothing in the thread needed a reply (automatic draft to reply2.squareup.com). "a receipt" Read the thread live, then write the request that should (or should not) draft it.',
    })
    const bad = buildCaseDraft(row({ source: 'draft_dismissed', evidence: { ...noReply, reason: 'bad_draft', by: 'person' }, skill_slugs: [] }))
    expect(bad.skill).toBe('write-in-your-tone')
    expect(bad.case.why).toMatch(/^Draft dismissed by the person: a reply was owed, but the draft was wrong/)
  })

  it('copes with empty evidence', () => {
    const d = buildCaseDraft(row({ source: 'thumbs_down', evidence: {}, skill_slugs: [] }))
    expect(d).toEqual({ skill: 'instructions', case: { request: '', loads: [], tools: [], avoid: [], why: 'Thumbs-down (no reason given).' } })
  })

  it('clips why to the reason limit', () => {
    const d = buildCaseDraft(row({ reason: 'x'.repeat(2000) }))
    expect(d.case.why!.length).toBeLessThanOrEqual(500)
    expect(d.case.why!.endsWith('…')).toBe(true)
  })
})
