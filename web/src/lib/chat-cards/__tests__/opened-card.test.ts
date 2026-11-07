/**
 * A card the person opened from `/`: the message that carries it, reading it
 * back, its number, and how the agent hears of it in the cards note.
 */
import { describe, expect, it } from 'vitest'
import { firstUserText } from '@/lib/chat/chat-title'
import { renderMessageParts } from '@/lib/chat/conversation-history'
import type { CardSpec } from '../kinds'
import {
  MAX_CARD_NUMBER,
  OPENED_CARD_PART_TYPE,
  isOpenedCardMessage,
  nextCardNumber,
  openedCardFromPart,
  openedCardMessage,
} from '../opened-card'
import { buildCardContextEntry, parseCardContext, renderCardsSection, type CardContextEntry } from '../context'

const MY_ACTIONS: CardSpec = {
  kind: 'list',
  title: 'My actions',
  entity_type: 'action',
  filters: [
    { field: 'assignee_id', operator: 'is', value: '@me' },
    { field: 'status_type', operator: 'is_none_of', value: ['completed', 'canceled'] },
  ],
}

describe('the opened card message', () => {
  it('is a message of the person’s with one card part and no words', () => {
    const msg = openedCardMessage({ id: 'abc', spec: MY_ACTIONS, number: 3, page: 'actions' })
    expect(msg).toMatchObject({ id: 'opened-card-abc', role: 'user' })
    expect(msg.parts).toEqual([{ type: OPENED_CARD_PART_TYPE, id: 'abc', data: { card: MY_ACTIONS, card_number: 3, page: 'actions' } }])
    expect(isOpenedCardMessage(msg)).toBe(true)
  })

  it('reads back after a round trip through JSON (a save and a reload)', () => {
    const msg = JSON.parse(JSON.stringify(openedCardMessage({ id: 'abc', spec: MY_ACTIONS, number: 3, page: 'actions' })))
    expect(openedCardFromPart(msg.parts[0])).toEqual({ id: 'abc', spec: MY_ACTIONS, number: 3 })
  })

  it('reads nothing from another part or a malformed one', () => {
    expect(openedCardFromPart({ type: 'text', text: 'hi' })).toBeNull()
    expect(openedCardFromPart({ type: OPENED_CARD_PART_TYPE, id: 'x', data: { card: { kind: 'list', title: 'x' } } })).toBeNull()
    expect(openedCardFromPart({ type: OPENED_CARD_PART_TYPE, data: { card: MY_ACTIONS, card_number: 1 } })).toBeNull()
    // A forged number is dropped, the card kept.
    expect(openedCardFromPart({ type: OPENED_CARD_PART_TYPE, id: 'x', data: { card: MY_ACTIONS, card_number: MAX_CARD_NUMBER } })?.number).toBeNull()
  })

  it('never reaches the model as words: the chat name and the history primer skip it', () => {
    const msg = openedCardMessage({ id: 'abc', spec: MY_ACTIONS, number: 1, page: 'actions' })
    expect(firstUserText([msg])).toBe('')
    expect(renderMessageParts(msg.parts as Parameters<typeof renderMessageParts>[0])).toBe('')
  })
})

describe('nextCardNumber', () => {
  it('takes the next free number above the chat’s highest', () => {
    expect(nextCardNumber(0)).toBe(1)
    expect(nextCardNumber(4)).toBe(5)
  })

  it('stays under the bound the chat-agent and the note keep', () => {
    expect(nextCardNumber(MAX_CARD_NUMBER - 2)).toBe(MAX_CARD_NUMBER - 1)
    expect(nextCardNumber(MAX_CARD_NUMBER - 1)).toBeNull()
  })
})

