/**
 * The entity tab's read (row 10): one row per work item that touched the
 * entity, newest first, from the caller's own ledger rows; another member's
 * runs are counted, not shown (tracked_job SELECT is owner-only; the fake
 * models RLS by not seeding a row the caller could not read). An action's own
 * runs count too, touch or not.
 */
import { describe, it, expect } from 'vitest'
import { makeFakeSupabase } from './fake-supabase'
import { groupEntityActivity, loadEntityActivity, type EntityActivityRow } from '../entity-activity'

const job = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  workspace_id: 'w1',
  member_id: 'm1',
  kind: 'work_run',
  title: `Job ${id}`,
  status: 'done',
  origin: 'user',
  created_at: '2026-09-27T08:00:00Z',
  started_at: '2026-09-27T08:00:00Z',
  last_beat_at: '2026-09-27T08:30:00Z',
  ...over,
})
const touch = (work_item_id: string, verb: string, at: string, over: Record<string, unknown> = {}) => ({
  workspace_id: 'w1',
  work_item_id,
  agent_run_id: null,
  entity_type: 'contact',
  entity_id: 'c1',
  verb,
  tool_name: null,
  at,
  ...over,
})

describe('loadEntityActivity', () => {
  it('groups the entity’s touches by work item, newest first, and counts the ones the caller cannot read', async () => {
    const fake = makeFakeSupabase()
    fake.seed('work_touch', [
      touch('mine-1', 'read', '2026-09-27T09:00:00Z', { tool_name: 'get_contact_details' }),
      touch('mine-1', 'wrote', '2026-09-27T09:05:00Z', { tool_name: 'update_contact' }),
      touch('mine-2', 'created', '2026-09-27T10:00:00Z'),
      touch('theirs', 'wrote', '2026-09-27T11:00:00Z', { agent_run_id: 'run-theirs' }),
      touch('mine-1', 'read', '2026-09-27T12:00:00Z', { entity_id: 'c2' }), // another contact
      touch('mine-2', 'read', '2026-09-27T12:00:00Z', { entity_type: 'action' }), // another kind, same id
      touch('elsewhere', 'read', '2026-09-27T12:00:00Z', { workspace_id: 'w2' }),
    ])
    fake.seed('tracked_job', [job('mine-1'), job('mine-2')])
    const res = await loadEntityActivity(fake as never, { workspaceId: 'w1', entityType: 'contact', entityId: 'c1' })
    if ('error' in res) throw new Error(res.error)
    expect(res.hidden).toBe(1)
    expect(res.rows.map((r) => [r.work_item_id, r.verbs, r.tools])).toEqual([
      ['mine-2', { created: 1 }, []],
      ['mine-1', { wrote: 1, read: 1 }, ['update_contact', 'get_contact_details']],
    ])
    expect(res.rows[0].work_item.title).toBe('Job mine-2')
  })

  it('nothing touched it: no rows, no reads of the ledger', async () => {
    const fake = makeFakeSupabase()
    expect(await loadEntityActivity(fake as never, { workspaceId: 'w1', entityType: 'capture', entityId: 'k1' })).toEqual({ rows: [], hidden: 0 })
    expect(fake.calls.filter((c) => c.table === 'tracked_job')).toEqual([])
  })

  it('an action: its own runs are rows even with no touch ("wrote"), and an unreadable one is counted once', async () => {
    const fake = makeFakeSupabase()
    fake.seed('agent_run', [
      { id: 'run-coding', workspace_id: 'w1', action_id: 'a1', created_at: '2026-09-27T07:00:00Z' },
      { id: 'run-touched', workspace_id: 'w1', action_id: 'a1', created_at: '2026-09-27T06:00:00Z' },
      { id: 'run-theirs', workspace_id: 'w1', action_id: 'a1', created_at: '2026-09-27T05:00:00Z' },
      { id: 'run-other-action', workspace_id: 'w1', action_id: 'a2', created_at: '2026-09-27T05:00:00Z' },
    ])
    fake.seed('work_touch', [
      touch('job-touched', 'wrote', '2026-09-27T06:10:00Z', { entity_type: 'action', entity_id: 'a1', agent_run_id: 'run-touched' }),
      touch('job-theirs', 'read', '2026-09-27T05:10:00Z', { entity_type: 'action', entity_id: 'a1', agent_run_id: 'run-theirs' }),
    ])
    fake.seed('tracked_job', [
      job('job-coding', { kind: 'coding_run', agent_run_id: 'run-coding', last_beat_at: '2026-09-27T07:30:00Z' }),
      job('job-touched', { agent_run_id: 'run-touched' }),
      job('job-other', { agent_run_id: 'run-other-action' }),
    ])
    const res = await loadEntityActivity(fake as never, { workspaceId: 'w1', entityType: 'action', entityId: 'a1' })
    if ('error' in res) throw new Error(res.error)
    expect(res.rows.map((r) => [r.work_item_id, r.verbs, r.last_at])).toEqual([
      ['job-coding', { wrote: 1 }, '2026-09-27T07:30:00Z'],
      ['job-touched', { wrote: 1 }, '2026-09-27T06:10:00Z'],
    ])
    expect(res.hidden).toBe(1)
  })

  it('an email thread: its own touches, plus its drafts’ touches for runs that never touched the thread itself', async () => {
    const fake = makeFakeSupabase()
    fake.seed('email_draft', [
      { id: 'd1', workspace_id: 'w1', email_thread_id: 't1', created_at: '2026-09-27T08:00:00Z' },
      { id: 'd2', workspace_id: 'w1', email_thread_id: 't1', created_at: '2026-09-27T09:00:00Z' },
      { id: 'd-other', workspace_id: 'w1', email_thread_id: 't2', created_at: '2026-09-27T09:00:00Z' },
    ])
    const thread = { entity_type: 'email_thread', entity_id: 't1' }
    fake.seed('work_touch', [
      // Before row 12: the drafting pass touched only its draft.
      touch('old-pass', 'delivered', '2026-09-26T09:00:00Z', { entity_type: 'email_draft', entity_id: 'd1' }),
      // After: a pass that delivered d2 touched both; the thread's tab counts it once.
      touch('new-pass', 'delivered', '2026-09-27T09:00:00Z', { entity_type: 'email_draft', entity_id: 'd2' }),
      touch('new-pass', 'delivered', '2026-09-27T09:00:00Z', thread),
      // A chat run read the thread.
      touch('reader', 'read', '2026-09-27T10:00:00Z', { ...thread, tool_name: 'read_email' }),
      // Another thread's draft.
      touch('elsewhere', 'delivered', '2026-09-27T11:00:00Z', { entity_type: 'email_draft', entity_id: 'd-other' }),
    ])
    fake.seed('tracked_job', [job('old-pass', { kind: 'email_drafts' }), job('new-pass', { kind: 'email_drafts' }), job('reader'), job('elsewhere')])
    const res = await loadEntityActivity(fake as never, { workspaceId: 'w1', entityType: 'email_thread', entityId: 't1' })
    if ('error' in res) throw new Error(res.error)
    expect(res.rows.map((r) => [r.work_item_id, r.verbs])).toEqual([
      ['reader', { read: 1 }],
      ['new-pass', { delivered: 1 }],
      ['old-pass', { delivered: 1 }],
    ])
    expect(res.hidden).toBe(0)
  })

  it('a thread with no drafts reads only its own touches', async () => {
    const fake = makeFakeSupabase()
    fake.seed('work_touch', [touch('reader', 'read', '2026-09-27T10:00:00Z', { entity_type: 'email_thread', entity_id: 't1' })])
    fake.seed('tracked_job', [job('reader')])
    const res = await loadEntityActivity(fake as never, { workspaceId: 'w1', entityType: 'email_thread', entityId: 't1' })
    if ('error' in res) throw new Error(res.error)
    expect(res.rows.map((r) => r.work_item_id)).toEqual(['reader'])
    expect(fake.calls.filter((c) => c.table === 'work_touch')).toHaveLength(1)
  })
})

