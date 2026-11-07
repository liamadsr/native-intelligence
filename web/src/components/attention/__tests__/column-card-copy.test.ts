/**
 * What a For you column card says (column-card-copy.ts): for every kind the
 * column can show, its verb, the sentence that carries on from it, its
 * focus-view details and what its pill does, worded only from what the card
 * holds (a title quoted as written, a recipient as the card names it), with
 * the card's own button label and title as the fallback.
 */
import { describe, expect, it } from 'vitest'
import type { AttentionItem } from '@/hooks/use-attention-items'
import type { WorkItem } from '@/lib/work/types'
import { attentionCopy, focusMetaLine, reviewCopy } from '../column-card-copy'

function card(over: Partial<AttentionItem> & { payload?: Record<string, unknown> } = {}): AttentionItem {
  return {
    id: 'c1',
    workspace_id: 'w1',
    member_id: 'm1',
    kind: 'action_card',
    title: 'Send Dana the pricing deck',
    why: 'Dana asked for it on Tuesday’s call.',
    proposal_id: 'p1',
    source_flow_run_id: null,
    status: 'pending',
    expires_at: null,
    created_at: '2026-10-16T08:00:00.000Z',
    ...over,
    payload: { change_type: 'create', entity_type: 'action', entity_id: null, ...(over.payload ?? {}) },
  } as AttentionItem
}

function work(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'r1',
    workspace_id: 'w1',
    member_id: 'm1',
    kind: 'work_run',
    status: 'needs_review',
    title: 'Reply to Dana',
    result_summary: 'Drafted a short reply with the deck attached.',
    deliverables: [],
    needs: null,
    created_at: '2026-10-16T08:00:00.000Z',
    ...over,
  } as WorkItem
}

const sentence = (c: { verb: string; sentence: string }) => `${c.verb} ${c.sentence}`

describe('attentionCopy', () => {
  it('a suggested action: Add it to your to-dos, done from the pill; its why, description and effect as the details', () => {
    const c = attentionCopy(card({ payload: { description: 'The Q4 deck, not the old one.' } }))
    expect(sentence(c)).toBe('Add “Send Dana the pricing deck” to your to-dos')
    expect(c.primary).toBe('act')
    expect(c.icon).toBe('action')
    expect(c.details).toEqual(['Dana asked for it on Tuesday’s call.', 'The Q4 deck, not the old one.', 'Creates action: Send Dana the pricing deck'])
  })

  it('a create of another entity names it', () => {
    expect(sentence(attentionCopy(card({ title: 'Use Stripe for billing', payload: { entity_type: 'decision' } })))).toBe('Add the decision “Use Stripe for billing”')
  })

  it('an update, a delete, an assign and a tool call', () => {
    expect(sentence(attentionCopy(card({ title: 'Move GEN-42 to Done', payload: { change_type: 'update', entity_id: 'a1' } })))).toBe('Apply the update “Move GEN-42 to Done”')
    expect(sentence(attentionCopy(card({ title: 'Old task', payload: { change_type: 'delete', entity_id: 'a1' } })))).toBe('Delete the action “Old task”')
    expect(attentionCopy(card({ title: 'Create a Linear issue', payload: { change_type: 'mcp_call', entity_type: 'external' } })).verb).toBe('Run')
  })

  it('assigned to an agent: Start it with that agent (named when its workspace’s list names it)', () => {
    const assigned = card({ payload: { assignee_ai_member_id: 'ai-1' } })
    expect(sentence(attentionCopy(assigned, { agentName: 'Coder' }))).toBe('Start “Send Dana the pricing deck” with Coder')
    expect(sentence(attentionCopy(assigned))).toBe('Start “Send Dana the pricing deck” with its agent')
  })

  it('a target-less update or an unsupported change opens the full card (its picker, or why it can’t apply)', () => {
    const targetless = attentionCopy(card({ title: 'Mark the launch done', payload: { change_type: 'update', entity_type: 'action', entity_id: null } }))
    expect(sentence(targetless)).toBe('Choose which action to update: “Mark the launch done”')
    expect(targetless.primary).toBe('full')
    const unsupported = attentionCopy(card({ payload: { change_type: 'teleport', entity_type: 'moon', entity_id: 'x' } }))
    expect(unsupported.verb).toBe('Review')
    expect(unsupported.primary).toBe('full')
  })

  it('a draft to write: Draft an email to the recipient, the subject quoted; a failed one is Retry', () => {
    const email = card({ kind: 'draft_email', title: 'Follow up with Dana', payload: { email_to_name: 'Dana Lee', email_subject: 'Pricing', email_context: 'Thank her and attach the deck.' } })
    const c = attentionCopy(email)
    expect(sentence(c)).toBe('Draft an email to Dana Lee: “Pricing”')
    expect(c.icon).toBe('mail')
    expect(c.details).toEqual(['Follow up with Dana', 'Dana asked for it on Tuesday’s call.', 'Thank her and attach the deck.'])
    expect(sentence(attentionCopy({ ...email, payload: { ...email.payload, draft_id: 'd1' } }))).toBe('Retry the draft to Dana Lee: “Pricing”')
    // No recipient: its title.
    expect(sentence(attentionCopy(card({ kind: 'draft_email', title: 'Thank the team', payload: {} })))).toBe('Draft “Thank the team”')
  })

  it('a work proposal: Start, the task in the details; an approval shows its inputs first; an FYI is Got it', () => {
    const proposal = attentionCopy(card({ kind: 'work_proposal', title: 'Draft the Q4 memo', payload: { task: 'Write a one-page memo from the board notes.' } }))
    expect(sentence(proposal)).toBe('Start “Draft the Q4 memo”')
    expect(proposal.details).toContain('Write a one-page memo from the board notes.')
    const approval = attentionCopy(card({ kind: 'approval', title: 'Post in #launch', payload: { tool: 'slack_post' } }))
    expect(sentence(approval)).toBe('Approve “Post in #launch”')
    expect(approval.primary).toBe('show')
    expect(sentence(attentionCopy(card({ kind: 'question', title: 'Dana is out until Monday' })))).toBe('Got it Dana is out until Monday')
  })
})

