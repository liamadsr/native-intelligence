// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { ChatCardStore, MAX_CONTEXT_CHARS } from '../card-store'
import { renderCardsSection, parseCardContext } from '@/lib/chat-cards/context'
import type { CardSpec } from '@/lib/chat-cards/kinds'

function list(title: string): CardSpec {
  return { kind: 'list', title, entity_type: 'action', filters: [{ field: 'title', operator: 'contains', value: title.toLowerCase() }] }
}

function storeWith(n: number): ChatCardStore {
  const store = new ChatCardStore()
  store.setCards(Array.from({ length: n }, (_, i) => ({ id: `call_${i + 1}`, spec: list(`Card ${i + 1}`) })))
  return store
}

beforeEach(() => window.localStorage.clear())

describe('ChatCardStore', () => {
  it('numbers cards by their place in the chat', () => {
    const store = storeWith(3)
    expect(store.card('call_1')?.n).toBe(1)
    expect(store.card('call_3')?.n).toBe(3)
  })

  it('keeps only the newest three live: an older card folds to its pill until the person expands it', () => {
    const store = storeWith(5)
    expect(['call_1', 'call_2', 'call_3', 'call_4', 'call_5'].map((id) => store.isCollapsed(id))).toEqual([true, true, false, false, false])
    store.expand('call_1')
    expect(store.isCollapsed('call_1')).toBe(false)
    store.collapse('call_1')
    expect(store.isCollapsed('call_1')).toBe(true)
  })

  it("keeps each card's stamped number when the chat trims its front, so the note and read_card still agree", () => {
    const store = new ChatCardStore()
    store.setCards([
      { id: 'a', spec: list('A'), number: 1 },
      { id: 'b', spec: list('B'), number: 2 },
      { id: 'c', spec: list('C'), number: 3 },
    ])
    // The oldest messages fall off (retention): b and c keep their numbers.
    store.setCards([
      { id: 'b', spec: list('B'), number: 2 },
      { id: 'c', spec: list('C'), number: 3 },
    ])
    expect(store.card('c')?.n).toBe(3)
    expect(store.contextEntries().map((e) => [e.id, e.n])).toEqual([['c', 3], ['b', 2]])
    // A card from a runtime that stamps none numbers on past the highest.
    store.setCards([
      { id: 'b', spec: list('B'), number: 2 },
      { id: 'c', spec: list('C'), number: 3 },
      { id: 'd', spec: list('D'), number: null },
    ])
    expect(store.card('d')?.n).toBe(4)
  })

  it('has one full-screen card at most, and collapsing it puts it back', () => {
    const store = storeWith(2)
    store.enterFullScreen('call_1')
    store.enterFullScreen('call_2')
    expect(store.fullScreen()).toBe('call_2')
    store.collapse('call_2')
    expect(store.fullScreen()).toBeNull()
  })

  it('keeps the person\'s changes per device, keyed by the tool call, and a fresh store reads them back', () => {
    const store = storeWith(1)
    store.update('call_1', { search: 'pricing', overrides: { layout: 'board' } }, { touch: true })
    const again = storeWith(1)
    expect(again.state('call_1')).toMatchObject({ search: 'pricing', overrides: { layout: 'board' } })
    expect(again.state('call_1').touchedAt).toBeGreaterThan(0)
  })

  it("sends the hand change in the turn's cards so the note shows it as a before and after", () => {
    const store = storeWith(2)
    const base = { filters: [{ field: 'title', operator: 'contains' as const, value: 'card 2' }] }
    store.update('call_2', {
      base,
      cur: { filters: [{ field: 'assignee_id', operator: 'is' as const, value: '@me' }] },
      count: 4,
      rows: [{ identifier: 'GEN-7', title: 'Mine' }],
    }, { touch: true })
    const entries = store.contextEntries()
    expect(entries.map((e) => e.n)).toEqual([2, 1])
    // What the server reads back is what it renders from.
    const note = renderCardsSection(parseCardContext(JSON.parse(JSON.stringify(entries))))
    expect(note).toContain('card 2 · "Card 2" (actions)')
    expect(note).toContain('you changed: title~"card 2" → assignee_id=me · 4 rows')
    expect(note).toContain('GEN-7 "Mine"')
    expect(note).not.toContain('card 1')
  })

  it('a card that never mounted still carries its spec, for read_card', () => {
    const entries = storeWith(1).contextEntries()
    expect(entries[0]).toMatchObject({ n: 1, kind: 'list', entity: 'action', cur: { filters: [{ field: 'title', operator: 'contains', value: 'card 1' }] } })
    expect(entries[0].base).toBeUndefined()
  })

  it('sends one card too big for the header as its number and title alone', () => {
    const store = new ChatCardStore()
    const huge = 'y'.repeat(190)
    store.setCards([{ id: 'big', number: 9, spec: { kind: 'list', title: 'Big', entity_type: 'action', filters: Array.from({ length: 12 }, () => ({ field: 'title', operator: 'contains' as const, value: huge })).concat(Array.from({ length: 20 }, () => ({ field: 'title', operator: 'contains' as const, value: huge }))) } }])
    const entries = store.contextEntries()
    expect(entries).toEqual([{ n: 9, id: 'big', kind: 'list', title: 'Big', entity: 'action' }])
    expect(JSON.stringify(entries).length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS)
  })

  it('measures the header budget in UTF-8 bytes, not characters', () => {
    const store = new ChatCardStore()
    // 110 Thai characters a title: about 330 bytes, a third of that in characters.
    const thai = 'ก'.repeat(110)
    store.setCards(Array.from({ length: 8 }, (_, i) => ({
      id: `call_${i + 1}`,
      number: i + 1,
      spec: { kind: 'list', title: `${thai}${i}`, entity_type: 'action', filters: Array.from({ length: 6 }, () => ({ field: 'title', operator: 'contains' as const, value: thai })) },
    })))
    const entries = store.contextEntries()
    expect(new TextEncoder().encode(JSON.stringify(entries)).length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS)
    expect(JSON.stringify(entries).length).toBeLessThan(MAX_CONTEXT_CHARS)
  })

  it('stays inside the header budget, dropping untouched old cards first', () => {
    const store = new ChatCardStore()
    const long = 'x'.repeat(110)
    store.setCards(Array.from({ length: 8 }, (_, i) => ({
      id: `call_${i + 1}`,
      spec: { kind: 'list', title: `${long}${i}`, entity_type: 'action', filters: Array.from({ length: 6 }, () => ({ field: 'title', operator: 'contains' as const, value: long })) },
    })))
    store.update('call_1', { touchedAt: 5 })
    const entries = store.contextEntries()
    expect(JSON.stringify(entries).length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS)
    expect(entries.map((e) => e.n)).toContain(1)
    expect(entries.map((e) => e.n)).toContain(8)
  })

  it('numbers a card the person opened from / on from the agent’s, and the agent hears it as theirs', () => {
    const store = new ChatCardStore()
    store.setCards([
      { id: 'call_1', number: 1, spec: list('Due this week') },
      { id: 'call_2', number: 2, spec: list('Blocked') },
    ])
    expect(store.highestNumber()).toBe(2)
    store.setCards([
      { id: 'call_1', number: 1, spec: list('Due this week') },
      { id: 'call_2', number: 2, spec: list('Blocked') },
      { id: 'opened_1', number: 3, spec: list('My actions'), opened: true },
    ])
    expect(store.card('opened_1')).toMatchObject({ n: 3, opened: true })
    expect(store.highestNumber()).toBe(3)

    // What the card body reports once it loads rides with the next send.
    store.update('opened_1', { count: 4, rows: [{ identifier: 'GEN-9', title: 'Ship it' }] })
    const entries = store.contextEntries()
    expect(entries[0]).toMatchObject({ n: 3, u: true, count: 4, rows: [{ i: 'GEN-9', t: 'Ship it' }] })

    const note = renderCardsSection(parseCardContext(entries))!
    expect(note.match(/card 3 /g)).toHaveLength(1)
    expect(note).toContain('you opened it')
    // The agent's own untouched cards stay out: they are in its history.
    expect(note).not.toContain('card 1 ')
    expect(note).not.toContain('card 2 ')
  })
})
