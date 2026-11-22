/**
 * Every mentionable record kind attaches in the composer ("mentions
 * everywhere", phase 2): a found row becomes a chip's record whatever its
 * kind, and a turn carries it: by its id key where its kind has one, else as
 * the one mention format under `mentionedRecords` (the system context only).
 */
import { describe, expect, it } from 'vitest'
import { COMPOSER_RECORD_KINDS, UNKEYED_MENTION_TYPES, toMentionRecord, type MenuSearchRow, type MentionRecord } from '@/lib/search/menu-search'
import { recordIdsBody } from '../composer-state'

const named = (kind: 'campaign' | 'data_table' | 'data_row' | 'team_chat_channel' | 'decision' | 'sequence' | 'team', id: string, title: string): MenuSearchRow => ({
  kind,
  id,
  title,
  status: null,
  parentId: null,
  score: 1,
})

describe('toMentionRecord', () => {
  it('makes a record of every kind a mention can store', () => {
    expect(toMentionRecord(named('campaign', 'c1', 'Harbor spring push'))).toEqual({ kind: 'campaign', id: 'c1', title: 'Harbor spring push' })
    expect(toMentionRecord(named('decision', 'd1', 'Hold the price'))).toEqual({ kind: 'decision', id: 'd1', title: 'Hold the price' })
    expect(toMentionRecord({ kind: 'action', id: 'a1', title: 'Pricing page', identifier: 'GEN-1', status: null, score: 1 })).toEqual({ kind: 'action', id: 'a1', title: 'Pricing page', identifier: 'GEN-1' })
  })

  it('makes a record of a sequence and a team too (mentions everywhere)', () => {
    expect(toMentionRecord(named('sequence', 's1', 'Welcome'))).toEqual({ kind: 'sequence', id: 's1', title: 'Welcome' })
    expect(toMentionRecord(named('team', 't1', 'General'))).toEqual({ kind: 'team', id: 't1', title: 'General' })
  })

  it('is nothing for what no mention can store, or what has a chip of its own', () => {
    expect(toMentionRecord({ kind: 'agent', id: 'g1', title: 'Researcher', description: null, icon: null, score: 1 })).toBeNull()
    expect(toMentionRecord({ kind: 'contact', contact: { id: 'c1', full_name: 'Ana', email: null, job_title: null, company_name: null, is_member: true }, score: 1 })).toBeNull()
  })

  it('covers the kinds the composer lists', () => {
    expect(COMPOSER_RECORD_KINDS).toEqual(['action', 'document', 'canvas', 'project', 'initiative', 'deal', 'flow', 'attachment', 'calendar_event', 'studio_video', 'studio_project', 'campaign', 'sequence', 'prospect_list', 'data_table', 'data_row', 'team_chat_channel', 'decision', 'team', 'package', 'email_thread', 'conversation'])
    expect([...UNKEYED_MENTION_TYPES].sort()).toEqual(['campaign', 'canvas', 'conversation', 'data_row', 'data_table', 'decision', 'email_thread', 'knowledge_package', 'prospect_list', 'sequence', 'studio_project', 'team', 'team_chat_channel'])
  })
})

describe('recordIdsBody', () => {
  const records: MentionRecord[] = [
    { kind: 'action', id: 'a1', title: 'Pricing page', identifier: 'GEN-1' },
    { kind: 'deal', id: 'd1', title: 'Harbor renewal' },
    { kind: 'campaign', id: 'c1', title: 'Harbor spring push' },
    { kind: 'data_row', id: 'r1', title: 'Harbor bakery' },
  ]

  it('sends keyed kinds by id and the rest as mentions, in the system context', () => {
    expect(recordIdsBody(records, 'context')).toEqual({
      attachedActionIds: ['a1'],
      attachedDealIds: ['d1'],
      mentionedRecords: [
        { type: 'campaign', id: 'c1', label: 'Harbor spring push' },
        { type: 'data_row', id: 'r1', label: 'Harbor bakery' },
      ],
    })
  })

  it('sends a run chat ids only', () => {
    expect(recordIdsBody(records, 'run')).toEqual({ actionIds: ['a1'], dealIds: ['d1'] })
  })

  it('sends nothing for nothing', () => {
    expect(recordIdsBody([], 'context')).toEqual({})
    expect(recordIdsBody(undefined, 'run')).toEqual({})
  })
})
