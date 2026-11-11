/**
 * A teammate's memory at the start of its run, and the settle-time request for
 * a summary (plan row 15). Pins: recall reads only this teammate's active
 * entries, most reinforced then newest; an entry learned from a capture the
 * run's user cannot see (private to someone else, an eval capture, or gone)
 * is left out; the recalled text stays under its budget; last_recalled_at is
 * stamped on exactly what was recalled; a failed read recalls nothing. The
 * request is sent only for a run done as a teammate, once per run, and never
 * throws.
 */
import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { makeFakeSupabase } from './fake-supabase'
import {
  AGENT_MEMORY_SUMMARIZE_EVENT,
  MEMORY_ACTIVE_CAP,
  MEMORY_RECALL_MAX_CHARS,
  listTeammateMemory,
  loadTeammateMemory,
  requestMemorySummary,
  settleMemoryEntry,
} from '../agent-memory'

vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))

const WS = 'ws-1'
const MATE = 'mate-1'
const USER = 'user-1'

function memory(over: Record<string, unknown>) {
  return {
    id: `m-${Math.random().toString(36).slice(2)}`,
    workspace_id: WS,
    ai_team_member_id: MATE,
    kind: 'preference',
    text: 'Dana wants briefs as three bullets.',
    source: {},
    salience: 1,
    status: 'active',
    created_at: '2026-09-20T10:00:00Z',
    last_recalled_at: null,
    ...over,
  }
}

const recall = (db: ReturnType<typeof makeFakeSupabase>, userId: string | null = USER) =>
  loadTeammateMemory(db as unknown as SupabaseClient, { workspaceId: WS, teammateId: MATE, userId })

