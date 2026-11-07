/**
 * The roster carries each teammate's voice (bots-v4 B2, migration 308), in the
 * always-on light read too: the crew, the bubble, the bot's page and the
 * desktop overlay's relay take a bot's voice from it, with no fetch of their
 * own. A teammate on Automatic, or with a value that isn't a voice id, reads
 * as null.
 */
import { describe, it, expect } from 'vitest'
import { loadAgentRoster } from '../agent-roster'
import { chosenVoicesOf, voicesForCrew } from '@/lib/bots/bot-voice'
import { makeFakeSupabase, type Row } from './fake-supabase'

describe('loadAgentRoster: each bot’s voice', () => {
  it('reads it in the light read, null for Automatic or a value that isn’t a voice id', async () => {
    // Only the columns the select names come back (PostgREST): a read without `voice` would lose it here.
    const db = makeFakeSupabase({ project: true })
    db.seed('ai_team_member', [
      { id: 'ember', workspace_id: 'w1', team_id: 't1', name: 'Ember', role: null, is_system: false, fronts_only: true, bot_character: 'ember', voice: 'lori', created_at: '1' },
      { id: 'writer', workspace_id: 'w1', team_id: 't1', name: 'Writer', role: 'writer', is_system: false, fronts_only: false, bot_character: 'writer', voice: null, created_at: '2' },
      { id: 'odd', workspace_id: 'w1', team_id: 't1', name: 'Odd', role: null, is_system: false, fronts_only: false, bot_character: 'dew', voice: 'Not A Voice', created_at: '3' },
    ])
    const { roster, error } = await loadAgentRoster({ session: db as never, service: null, workspaceIds: ['w1'], now: new Date() })
    expect(error).toBeNull()
    expect(roster.map((m) => [m.id, m.voice])).toEqual([
      ['ember', 'lori'],
      ['writer', null],
      ['odd', null],
    ])
    expect(db.selects.find((s) => s.table === 'ai_team_member')?.columns).toMatch(/\bvoice\b/)
  })

  it('one bot’s read (?teammate=) carries it too', async () => {
    const db = makeFakeSupabase({ project: true })
    db.seed('ai_team_member', [
      { id: 'ember', workspace_id: 'w1', team_id: 't1', name: 'Ember', role: null, is_system: false, fronts_only: true, bot_character: 'ember', voice: 'tana', created_at: '1' },
      { id: 'writer', workspace_id: 'w1', team_id: 't1', name: 'Writer', role: null, is_system: false, fronts_only: false, bot_character: 'writer', voice: 'aba', created_at: '2' },
    ])
    const { roster } = await loadAgentRoster({ session: db as never, service: null, workspaceIds: ['w1'], teammateIds: ['ember'], now: new Date() })
    expect(roster.map((m) => [m.id, m.voice])).toEqual([['ember', 'tana']])
  })
})

