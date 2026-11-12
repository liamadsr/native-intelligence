/**
 * The pure routing decision behind every deliverable row (§4.3): one target per
 * type, the way the item route's context shapes it. Every way in opens a card
 * (P5): a record its record card, a list its page's card, a draft the Mail card.
 */
import { describe, it, expect } from 'vitest'

import { deliverableTarget } from '../open-deliverable'

describe('deliverableTarget', () => {
  it('opens entities as their record cards', () => {
    expect(deliverableTarget({ type: 'document', id: 'doc-1', label: 'Q3 recap' })).toEqual({
      kind: 'card',
      target: { type: 'document', id: 'doc-1', title: 'Q3 recap' },
    })
    expect(deliverableTarget({ type: 'action', id: 'a1', label: 'GEN-42' })).toMatchObject({ kind: 'card', target: { type: 'action', id: 'a1' } })
    for (const type of ['capture', 'contact', 'company'] as const) {
      expect(deliverableTarget({ type, id: 'x1', label: 'X' })).toMatchObject({ kind: 'card', target: { type, id: 'x1' } })
    }
  })

  it('opens a prospect list as the Prospecting card on it', () => {
    expect(deliverableTarget({ type: 'prospect_list', id: 'pl-1', label: 'Q4 targets' })).toEqual({
      kind: 'card',
      target: { type: 'prospect_list', id: 'pl-1', title: 'Q4 targets' },
    })
  })

  it('opens a Studio export as the Studio on its video (the download link rides along, not the target)', () => {
    expect(deliverableTarget({ type: 'studio_video', id: 'v-1', label: 'Spring launch', url: '/api/account/studio/file/ws/exports/j/video.mp4' })).toEqual({
      kind: 'card',
      target: { type: 'studio_video', id: 'v-1', title: 'Spring launch' },
    })
  })

  it('opens a PR or link externally, and refuses anything that is not http(s)', () => {
    expect(deliverableTarget({ type: 'pr', id: 'https://github.com/o/r/pull/7', label: 'PR' })).toEqual({
      kind: 'url',
      url: 'https://github.com/o/r/pull/7',
    })
    expect(deliverableTarget({ type: 'url', id: 'javascript:alert(1)', label: 'x' })).toMatchObject({ kind: 'none' })
  })

  it('opens a draft in Mail on its thread when the route resolved it, else on Drafts', () => {
    expect(
      deliverableTarget(
        { type: 'email_draft', id: 'd1', label: 'Re: A' },
        { drafts: { d1: { provider_thread_id: 'thr-9', provider_draft_id: 'msg-9', folder: 'inbox' } } },
      ),
    ).toEqual({ kind: 'card', target: { type: 'mail', folder: 'inbox', threadId: 'thr-9', draftId: 'msg-9' } })
    expect(deliverableTarget({ type: 'email_draft', id: 'd2', label: 'Re: B' })).toEqual({
      kind: 'card',
      target: { type: 'mail', folder: 'drafts', threadId: null, draftId: null },
    })
  })

  it('opens cards on the item that surfaced them — the panel shows them inline', () => {
    expect(deliverableTarget({ type: 'attention_cards', id: 'fr-1', label: '2 cards', count: 2 }, { itemId: 'job-1' })).toEqual({
      kind: 'card',
      target: { type: 'work_item', id: 'job-1', title: '2 cards' },
    })
  })

  it('falls back to the run that surfaced the cards when there is no item to open', () => {
    expect(deliverableTarget({ type: 'attention_cards', id: 'fr-1', label: '2 cards', count: 2 })).toEqual({ kind: 'flow_run', runId: 'fr-1' })
    expect(deliverableTarget({ type: 'attention_cards', id: 'fr-1', label: '2 cards' }, { drafts: {} })).toEqual({ kind: 'flow_run', runId: 'fr-1' })
  })

  it('opens a run on the flow run, item or not', () => {
    expect(deliverableTarget({ type: 'flow_run', id: 'fr-2', label: 'Run' })).toEqual({ kind: 'flow_run', runId: 'fr-2' })
    expect(deliverableTarget({ type: 'flow_run', id: 'fr-2', label: 'Run' }, { itemId: 'job-1' })).toEqual({ kind: 'flow_run', runId: 'fr-2' })
  })
})