describe('the cards note, for a card the person opened', () => {
  const opened = (over: Partial<Parameters<typeof buildCardContextEntry>[0]> = {}): CardContextEntry =>
    buildCardContextEntry({
      n: 3,
      id: 'abc',
      spec: { kind: 'list', title: 'My actions', entity_type: 'action', base: { filters: MY_ACTIONS.kind === 'list' ? MY_ACTIONS.filters : [] } },
      count: 7,
      rows: [
        { identifier: 'GEN-42', title: 'Pricing page copy' },
        { identifier: 'GEN-43', title: 'Send the deck' },
      ],
      opened: true,
      ...over,
    })
  const agentCard = buildCardContextEntry({
    n: 2,
    id: 'call_2',
    spec: { kind: 'list', title: 'Due this week', entity_type: 'action', base: { filters: [] } },
  })

  it('says what it shows, its count and first rows, though nobody changed it', () => {
    const note = renderCardsSection(parseCardContext([opened()]))!
    expect(note).toContain('card 3 · "My actions" (actions) · you opened it')
    expect(note).toContain('showing: assignee_id=me, status_type∉{completed,canceled} · 7 rows')
    expect(note).toContain('GEN-42 "Pricing page copy"')
  })

  it('names it exactly once, and leaves out the agent’s own untouched card', () => {
    const note = renderCardsSection(parseCardContext([opened(), agentCard]))!
    expect(note.match(/card 3 /g)).toHaveLength(1)
    expect(note).not.toContain('card 2 ')
  })

  it('keeps the person-opened mark through the turn header', () => {
    const [entry] = parseCardContext(JSON.parse(JSON.stringify([opened()])))
    expect(entry.u).toBe(true)
    expect(entry.count).toBe(7)
  })

  it('is the same text turn after turn while nothing changes, so the note goes out once', () => {
    const a = renderCardsSection(parseCardContext([opened(), agentCard]))
    const b = renderCardsSection(parseCardContext([opened(), agentCard]))
    expect(a).toBe(b)
  })

  it('shows its search and sort when the person set them', () => {
    const note = renderCardsSection(
      parseCardContext([opened({ cur: { filters: [], search: 'deck', ordering: [{ field: 'due_at', direction: 'asc' }] } })]),
    )!
    expect(note).toContain('showing: no filters, search "deck", sort due_at↑ · 7 rows')
  })

  it('still names a person-opened card of another kind', () => {
    const record = buildCardContextEntry({ n: 5, id: 'r', spec: { kind: 'record', title: 'GEN-42', record: { type: 'action', id: 'a1' } }, opened: true })
    expect(renderCardsSection(parseCardContext([record]))).toContain('card 5 · "GEN-42" (action) · you opened it')
  })

  it('says what an opened calendar, mail or page card shows, with its count and rows', () => {
    const cal = buildCardContextEntry({
      n: 6,
      id: 'c',
      spec: { kind: 'calendar', title: 'This week', base: { from: '2026-10-04', to: '2026-10-10', view: 'week' } },
      count: 3,
      rows: [{ title: 'Standup' }],
      opened: true,
    })
    const mail = buildCardContextEntry({ n: 7, id: 'm', spec: { kind: 'mail', title: 'Inbox', base: { folder: 'inbox' } }, count: 12, opened: true })
    const page = buildCardContextEntry({ n: 8, id: 'p', spec: { kind: 'sequences', title: 'Sequences', entity: 'sequence', base: { filters: [] } }, count: 4, opened: true })
    const parsed = parseCardContext(JSON.parse(JSON.stringify([cal, mail, page])))
    expect(parsed.map((e) => e.u)).toEqual([true, true, true])
    // No before: the person's own card has no agent page to compare with.
    expect(parsed[0].cal?.base).toBeUndefined()
    expect(parsed[1].mail?.base).toBeUndefined()
    expect(parsed[2].base).toBeUndefined()
    const note = renderCardsSection(parsed, 1000)!
    expect(note).toContain('card 6 · "This week" (events) · you opened it')
    expect(note).toMatch(/showing: week [^\n]* · 3 events/)
    expect(note).toContain('Standup')
    expect(note).toContain('card 7 · "Inbox" (mail) · you opened it\n  showing: inbox · 12 threads')
    expect(note).toContain('card 8 · "Sequences" (sequences) · you opened it\n  showing: the top of the page, no filters · 4 rows')
  })
})