describe('loadTeammateMemory', () => {
  it("reads this teammate's active entries, most reinforced then newest", async () => {
    const db = makeFakeSupabase()
    db.seed('agent_memory', [
      memory({ id: 'old', text: 'old one', created_at: '2026-09-01T00:00:00Z' }),
      memory({ id: 'new', text: 'new one', created_at: '2026-09-25T00:00:00Z' }),
      memory({ id: 'strong', text: 'reinforced', salience: 3, created_at: '2026-08-01T00:00:00Z' }),
      memory({ id: 'gone', text: 'superseded', status: 'superseded' }),
      memory({ id: 'other', text: 'another teammate', ai_team_member_id: 'mate-2' }),
      memory({ id: 'elsewhere', text: 'another workspace', workspace_id: 'ws-2' }),
    ])
    expect((await recall(db))?.map((m) => m.text)).toEqual(['reinforced', 'new one', 'old one'])
  })

  it('leaves out an entry learned from a capture the user cannot see', async () => {
    const db = makeFakeSupabase()
    db.seed('captures', [
      { id: 'cap-ws', workspace_id: WS, visibility: 'workspace', user_id: 'someone', is_eval: false, notes_owner_out: false },
      { id: 'cap-mine', workspace_id: WS, visibility: 'private', user_id: USER, is_eval: false, notes_owner_out: false },
      { id: 'cap-theirs', workspace_id: WS, visibility: 'private', user_id: 'someone', is_eval: false, notes_owner_out: false },
      { id: 'cap-eval', workspace_id: WS, visibility: 'workspace', user_id: USER, is_eval: true, notes_owner_out: false },
    ])
    db.seed('agent_memory', [
      memory({ text: 'from a workspace capture', source: { capture_ids: ['cap-ws'] } }),
      memory({ text: 'from my private capture', source: { capture_ids: ['cap-mine'] } }),
      memory({ text: "from someone else's private capture", source: { capture_ids: ['cap-ws', 'cap-theirs'] } }),
      memory({ text: 'from an eval capture', source: { capture_ids: ['cap-eval'] } }),
      memory({ text: 'from a deleted capture', source: { capture_ids: ['cap-deleted'] } }),
      memory({ text: 'from no capture' }),
    ])
    const texts = (await recall(db))?.map((m) => m.text).sort()
    expect(texts).toEqual(['from a workspace capture', 'from my private capture', 'from no capture'])
    // With no user, only workspace-visible captures count.
    expect((await recall(db, null))?.map((m) => m.text).sort()).toEqual(['from a workspace capture', 'from no capture'])
  })

  it('stays under its character budget and stamps only what it recalled', async () => {
    const db = makeFakeSupabase()
    const long = 'x'.repeat(450)
    db.seed(
      'agent_memory',
      Array.from({ length: 12 }, (_, i) => memory({ id: `m${i}`, text: `${i}${long}`, created_at: `2026-09-${String(10 + i).padStart(2, '0')}T00:00:00Z` })),
    )
    const out = await recall(db)
    expect(out!.reduce((n, m) => n + m.text.length, 0)).toBeLessThanOrEqual(MEMORY_RECALL_MAX_CHARS)
    expect(out!.length).toBe(8)
    const stamped = db.rows('agent_memory').filter((r) => r.last_recalled_at !== null).map((r) => r.id)
    expect(stamped.sort()).toEqual(['m10', 'm11', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9'])
    expect(out![0]).toEqual({ kind: 'preference', text: `11${long}` })
  })

  it('recalls nothing when there is nothing, or a read fails', async () => {
    expect(await recall(makeFakeSupabase())).toBeUndefined()
    const broken = { from: () => { throw new Error('down') } }
    expect(await loadTeammateMemory(broken as never, { workspaceId: WS, teammateId: MATE, userId: USER })).toBeUndefined()
  })
})

describe('requestMemorySummary', () => {
  it('asks once per run, only for a run done as a teammate', async () => {
    const send = vi.fn(async () => ({}))
    await requestMemorySummary({ agentRunId: 'run-1', workspaceId: WS, teammateId: null }, { send })
    expect(send).not.toHaveBeenCalled()
    await requestMemorySummary({ agentRunId: 'run-1', workspaceId: WS, teammateId: MATE }, { send })
    expect(send).toHaveBeenCalledWith({
      id: 'agent-memory:run-1',
      name: AGENT_MEMORY_SUMMARIZE_EVENT,
      data: { agent_run_id: 'run-1', workspace_id: WS, ai_team_member_id: MATE },
    })
  })

  it('never throws', async () => {
    const send = vi.fn(async () => {
      throw new Error('inngest down')
    })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(requestMemorySummary({ agentRunId: 'run-1', workspaceId: WS, teammateId: MATE }, { send })).resolves.toBeUndefined()
    err.mockRestore()
  })
})

describe('teammate memory for owners and admins: always live, remove and undo, and capture visibility', () => {
  const ADMIN = 'user-admin'
  const client = (db: ReturnType<typeof makeFakeSupabase>) => db as unknown as SupabaseClient
  const settle = (db: ReturnType<typeof makeFakeSupabase>, id: string, action: string, viewerUserId = ADMIN) =>
    settleMemoryEntry(client(db), { workspaceId: WS, viewerUserId, id, action: action as 'remove' | 'restore' })
  const statusOf = (db: ReturnType<typeof makeFakeSupabase>, id: string) => db.rows('agent_memory').find((r) => r.id === id)!.status

  it('lists the live entries, newest first, with who taught them, when, and the outside text their run read', async () => {
    const db = makeFakeSupabase()
    db.seed('agent_memory', [
      memory({ id: 'm-old', text: 'Dana likes bullets.', source: { trust: 'person', origin: 'user' } }),
      memory({ id: 'm-web', text: 'Acme moved to annual billing.', source: { trust: 'agent_unattended', origin: 'attempt', outside_reads: ['web_fetch'] }, agent_run_id: 'run-1', created_at: '2026-09-21T10:00:00Z' }),
      memory({ id: 'm-gone', text: 'Retired.', status: 'retired' }),
      memory({ id: 'm-other-ws', workspace_id: 'ws-2', text: 'Not ours.' }),
    ])
    const { entries } = await listTeammateMemory(client(db), { workspaceId: WS, viewerUserId: ADMIN })
    expect(entries.map((e) => e.id)).toEqual(['m-web', 'm-old'])
    expect(entries[0]).toMatchObject({ teammateId: MATE, trust: 'agent_unattended', origin: 'attempt', outsideReads: ['web_fetch'], agentRunId: 'run-1', createdAt: '2026-09-21T10:00:00Z' })
    expect(entries[1]).toMatchObject({ trust: 'person', outsideReads: [] })
  })

  it('an entry learned after reading outside text is recalled like any other, and removable', async () => {
    const db = makeFakeSupabase()
    db.seed('agent_memory', [memory({ id: 'm-web', text: 'Acme moved to annual billing.', source: { outside_reads: ['web_fetch'] } })])
    expect((await loadTeammateMemory(client(db), { workspaceId: WS, teammateId: MATE, userId: USER }))?.map((m) => m.text)).toEqual(['Acme moved to annual billing.'])
    expect(await settle(db, 'm-web', 'remove')).toEqual({ ok: true, status: 'retired', retired: 0 })
    expect(await loadTeammateMemory(client(db), { workspaceId: WS, teammateId: MATE, userId: USER })).toBeUndefined()
  })

  it('S1: an entry learned from a capture the viewer can’t see is never listed or changed for them', async () => {
    const db = makeFakeSupabase()
    db.seed('captures', [
      { id: 'cap-ws', workspace_id: WS, visibility: 'workspace', user_id: 'someone', is_eval: false, notes_owner_out: false },
      { id: 'cap-theirs', workspace_id: WS, visibility: 'private', user_id: 'someone', is_eval: false, notes_owner_out: false },
    ])
    db.seed('agent_memory', [
      memory({ id: 'm-shared', text: 'From a shared call.', source: { capture_ids: ['cap-ws'] } }),
      memory({ id: 'm-private', text: 'From their private call.', source: { capture_ids: ['cap-ws', 'cap-theirs'] } }),
    ])
    const { entries } = await listTeammateMemory(client(db), { workspaceId: WS, viewerUserId: ADMIN })
    expect(entries.map((s) => s.id)).toEqual(['m-shared'])
    expect(await settle(db, 'm-private', 'remove')).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(statusOf(db, 'm-private')).toBe('active')
    // The person whose call it was can.
    expect(await settle(db, 'm-private', 'remove', 'someone')).toMatchObject({ ok: true, status: 'retired' })
  })

  it('there is nothing to accept or dismiss: only remove and restore', async () => {
    const db = makeFakeSupabase()
    db.seed('agent_memory', [memory({ id: 'm-live', text: 'Live.' })])
    expect(await settle(db, 'm-live', 'accept')).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(await settle(db, 'm-live', 'dismiss')).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(statusOf(db, 'm-live')).toBe('active')
  })

  it('N3: restoring past the cap retires the weakest other entry, never the one just restored', async () => {
    const db = makeFakeSupabase()
    db.seed('agent_memory', [
      ...Array.from({ length: MEMORY_ACTIVE_CAP }, (_, i) => memory({ id: `a-${i}`, text: `fact ${i}`, salience: 2, created_at: `2026-09-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00Z` })),
      // The weakest and oldest of all: without the guard it would go first.
      memory({ id: 'm-back', text: 'Back.', status: 'retired', salience: 1, created_at: '2026-08-01T00:00:00Z' }),
    ])
    expect(await settle(db, 'm-back', 'restore')).toMatchObject({ ok: true, status: 'active', retired: 1 })
    expect(statusOf(db, 'm-back')).toBe('active')
    expect(db.rows('agent_memory').filter((r) => r.status === 'active')).toHaveLength(MEMORY_ACTIVE_CAP)
  })

  it('remove retires a live entry and restore brings it back, unless it now repeats one', async () => {
    const db = makeFakeSupabase()
    db.seed('agent_memory', [memory({ id: 'm-live', text: 'Live.' }), memory({ id: 'm-other', workspace_id: 'ws-2' })])
    expect(await settle(db, 'm-live', 'remove')).toEqual({ ok: true, status: 'retired', retired: 0 })
    expect(await loadTeammateMemory(client(db), { workspaceId: WS, teammateId: MATE, userId: USER })).toBeUndefined()
    expect(await settle(db, 'm-live', 'restore')).toMatchObject({ ok: true, status: 'active' })
    expect(statusOf(db, 'm-live')).toBe('active')
    // Wrong moves and another workspace's entry do nothing.
    expect(await settle(db, 'm-live', 'restore')).toMatchObject({ ok: false, code: 'ALREADY_SETTLED' })
    expect(await settle(db, 'm-other', 'remove')).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    // A removed entry another live one now repeats stays removed.
    db.seed('agent_memory', [memory({ id: 'm-again', text: 'Again.', status: 'retired' }), memory({ id: 'm-again-live', text: 'again.' })])
    expect(await settle(db, 'm-again', 'restore')).toMatchObject({ ok: false, code: 'ALREADY_SETTLED' })
  })
})
