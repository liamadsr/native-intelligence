/**
 * The deck's card model (ACTIVITY-AND-REVIEW-DESIGN §4.4): a work item waiting
 * on a review becomes a card keyed apart from the attention cards, dated from
 * when it started waiting.
 */
import { describe, it, expect } from 'vitest'
import type { AttentionItem } from '@/hooks/use-attention-items'
import type { WorkItem } from '@/lib/work/types'
import { REVIEW_CARD_ID_PREFIX, isReviewCard, reviewCardOf } from '../rail-cards'

function attention(id: string, createdAt: string): AttentionItem {
  return {
    id,
    workspace_id: 'ws-1',
    member_id: 'm-1',
    kind: 'action_card',
    title: `Card ${id}`,
    why: null,
    payload: {},
    proposal_id: null,
    source_flow_run_id: null,
    status: 'pending',
    expires_at: null,
    created_at: createdAt,
  }
}

function work(id: string, over: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    workspace_id: 'ws-2',
    member_id: 'm-2',
    kind: 'email_drafts',
    title: `Reply to ${id}`,
    status: 'needs_review',
    actor: 'loop',
    current_step: null,
    progress: {},
    result_summary: null,
    error_message: null,
    skip_reason: null,
    deliverables: [],
    needs: { kind: 'review', verb: 'send' },
    source: {},
    run_key: null,
    agent_run_id: null,
    flow_run_id: null,
    created_at: '2026-09-18T08:00:00.000Z',
    started_at: '2026-09-18T08:00:00.000Z',
    finished_at: '2026-09-18T08:05:00.000Z',
    reviewed_at: null,
    last_beat_at: '2026-09-18T08:05:00.000Z',
    deadline_at: null,
    ...over,
  }
}

describe('reviewCardOf', () => {
  it('keys the card apart from attention cards and dates it from when the item started waiting', () => {
    const card = reviewCardOf(work('w1'))
    expect(card.kind).toBe('work_review')
    expect(card.id).toBe(`${REVIEW_CARD_ID_PREFIX}w1`)
    expect(card.workspace_id).toBe('ws-2')
    expect(card.title).toBe('Reply to w1')
    expect(card.created_at).toBe('2026-09-18T08:05:00.000Z')
    expect(card.work.id).toBe('w1')
    expect(isReviewCard(card)).toBe(true)
    expect(isReviewCard(attention('a', '2026-09-18T09:00:00.000Z'))).toBe(false)
  })
})
