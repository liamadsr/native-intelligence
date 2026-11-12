/**
 * A host's own `@` list (team chat) that also finds records: its options in
 * one section first, then the record sections the search found, the offsets
 * running on through them; never a contacts section (the host's people are
 * its options). Deals and flows are search kinds now. Fixtures are made up.
 */
import { describe, expect, it } from 'vitest'
import { buildMenu, hostRecordOffer, mentionOptionsMenu, offeredKinds, serverSearch } from '../command-menu-model'
import { MENU_SEARCH_KINDS, menuRowMention, type MenuSearchRow } from '@/lib/search/menu-search'

const OPTIONS = [
  { id: '__agent__', label: 'Joseph', agent: true },
  { id: 'm-rosa', label: 'Rosa Lind' },
]
const HOST_KINDS = ['action', 'document', 'deal', 'flow'] as const

const records: Partial<Record<string, MenuSearchRow[]>> = {
  deal: [{ kind: 'deal', id: 'd-1', pipelineId: 'p-1', title: 'Rosewood renewal', status: 'Proposal sent', score: 0.85 }],
  action: [{ kind: 'action', id: 'a-1', title: 'Send Rosewood the quote', identifier: 'GEN-42', status: 'Todo', score: 0.7 }],
}

describe('mentionOptionsMenu with records', () => {
  it('lists the host’s options first, then the records found, offsets running on', () => {
    const offer = hostRecordOffer(HOST_KINDS)
    const recordMenu = buildMenu('@', 'all', 'ros', offer, { pages: [], skills: [], records })
    const menu = mentionOptionsMenu(OPTIONS, 'ros', recordMenu)
    expect(menu.tabs).toEqual(['all'])
    expect(menu.sections.map((s) => [s.key, s.offset, s.items.length])).toEqual([
      ['people', 0, 1],
      ['deals', 1, 1],
      ['actions', 2, 1],
    ])
  })

  it('without records it is the options alone, as before', () => {
    expect(mentionOptionsMenu(OPTIONS, '').sections.map((s) => s.key)).toEqual(['people'])
  })

  it('searches only the host’s kinds, and only once something is typed', () => {
    const offered = offeredKinds('@', hostRecordOffer(HOST_KINDS))
    expect(serverSearch('@', 'all', '', offered)).toBeNull()
    expect(serverSearch('@', 'all', 'ros', offered)!.kinds.sort()).toEqual([...HOST_KINDS].sort())
  })
})

describe('deals and flows', () => {
  it('are search kinds', () => {
    expect(MENU_SEARCH_KINDS).toContain('deal')
    expect(MENU_SEARCH_KINDS).toContain('flow')
  })

  it('a row’s mention: an action by its identifier, the rest by title; none for an agent', () => {
    expect(menuRowMention(records.action![0])).toEqual({ type: 'action', id: 'a-1', label: 'GEN-42' })
    // A deal is its pipeline's row (Tables, phase 7).
    expect(menuRowMention(records.deal![0])).toEqual({ type: 'data_row', id: 'd-1', label: 'Rosewood renewal' })
    expect(menuRowMention({ kind: 'agent', id: 'r-1', title: 'Scout', description: null, icon: null, score: 1 })).toBeNull()
  })
})
