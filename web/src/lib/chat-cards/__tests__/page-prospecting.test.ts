/**
 * Prospecting as a card: the lists (archived ones left out, as on the page),
 * and one list's entries (dismissed ones left out, as on its All tab).
 */
import { describe, expect, it } from 'vitest'
import { normalizePageInput } from '../page-validate'
import { buildCardContextEntry, parseCardContext, renderCardsSection } from '../context'
import { ID, pageTools, seededWorkspace } from './page-fixtures'

describe('prospecting: the spec', () => {
  it('refuses a tab, naming the fix', () => {
    expect(normalizePageInput({ kind: 'prospecting', title: 'P', tab: 'saved' })).toEqual({ ok: false, error: 'tab: prospecting has no tabs. Leave tab out' })
  })
})

describe('prospecting: show', () => {
  it('shows the active lists', async () => {
    const out = await pageTools(seededWorkspace()).show({ kind: 'prospecting', title: 'Lists' })
    expect(out).toMatchObject({ success: true, count: 1, items: [{ id: ID.listFintech, title: 'Fintech CFOs' }] })
  })

  it("opens one list on its entries, by name, the dismissed ones left out", async () => {
    const out = await pageTools(seededWorkspace()).show({ kind: 'prospecting', title: 'Fintech', target: 'fintech' })
    expect(out.card).toEqual({ kind: 'prospecting', title: 'Fintech', target: { type: 'prospect_list', id: ID.listFintech, label: 'Fintech CFOs' } })
    expect(out).toMatchObject({ count: 1, items: [{ title: 'Acme Pay' }] })
  })
})

describe('prospecting: the note and read_card', () => {
  it("reads the list the person opened, with their stage filter", async () => {
    const entry = buildCardContextEntry({
      n: 3,
      id: 'call-3',
      spec: { kind: 'prospecting', title: 'Lists', entity: 'prospect_list_entry', base: { filters: [] } },
      at: { type: 'prospect_list', id: ID.listFintech, label: 'Fintech CFOs' },
      cur: { filters: [{ field: 'stage', operator: 'is', value: 'dismissed' }] },
      count: 1,
      rows: [{ title: 'Gone Inc' }],
    })
    const parsed = parseCardContext([entry])
    const note = renderCardsSection(parsed)!
    expect(note).toContain('you opened: prospect list "Fintech CFOs"')
    expect(note).toContain('you changed: no filters → stage=dismissed · 1 row')
    const read = await pageTools(seededWorkspace(), parsed).readCard({ card: 3 })
    expect(read).toMatchObject({ success: true, at: 'prospect list Fintech CFOs', showing: 'entries', total: 1, rows: [{ title: 'Gone Inc' }] })
  })

  it('leaves off a list entity the page does not show (a forged one), keeping the card', () => {
    expect(parseCardContext([{ n: 1, id: 'c', kind: 'prospecting', title: 'x', entity: 'action', cur: { filters: [] } }])).toEqual([
      { n: 1, id: 'c', kind: 'prospecting', title: 'x' },
    ])
  })
})