describe('reviewCopy', () => {
  it('a draft: Review the draft, opening its output; the item, its summary and what it waits on as the details', () => {
    const c = reviewCopy(work({ deliverables: [{ type: 'email_draft', id: 'd1', label: 'Re: pricing' }] }))
    expect(sentence(c)).toBe('Review the draft “Re: pricing”')
    expect(c.primary).toBe('act')
    expect(c.icon).toBe('mail')
    expect(c.details).toEqual(['Reply to Dana', 'Drafted a short reply with the deck attached.', 'Review 1 draft'])
  })

  it('a document, a pull request, cards; nothing delivered opens the item', () => {
    expect(sentence(reviewCopy(work({ deliverables: [{ type: 'document', id: 'doc1', label: 'Q4 memo' }] })))).toBe('Open “Q4 memo”')
    expect(sentence(reviewCopy(work({ deliverables: [{ type: 'pr', id: 'https://github.com/x/y/pull/1', label: 'Fix login' }] })))).toBe('Open the pull request “Fix login”')
    expect(sentence(reviewCopy(work({ deliverables: [{ type: 'attention_cards', id: 'run', label: 'cards', count: 3 }] })))).toBe('See 3 cards from “Reply to Dana”')
    const none = reviewCopy(work())
    expect(sentence(none)).toBe('Open “Reply to Dana”')
    expect(none.icon).toBeNull()
  })
})

describe('focusMetaLine', () => {
  it('the bot’s name once, then each bit once: an area label or kind named after the bot is left out, blanks go', () => {
    expect(focusMetaLine('Assistant', ['Assistant', 'Work run', 'Oct 2', 'Seen', 'Captures'])).toBe('Assistant · Work run · Oct 2 · Seen · Captures')
    expect(focusMetaLine('Writer', ['5m', 'writer', null, undefined, ' ', 'In Acme'])).toBe('Writer · 5m · In Acme')
    expect(focusMetaLine('Writer', [])).toBe('Writer')
  })
})