describe('loadAgentRoster: the same order every time, ties included', () => {
  // Seeded teammates share a created_at (a batch at a time: 803 of DEV's 904
  // did). Several wear one face, each with its own voice: which voice the face
  // speaks in is the first in the roster's order, so the order mustn't flip.
  const STAMP = '2026-09-30T21:22:17.000Z'
  const MATES: Row[] = [
    { id: 'c-triage', workspace_id: 'w2', team_id: 't2', name: 'Triage', role: null, is_system: true, fronts_only: false, bot_character: 'triage', voice: 'lori', created_at: STAMP },
    { id: 'a-triage', workspace_id: 'w1', team_id: 't1', name: 'Triage', role: null, is_system: true, fronts_only: false, bot_character: 'triage', voice: 'cha', created_at: STAMP },
    { id: 'b-triage', workspace_id: 'w3', team_id: 't3', name: 'Triage', role: null, is_system: true, fronts_only: false, bot_character: 'triage', voice: 'tana', created_at: STAMP },
    { id: 'b-writer', workspace_id: 'w1', team_id: 't1', name: 'Writer', role: 'writer', is_system: false, fronts_only: false, bot_character: 'writer', voice: 'aba', created_at: STAMP },
    { id: 'a-writer', workspace_id: 'w2', team_id: 't2', name: 'Writer', role: 'writer', is_system: false, fronts_only: false, bot_character: 'writer', voice: 'ush', created_at: STAMP },
    // Older: first whatever its id.
    { id: 'z-old', workspace_id: 'w1', team_id: 't1', name: 'Old', role: null, is_system: false, fronts_only: false, bot_character: 'dew', voice: null, created_at: '2026-09-01T00:00:00.000Z' },
  ]
  const VOICES = ['aba', 'cha', 'ush', 'chichi', 'lori', 'lowli', 'tana', 'milton'].map((id) => ({ id, default: id === 'tana' }))

  /** The roster as read when the database hands the tied rows back in `order`. */
  async function readIn(order: readonly Row[]) {
    const db = makeFakeSupabase({ project: true })
    db.seed('ai_team_member', order.map((r) => ({ ...r })))
    const { roster, error } = await loadAgentRoster({ session: db as never, service: null, workspaceIds: ['w1', 'w2', 'w3'], now: new Date() })
    expect(error).toBeNull()
    return roster
  }

  it('orders by created_at, then id, whatever order the rows come back in', async () => {
    const forward = await readIn(MATES)
    const backward = await readIn([...MATES].reverse())
    const shuffled = await readIn([MATES[3], MATES[0], MATES[5], MATES[2], MATES[4], MATES[1]])
    const want = ['z-old', 'a-triage', 'a-writer', 'b-triage', 'b-writer', 'c-triage']
    for (const roster of [forward, backward, shuffled]) expect(roster.map((m) => m.id)).toEqual(want)
  })

  it('so a face worn by several teammates speaks in the same voice on every read', async () => {
    const reads = await Promise.all([readIn(MATES), readIn([...MATES].reverse()), readIn([MATES[2], MATES[4], MATES[0], MATES[3], MATES[1], MATES[5]])])
    const chosen = reads.map((roster) => [...chosenVoicesOf(roster)])
    // Per face, every teammate's choice, the lowest id first among the ties.
    expect(chosen[0]).toEqual([
      ['triage', ['cha', 'tana', 'lori']],
      ['writer', ['ush', 'aba']],
    ])
    expect(chosen[1]).toEqual(chosen[0])
    expect(chosen[2]).toEqual(chosen[0])
    const spoken = reads.map((roster) => Object.fromEntries(voicesForCrew(['triage', 'writer', 'dew'], VOICES, chosenVoicesOf(roster))))
    expect(spoken[0]).toMatchObject({ triage: 'cha', writer: 'ush' })
    expect(spoken[1]).toEqual(spoken[0])
    expect(spoken[2]).toEqual(spoken[0])
  })

  it('asks the database for both orders, so the limit keeps the same teammates too', async () => {
    const db = makeFakeSupabase({ project: true })
    db.seed('ai_team_member', MATES.map((r) => ({ ...r })))
    const calls: Array<[string, unknown]> = []
    // The double's builder hands itself back from every call: one spy on it sees each order.
    const spied = (builder: Record<string, unknown>) => {
      const real = (builder.order as (col: string, opts: unknown) => unknown).bind(builder)
      builder.order = (col: string, opts: unknown) => {
        calls.push([col, opts])
        return real(col, opts)
      }
      return builder
    }
    const session = { from: (table: string) => (table === 'ai_team_member' ? spied(db.from(table)) : db.from(table)) }
    await loadAgentRoster({ session: session as never, service: null, workspaceIds: ['w1'], now: new Date() })
    expect(calls).toEqual([
      ['created_at', { ascending: true }],
      ['id', { ascending: true }],
    ])
  })
})
