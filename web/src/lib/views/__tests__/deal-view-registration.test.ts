import { describe, it, expect } from 'vitest'
import {
  DEFAULT_BOARD_GROUP_BY,
  DEFAULT_DISPLAY_PROPERTIES,
  DISPLAY_PROPERTIES,
  FIELD_CATEGORIES,
  FILTERABLE_FIELDS,
  defaultOrdering,
} from '../types'
import { ENTITY_ENDPOINTS } from '../entity-endpoints'
import { CARD_LIST_ENTITIES, ENTITY_NOUN } from '@/lib/chat-cards/kinds'
import { CARD_PAGES } from '@/lib/chat-cards/page-menu'
import { isCardSpec } from '@/lib/chat-cards/kinds'

describe('deal in the views system (roadmap #8)', () => {
  it('boards by stage, PATCHes the deals route', () => {
    expect(DEFAULT_BOARD_GROUP_BY.deal).toBe('stage_id')
    expect(ENTITY_ENDPOINTS.deal('d1')).toBe('/api/account/deals/d1')
    expect(FILTERABLE_FIELDS.deal.find((f) => f.field === 'stage_id')?.options).toBe('deal_stages')
  })

  it('every default column is a display property, every category field filterable', () => {
    const props = new Set(DISPLAY_PROPERTIES.deal.map((d) => d.field))
    for (const p of DEFAULT_DISPLAY_PROPERTIES.deal) expect(props.has(p), p).toBe(true)
    const fields = new Set(FILTERABLE_FIELDS.deal.map((f) => f.field))
    for (const g of FIELD_CATEGORIES.deal) for (const f of g.fields) expect(fields.has(f), f).toBe(true)
    // The pipeline scope is a real filter, hidden from the picker.
    expect(fields.has('pipeline_id')).toBe(true)
    expect(FIELD_CATEGORIES.deal.flatMap((g) => g.fields)).not.toContain('pipeline_id')
    for (const s of defaultOrdering('deal')) expect(fields.has(s.field), s.field).toBe(true)
  })

  it('stage is display-only; owner, company and close date edit inline', () => {
    const editable = Object.fromEntries(DISPLAY_PROPERTIES.deal.map((d) => [d.field, d.editable?.apiField ?? null]))
    expect(editable).toMatchObject({ stage: null, owner: 'owner_id', company: 'company_id', expected_close_date: 'expected_close_date' })
  })

  it('is a chat card, with a /deals page drawn as a board', () => {
    expect(CARD_LIST_ENTITIES).toContain('deal')
    expect(ENTITY_NOUN.deal).toEqual({ singular: 'deal', plural: 'deals' })
    const page = CARD_PAGES.find((p) => p.slug === 'deals')!
    const spec = page.spec(new Date())
    expect(isCardSpec(spec)).toBe(true)
    expect(spec).toMatchObject({ kind: 'list', entity_type: 'deal', layout: 'board' })
  })
})
