/**
 * The findable registry (../findable-registry.ts): the one list the search,
 * the menu and the `@` pickers read.
 *  - every kind names a real entity kind (or none, on purpose) and a
 *    mentionable kind where it can be mentioned;
 *  - sections are one per kind, and the menu's order is total;
 *  - the lists that used to be written by hand are still what they were, with
 *    the new kinds added.
 */
import { describe, expect, it } from 'vitest'
import { isMentionableType } from '@/lib/entity-links/mentionable'
import { ENTITY_REGISTRY_BY_ID } from '@/lib/knowledge/entity-registry'
import { FINDABLE, FINDABLE_BY_ORDER, FINDABLE_KINDS, MENTION_FINDABLE_KINDS, SECTION_FINDABLE, TURN_FINDABLE_KINDS, type FindableDescriptor } from '../findable-registry'
import { MENTION_PICKER_KINDS, MENTION_RECORD_KEYS, MENTION_RECORD_KINDS, MENU_SEARCH_KINDS, menuRowMention, type MenuSearchRow } from '../menu-search'

const entries = FINDABLE_KINDS.map((k) => [k, FINDABLE[k] as FindableDescriptor] as const)

describe('the findable registry', () => {
  it('names a registered entity kind for every kind that is one', () => {
    for (const [kind, d] of entries) {
      if (d.entity === null) continue
      expect(ENTITY_REGISTRY_BY_ID[d.entity], kind).toBeDefined()
    }
    // The ones that are no entity of their own, on purpose.
    expect(entries.filter(([, d]) => d.entity === null).map(([k]) => k)).toEqual(['package'])
  })

  it('stores a mention only as a mentionable kind', () => {
    for (const [kind, d] of entries) {
      if (d.mention !== null) expect(isMentionableType(d.mention), kind).toBe(true)
    }
  })

  it('gives each kind its own section and place', () => {
    expect(new Set(entries.map(([, d]) => d.section)).size).toBe(entries.length)
    expect(new Set(entries.map(([, d]) => d.order)).size).toBe(entries.length)
    expect(Object.keys(SECTION_FINDABLE)).toHaveLength(entries.length)
  })

  it('lists people first, agents and messages last', () => {
    expect(FINDABLE_BY_ORDER[0]).toBe('contact')
    expect(FINDABLE_BY_ORDER.slice(-2)).toEqual(['agent', 'team_chat_message'])
  })
})

describe('the lists derived from it', () => {
  it('search every kind', () => {
    expect(MENU_SEARCH_KINDS).toEqual(FINDABLE_KINDS)
    for (const kind of ['campaign', 'sequence', 'prospect_list', 'data_table', 'data_row', 'team_chat_channel', 'decision', 'team', 'package'] as const) {
      expect(MENU_SEARCH_KINDS).toContain(kind)
    }
  })

  it('offer every mentionable kind to the pickers, people first', () => {
    expect(MENTION_PICKER_KINDS).toBe(MENTION_FINDABLE_KINDS)
    expect([...MENTION_PICKER_KINDS]).toEqual([
      'contact',
      'action',
      'document',
      'project',
      'initiative',
      'capture',
      'company',
      'deal',
      'flow',
      'attachment',
      'calendar_event',
      'studio_video',
      'studio_project',
      'campaign',
      'data_table',
      'data_row',
      'team_chat_channel',
      'decision',
    ])
  })

  it('keep the main chat’s turn keys as they were', () => {
    expect([...MENTION_RECORD_KINDS]).toEqual(['action', 'document', 'project', 'initiative', 'deal', 'flow', 'attachment', 'calendar_event', 'studio_video'])
    expect(MENTION_RECORD_KINDS).toBe(TURN_FINDABLE_KINDS)
    expect(MENTION_RECORD_KEYS.action).toEqual({ context: 'attachedActionIds', run: 'actionIds' })
    expect(MENTION_RECORD_KEYS.attachment).toEqual({ context: 'attachedFileIds', run: 'fileIds' })
    expect(MENTION_RECORD_KEYS.studio_video).toEqual({ context: 'attachedStudioVideoIds', run: 'studioVideoIds' })
  })
})

describe('a found row as a mention', () => {
  const named = (kind: 'campaign' | 'sequence' | 'data_row' | 'team' | 'decision'): MenuSearchRow => ({ kind, id: 'r1', title: 'Spring push', status: null, parentId: null, score: 1 })

  it('stores the kind the registry names', () => {
    expect(menuRowMention(named('campaign'))).toEqual({ type: 'campaign', id: 'r1', label: 'Spring push' })
    expect(menuRowMention(named('data_row'))).toEqual({ type: 'data_row', id: 'r1', label: 'Spring push' })
    expect(menuRowMention(named('decision'))).toEqual({ type: 'decision', id: 'r1', label: 'Spring push' })
    expect(menuRowMention({ kind: 'deal', id: 'd1', pipelineId: 'p1', title: 'Harbor renewal', status: null, score: 1 })).toEqual({ type: 'data_row', id: 'd1', label: 'Harbor renewal' })
  })

  it('is nothing for a kind no mention can store', () => {
    expect(menuRowMention(named('sequence'))).toBeNull()
    expect(menuRowMention(named('team'))).toBeNull()
    expect(menuRowMention({ kind: 'agent', id: 'a1', title: 'Researcher', description: null, icon: null, score: 1 })).toBeNull()
  })
})
