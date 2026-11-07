// @vitest-environment jsdom
/**
 * Calendar and mail cards in the chat's store (P2): where the person moves a
 * card is kept with it (per device, surviving a reload) and becomes the turn's
 * entry, so the agent's note and read_card describe what is on screen now.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatCardStore } from '../card-store'
import { parseCardContext, renderCardsSection } from '@/lib/chat-cards/context'
import type { CalendarCardSpec, MailCardSpec } from '@/lib/chat-cards/kinds'

// The bodies' pure helpers, without their heavy pages.
vi.mock('@/app/account/(dashboard)/views/calendar-view', () => ({ CalendarCardView: () => null }))
vi.mock('@/app/account/(dashboard)/views/calendar-event-detail-panel', () => ({ CalendarEventDetailPanel: () => null }))
vi.mock('@/components/email/email-layout', () => ({ EmailLayout: () => null }))
vi.mock('../card-body', () => ({ CardRecordPanel: () => null, isRecordType: () => false, useOpenRecords: () => ({}) }))
const { queryOfCardState, eventRow } = await import('../calendar-card-body')
const { cardStateToQuery, threadRow } = await import('../mail-card-body')

const CAL: CalendarCardSpec = { kind: 'calendar', title: 'My week', calendar: { from: '2026-10-04', to: '2026-10-10', view: 'week' } }
const MAIL: MailCardSpec = { kind: 'mail', title: 'Invoice', mail: { folder: 'inbox', thread_id: 't1' } }

beforeEach(() => window.localStorage.clear())

describe('a calendar card the person moves', () => {
  it('turns where the grid is into the range it shows, and the turn carries before and after', () => {
    const store = new ChatCardStore()
    store.setCards([{ id: 'cal', spec: CAL }])
    // An untouched card: the agent knows it from its show result.
    expect(renderCardsSection(parseCardContext(store.contextEntries()))).toBeNull()

    store.update('cal', { cal: queryOfCardState({ view: 'month', date: '2026-11-12', accounts: null }) }, { touch: true })
    store.update('cal', { count: 3, rows: [{ title: 'Thu 12 10:00 Board' }] })
    const [entry] = store.contextEntries()
    expect(entry.cal).toMatchObject({ cur: { from: '2026-11-01', to: '2026-11-30', view: 'month' }, base: CAL.calendar })
    // The zone it is drawn in rides along, for read_card.
    expect(entry.cal?.tz).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    expect(renderCardsSection(parseCardContext([entry]))).toContain('  you changed: week Oct 4–10 → Nov 2026 · 3 events')

    // Kept per device: a new store (a reload) rebuilds the same entry.
    const reloaded = new ChatCardStore()
    reloaded.setCards([{ id: 'cal', spec: CAL }])
    expect(reloaded.contextEntries()[0].cal?.cur).toEqual({ from: '2026-11-01', to: '2026-11-30', view: 'month' })
  })

  it('names an event in a few words', () => {
    expect(eventRow({ id: 'e', title: 'Standup', startDate: '2026-10-08T10:00:00', endDate: '2026-10-08T10:15:00', color: 'blue', description: '' })).toBe('Thu 8 10:00 Standup')
    expect(eventRow({ id: 'e', title: 'Offsite', startDate: '2026-10-09T00:00:00', endDate: '2026-10-10T00:00:00', isAllDay: true, color: 'blue', description: '' })).toBe('Fri 9 all day Offsite')
  })
})

describe('a mail card the person changes', () => {
  it('stays a thread card while its thread is open', () => {
    expect(cardStateToQuery(MAIL, { folder: 'inbox', search: '', accounts: null, threadId: 't1' })).toEqual({ mail: { folder: 'inbox', thread_id: 't1' }, open: null })
  })

  it('becomes the folder when the person goes back to it, and another thread is open inside, by its sender', () => {
    expect(cardStateToQuery(MAIL, { folder: 'archive', search: ' acme ', accounts: ['a1'], threadId: null })).toEqual({
      mail: { folder: 'archive', search: 'acme', accounts: ['a1'] },
      open: null,
    })
    expect(cardStateToQuery(MAIL, { folder: 'inbox', search: '', accounts: null, threadId: 't7', threadFrom: 'Bob' })).toEqual({
      mail: { folder: 'inbox' },
      open: { type: 'thread', id: 't7', label: 'from Bob' },
    })
  })

  it('reaches the turn as before and after', () => {
    const store = new ChatCardStore()
    store.setCards([{ id: 'm', spec: MAIL }])
    const { mail, open } = cardStateToQuery(MAIL, { folder: 'inbox', search: '', accounts: null, threadId: null })
    store.update('m', { mail, open, count: 30, rows: [{ title: threadRow({ from_name: 'Sarah', from_email: 's@x.com', subject: 'Hi' }) }] }, { touch: true })
    const text = renderCardsSection(parseCardContext(store.contextEntries()))!
    expect(text).toContain('card 1 · "Invoice" (mail)')
    expect(text).toContain('  you changed: thread t1 → inbox · 30 threads')
    expect(text).toContain('Sarah: Hi')
  })
})
