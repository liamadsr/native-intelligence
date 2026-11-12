/**
 * A host's own `@` list (team chat) that also finds records: its options in
 * one section first, then the record sections the search found, the offsets
 * running on through them; the contacts found join the host's people, a
 * teammate's own contact left out. Deals, flows, files and events are search
 * kinds. Fixtures are made up.
 */
import { describe, expect, it } from 'vitest'
import { buildMenu, hostRecordOffer, mentionOptionsMenu, offeredKinds, serverSearch } from '../command-menu-model'
import {
  MENTION_PICKER_KINDS,
  MENTION_RECORD_KEYS,
  MENTION_RECORD_KINDS,
  MENU_SEARCH_KINDS,
  menuRowMention,
  menuRowTarget,
  toMentionRecord,
  type MenuSearchRow,
} from '@/lib/search/menu-search'
import { isMentionableType } from '@/lib/entity-links/mentionable'

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

describe('the one @ picker (MENTION_PICKER_KINDS)', () => {
  const contact = (id: string, name: string, isMember: boolean, score: number): MenuSearchRow => ({
    kind: 'contact',
    contact: { id, full_name: name, email: null, job_title: null, company_name: null, is_member: isMember },
    score,
  })

  it('is one list of search kinds, each a kind a mention edge may point at', () => {
    for (const kind of MENTION_PICKER_KINDS) {
      expect(MENU_SEARCH_KINDS).toContain(kind)
      // A deal is found as a deal and mentioned as its pipeline's row (Tables, phase 7).
      expect(isMentionableType(kind === 'deal' ? 'data_row' : kind)).toBe(true)
    }
    expect(MENTION_PICKER_KINDS).toEqual(expect.arrayContaining(['contact', 'deal', 'flow', 'attachment', 'calendar_event']))
    expect(MENTION_PICKER_KINDS).not.toContain('agent')
    expect(MENTION_PICKER_KINDS).not.toContain('team_chat_message')
  })

  it('every record kind a turn mentions has its system-context and run-chat key', () => {
    for (const kind of MENTION_RECORD_KINDS) {
      expect(MENTION_RECORD_KEYS[kind].context).toMatch(/^attached[A-Z]\w+Ids$/)
      expect(MENTION_RECORD_KEYS[kind].run).toMatch(/^[a-z]\w+Ids$/)
    }
  })

  it('a host’s people are its teammates, then the contacts found, never a teammate’s own contact twice', () => {
    const offer = hostRecordOffer(MENTION_PICKER_KINDS)
    const found = {
      contact: [contact('c-rosa', 'Rosa Lind', true, 0.85), contact('c-roz', 'Roz Avery', false, 0.85)],
      deal: records.deal!,
    }
    const menu = mentionOptionsMenu(OPTIONS, 'ro', buildMenu('@', 'all', 'ro', offer, { pages: [], skills: [], records: found }))
    const people = menu.sections[0]
    expect(people.key).toBe('people')
    expect(people.items.map((i) => (i.kind === 'option' ? i.option.id : i.kind === 'record' ? menuRowMention(i.row)!.id : ''))).toEqual(['m-rosa', 'c-roz'])
    expect(people.items[1]).toMatchObject({ kind: 'record', host: true })
    expect(menu.sections.map((s) => s.key)).toEqual(['people', 'deals'])
    expect(menu.sections[1].offset).toBe(2)
  })

  it('a file opens the record it hangs off; an event opens on its day; both are mentioned by name', () => {
    const file: MenuSearchRow = { kind: 'attachment', id: 'f-1', title: 'menu.pdf', category: 'document', parent: { type: 'action', id: 'a-1' }, createdAt: null, score: 1 }
    const event: MenuSearchRow = { kind: 'calendar_event', id: 'e-1', title: 'Harbor call', start: '2026-11-12T10:00:00Z', end: null, allDay: false, score: 1 }
    expect(menuRowTarget(file)).toEqual({ type: 'action', id: 'a-1', title: null })
    expect(menuRowTarget(event)).toEqual({ type: 'calendar-event', id: 'e-1', title: 'Harbor call', start: '2026-11-12T10:00:00Z' })
    expect(menuRowMention(file)).toEqual({ type: 'attachment', id: 'f-1', label: 'menu.pdf' })
    expect(toMentionRecord(event)).toEqual({ kind: 'calendar_event', id: 'e-1', title: 'Harbor call' })
  })
})