describe('handoffs on the entity tab (row 14)', () => {
  it('a handoff’s row carries its root’s title, read even when the root never touched the entity', async () => {
    const fake = makeFakeSupabase()
    fake.seed('work_touch', [
      touch('child', 'created', '2026-09-29T10:00:00Z'),
      touch('solo', 'read', '2026-09-29T09:00:00Z'),
    ])
    fake.seed('tracked_job', [
      job('root', { title: 'Reply to Acme about the renewal' }),
      job('child', { title: 'Find the Acme price', parent_id: 'root', root_id: 'root', origin: 'delegation' }),
      job('solo'),
    ])
    const res = await loadEntityActivity(fake as never, { workspaceId: 'w1', entityType: 'contact', entityId: 'c1' })
    if ('error' in res) throw new Error(res.error)
    const child = res.rows.find((r) => r.work_item_id === 'child')!
    expect(child.root).toEqual({ id: 'root', title: 'Reply to Acme about the renewal' })
    expect(res.rows.find((r) => r.work_item_id === 'solo')!.root).toBeNull()
  })

  it('a root the caller cannot read leaves the handoff ungrouped', async () => {
    const fake = makeFakeSupabase()
    fake.seed('work_touch', [touch('child', 'created', '2026-09-29T10:00:00Z')])
    fake.seed('tracked_job', [job('child', { parent_id: 'theirs', root_id: 'theirs' })])
    const res = await loadEntityActivity(fake as never, { workspaceId: 'w1', entityType: 'contact', entityId: 'c1' })
    if ('error' in res) throw new Error(res.error)
    expect(res.rows[0].root).toBeNull()
  })

  const row = (id: string, at: string, over: Partial<EntityActivityRow> & { rootId?: string | null } = {}): EntityActivityRow => ({
    work_item_id: id,
    verbs: { read: 1 },
    tools: [],
    last_at: at,
    work_item: { ...job(id), root_id: over.rootId ?? null } as never,
    root: over.root ?? null,
  })

  it('groups a tree’s rows under its root’s title, newest group first; a lone row has no header', () => {
    const groups = groupEntityActivity([
      row('solo', '2026-09-29T12:00:00Z'),
      row('child', '2026-09-29T11:00:00Z', { rootId: 'root', root: { id: 'root', title: 'Reply to Acme' } }),
      row('root', '2026-09-29T10:00:00Z'),
      row('other-child', '2026-09-29T09:00:00Z', { rootId: 'r2', root: { id: 'r2', title: 'Research Okta' } }),
    ])
    expect(groups.map((g) => [g.root?.title ?? null, g.rows.map((r) => r.work_item_id)])).toEqual([
      [null, ['solo']],
      ['Reply to Acme', ['child', 'root']],
      ['Research Okta', ['other-child']],
    ])
  })
})

