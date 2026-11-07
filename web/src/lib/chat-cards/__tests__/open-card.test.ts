// @vitest-environment jsdom
/**
 * Every way in opens a card (P5): what card each thing opens, where inside it
 * the card starts, and the request the dashboard hears.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isCardSpec } from '../kinds'
import { isPageCardSpec } from '../pages'
import { OPEN_CARD_EVENT, cardForTarget, openTarget, parseOpenCardRequest, type OpenTarget } from '../open-card'

const NOW = new Date('2026-10-09T15:00:00')

describe('cardForTarget', () => {
  it('opens each record as its record card, an action on its Cloud run when asked', () => {
    for (const type of ['action', 'capture', 'document', 'initiative', 'project', 'contact', 'company'] as const) {
      const card = cardForTarget({ type, id: `${type}-1`, title: `A ${type}` }, NOW)
      expect(card?.spec).toEqual({ kind: 'record', title: `A ${type}`, record: { type, id: `${type}-1` } })
      expect(isCardSpec(card?.spec)).toBe(true)
    }
    expect(cardForTarget({ type: 'action', id: 'a1', title: 'GEN-1', section: 'cloud' })?.spec).toEqual({
      kind: 'record',
      title: 'GEN-1',
      record: { type: 'action', id: 'a1', section: 'cloud' },
    })
    // A section only an action has is dropped elsewhere.
    expect(cardForTarget({ type: 'capture', id: 'c1', section: 'cloud' })?.spec).toEqual({
      kind: 'record',
      title: 'Capture',
      record: { type: 'capture', id: 'c1' },
    })
  })

  it('opens a calendar event on its own day, open on the card', () => {
    const card = cardForTarget({ type: 'calendar-event', id: 'ev1', title: 'Standup', start: '2026-10-14T09:30:00' }, NOW)
    expect(card?.spec).toEqual({ kind: 'calendar', title: 'Standup', calendar: { from: '2026-10-14', to: '2026-10-14', view: 'day' } })
    expect(card?.seed?.open).toEqual({ type: 'event', id: 'ev1', label: 'Standup' })
  })

  it('opens an event with no start on this week', () => {
    const card = cardForTarget({ type: 'calendar-event', id: 'ev1' }, NOW)
    expect(card?.spec.kind).toBe('calendar')
    if (card?.spec.kind !== 'calendar') return
    expect(card.spec.calendar.view).toBe('week')
    expect(card.spec.calendar.from <= '2026-10-09' && card.spec.calendar.to >= '2026-10-09').toBe(true)
  })

  it('opens a place inside a page as that page on it', () => {
    expect(cardForTarget({ type: 'sequence', id: 's1', title: 'Q4 outbound' })?.spec).toEqual({
      kind: 'sequences',
      title: 'Q4 outbound',
      target: { type: 'sequence', id: 's1', label: 'Q4 outbound' },
    })
    expect(cardForTarget({ type: 'prospect_list', id: 'p1' })?.spec).toMatchObject({
      kind: 'prospecting',
      target: { type: 'prospect_list', id: 'p1' },
    })
    expect(cardForTarget({ type: 'package', id: 'k1', title: 'Pricing' })?.spec).toMatchObject({ kind: 'knowledge', target: { type: 'package', id: 'k1' } })
    expect(cardForTarget({ type: 'skill', id: 'sk1' })?.spec).toMatchObject({ kind: 'library', tab: 'skills', target: { type: 'skill', id: 'sk1' } })
    expect(cardForTarget({ type: 'team_board', id: 't1', title: 'Eng' })?.spec).toMatchObject({ kind: 'team_board', target: { type: 'team', id: 't1' } })
    for (const t of ['sequence', 'prospect_list', 'package', 'agent', 'skill', 'team', 'team_board', 'eval_suite'] as const) {
      expect(isPageCardSpec(cardForTarget({ type: t, id: 'x' })?.spec)).toBe(true)
    }
  })

  it('opens an eval case inside its suite, with Back to the suite', () => {
    const card = cardForTarget({ type: 'eval_case', id: 'c1', title: 'Hard case', suiteId: 's1', suiteName: 'Triage' })
    expect(card?.spec).toMatchObject({ kind: 'evals', target: { type: 'eval_suite', id: 's1', label: 'Triage' } })
    expect(card?.seed).toEqual({
      at: { type: 'eval_case', id: 'c1', label: 'Hard case' },
      trail: [{ type: 'eval_suite', id: 's1', label: 'Triage' }],
    })
    expect(cardForTarget({ type: 'eval_run', id: 'r1', suiteId: '' })).toBeNull()
  })

  it('opens a flow on its editor', () => {
    const card = cardForTarget({ type: 'flow', id: 'f1', title: 'Triage loop' })
    expect(card?.spec).toEqual({ kind: 'flows', title: 'Triage loop' })
    expect(card?.seed).toEqual({ editing: 'f1' })
  })

  it('opens mail on its folder or thread, and an unknown folder on the inbox', () => {
    expect(cardForTarget({ type: 'mail', folder: 'drafts' })?.spec).toEqual({ kind: 'mail', title: 'Drafts', mail: { folder: 'drafts' } })
    expect(cardForTarget({ type: 'mail', folder: 'drafts', threadId: 'th1' })?.spec).toEqual({
      kind: 'mail',
      title: 'Thread',
      mail: { folder: 'drafts', thread_id: 'th1' },
    })
    expect(cardForTarget({ type: 'mail', folder: 'nope' })?.spec).toMatchObject({ mail: { folder: 'inbox' } })
  })

  it('opens a draft on its thread (draft_id), never a draft without its thread', () => {
    const spec = cardForTarget({ type: 'mail', folder: 'inbox', threadId: 'th1', draftId: 'msg-1' })?.spec
    expect(spec).toEqual({ kind: 'mail', title: 'Thread', mail: { folder: 'inbox', thread_id: 'th1', draft_id: 'msg-1' } })
    expect(isCardSpec(spec)).toBe(true)
    expect(cardForTarget({ type: 'mail', folder: 'drafts', threadId: null, draftId: 'msg-1' })?.spec).toEqual({ kind: 'mail', title: 'Drafts', mail: { folder: 'drafts' } })
    expect(isCardSpec({ kind: 'mail', title: 'T', mail: { folder: 'inbox', thread_id: 'th1', draft_id: 7 } })).toBe(false)
  })

  it('opens a work item (one with no bot’s page) on its own card', () => {
    const card = cardForTarget({ type: 'work_item', id: 'w1', title: 'Drafted replies' })
    expect(card).toEqual({
      spec: { kind: 'work_item', title: 'Drafted replies', target: { type: 'work_item', id: 'w1', label: 'Drafted replies' } },
    })
    expect(isCardSpec(card?.spec)).toBe(true)
    // Untitled: it says what it is.
    expect(cardForTarget({ type: 'work_item', id: 'w2' })?.spec).toEqual({
      kind: 'work_item',
      title: 'Work item',
      target: { type: 'work_item', id: 'w2', label: 'Work item' },
    })
  })

  it('opens a bot’s page, on one of its items when asked', () => {
    const page = cardForTarget({ type: 'bot', teammateId: 'tm1', name: 'Triage' })
    expect(page).toEqual({ spec: { kind: 'bot', title: 'Triage', target: { type: 'bot', id: 'tm1', label: 'Triage' } } })
    expect(isCardSpec(page?.spec)).toBe(true)
    const item = cardForTarget({ type: 'bot', teammateId: 'tm1', name: 'Triage', item: { itemId: 'w1', title: 'Sorted the inbox' } })
    expect(item?.seed).toEqual({ at: { type: 'work_item', id: 'w1', label: 'Sorted the inbox' } })
    expect(cardForTarget({ type: 'bot', teammateId: '' })).toBeNull()
  })

  it('opens a `/` page by its slug, and nothing for one that is not', () => {
    expect(cardForTarget({ type: 'page', slug: 'teams' }, NOW)?.spec).toEqual({ kind: 'teams', title: 'Teams' })
    // The inbox page went with the notifications page.
    expect(cardForTarget({ type: 'page', slug: 'inbox' }, NOW)).toBeNull()
    expect(cardForTarget({ type: 'page', slug: 'calendar' }, NOW)?.spec.kind).toBe('calendar')
    expect(cardForTarget({ type: 'page', slug: 'nav' }, NOW)).toBeNull()
  })

  it('opens nothing for a thing with no id', () => {
    expect(cardForTarget({ type: 'action', id: '' })).toBeNull()
    expect(cardForTarget({ type: 'what', id: 'x' } as unknown as OpenTarget)).toBeNull()
  })

  it('bounds and tidies titles', () => {
    const card = cardForTarget({ type: 'document', id: 'd1', title: `  a\n\n${'x'.repeat(300)}` })
    expect(card?.spec.title.startsWith('a x')).toBe(true)
    expect(card?.spec.title.length).toBe(120)
  })
})

describe('openTarget', () => {
  afterEach(() => vi.restoreAllMocks())

  it('asks the dashboard with the card, where it starts, where it came from and its workspace', () => {
    const heard: unknown[] = []
    const listen = (e: Event) => heard.push((e as CustomEvent).detail)
    window.addEventListener(OPEN_CARD_EVENT, listen)
    try {
      expect(openTarget({ type: 'flow', id: 'f1' }, { from: 'notification', workspaceId: 'ws-b' })).toBe(true)
      expect(openTarget({ type: 'action', id: '' }, { from: 'chip' })).toBe(false)
    } finally {
      window.removeEventListener(OPEN_CARD_EVENT, listen)
    }
    expect(heard).toEqual([{ spec: { kind: 'flows', title: 'Flows' }, seed: { editing: 'f1' }, from: 'notification', workspaceId: 'ws-b' }])
  })
})

describe('parseOpenCardRequest', () => {
  it('takes a well-formed request and refuses what is not a card', () => {
    expect(parseOpenCardRequest({ spec: { kind: 'teams', title: 'Teams' }, from: 'link' })).toEqual({ spec: { kind: 'teams', title: 'Teams' }, from: 'link' })
    expect(parseOpenCardRequest({ spec: { kind: 'nav', title: 'x' }, from: 'link' })).toBeNull()
    // The inbox card is gone.
    expect(parseOpenCardRequest({ spec: { kind: 'inbox', title: 'Inbox' }, from: 'link' })).toBeNull()
    expect(parseOpenCardRequest(null)).toBeNull()
    expect(parseOpenCardRequest({ spec: { kind: 'teams', title: 'Teams' } })?.from).toBe('link')
  })
})
