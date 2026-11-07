import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeDb, has, type FakeQuery } from './fake-db'

/**
 * stageSuggestions: resolve, check, dedup, insert. The fake answers each
 * query by table and filters, so each test states the world it stages into.
 */

vi.mock('@/lib/people/name-match', () => ({
  resolveMemberIdByName: vi.fn(async (_s: unknown, _ws: string, name: string) => (name === 'Kenan' ? 'mem-kenan' : null)),
  resolveContactIdByName: vi.fn(async () => null),
}))
vi.mock('@/lib/proposed-changes/resolve-action-target', () => ({
  resolveActionTarget: vi.fn(async () => null),
}))

const { stageSuggestions, rehomeRunSuggestions } = await import('../stage')

const ACTION = {
  id: 'act-297',
  workspace_id: 'ws-1',
  team_id: 'team-1',
  identifier: 'GEN-297',
  title: 'Follow up with Kenan',
  status_id: 's-backlog',
  assignee_id: null,
  assignee_contact_id: null,
  due_at: '2026-10-05T00:00:00Z',
  priority: 'medium',
  project_id: null,
  workflow_state: { name: 'Backlog', category: 'backlog' },
}

interface World {
  inserted: Array<Record<string, unknown>>
  pendingInHome?: string | null
  dismissedRecently?: boolean
}

function world(w: World) {
  return (q: FakeQuery) => {
    if (q.table === 'member') return { data: [{ id: 'mem-liam', workspace_id: 'ws-1' }] }
    if (q.table === 'actions') return { data: has(q, 'identifier', 'GEN-297') ? [ACTION] : [] }
    if (q.table === 'workflow_state') return { data: [{ name: 'Backlog' }, { name: 'Todo' }, { name: 'Done' }] }
    if (q.table === 'proposed_change') {
      if (q.head) return { count: 2 }
      if (q.op === 'insert') {
        w.inserted.push(q.payload as Record<string, unknown>)
        return { data: { id: `pc-${w.inserted.length}` } }
      }
      if (has(q, 'status', 'pending')) return { data: w.pendingInHome ? [{ id: w.pendingInHome }] : [] }
      if (has(q, 'status', 'dismissed')) return { data: w.dismissedRecently ? [{ id: 'old' }] : [] }
    }
    return { data: null }
  }
}

const ctxFor = (client: never) => ({
  supabase: client,
  userId: 'user-liam',
  workspaceId: 'ws-1',
  origin: 'chat' as const,
  home: { kind: 'conversation' as const, id: 'conv-1' },
  now: new Date('2026-10-08T12:00:00Z'),
})

const moveToTodo = {
  change: 'update' as const,
  entity: 'action' as const,
  target: 'GEN-297',
  summary: 'Move GEN-297 to Todo, due Oct 9',
  set: { status: 'todo', due_date: '2026-10-09' },
  why: 'Kenan pitches Oct 15; nothing is shaped yet.',
}

let w: World
beforeEach(() => {
  w = { inserted: [] }
})

describe('stageSuggestions', () => {
  it('stages an update with its target, team, snapshot, home and lifecycle', async () => {
    const { client } = fakeDb(world(w))
    const [r] = await stageSuggestions(ctxFor(client), [moveToTodo])

    expect(r).toMatchObject({ result: 'staged', id: 'pc-1', marker: '<!-- proposal:pc-1 -->', note: "GEN-297 'Follow up with Kenan'" })
    expect(w.inserted[0]).toMatchObject({
      workspace_id: 'ws-1',
      conversation_id: 'conv-1',
      capture_id: null,
      document_id: null,
      origin: 'chat',
      change_type: 'update',
      entity_type: 'action',
      entity_id: 'act-297',
      team_id: 'team-1',
      status_to: 'Todo', // the team's own casing
      status_from: 'Backlog',
      due_date: '2026-10-09',
      display_text: 'Move GEN-297 to Todo, due Oct 9',
      reasoning: 'Kenan pitches Oct 15; nothing is shaped yet.',
      sort_order: 2,
      status: 'pending',
      expires_at: '2026-11-07T12:00:00.000Z',
    })
    expect((w.inserted[0].base as Record<string, unknown>).status).toBe('Backlog')
    expect(w.inserted[0].fingerprint).toMatch(/^[0-9a-f]{32}$/)
  })

  it('returns the existing card when the same change is pending in the same home', async () => {
    w.pendingInHome = 'pc-existing'
    const { client } = fakeDb(world(w))
    const [r] = await stageSuggestions(ctxFor(client), [moveToTodo])
    expect(r).toMatchObject({ result: 'existing', id: 'pc-existing' })
    expect(w.inserted).toHaveLength(0)
  })

  it('refuses a change the person dismissed recently', async () => {
    w.dismissedRecently = true
    const { client } = fakeDb(world(w))
    const [r] = await stageSuggestions(ctxFor(client), [moveToTodo])
    expect(r).toMatchObject({ result: 'refused', refusal: 'recently_dismissed' })
    expect(w.inserted).toHaveLength(0)
  })

  it('two different title rewrites of one action are two suggestions (distinct fingerprints)', async () => {
    const { client } = fakeDb(world(w))
    const rename = (title: string) => ({ ...moveToTodo, summary: `Rename to ${title}`, set: { title } })
    await stageSuggestions(ctxFor(client), [rename('Draft the pitch'), rename('Book the room')])
    expect(w.inserted).toHaveLength(2)
    expect(w.inserted[0].fingerprint).not.toBe(w.inserted[1].fingerprint)
  })

  it('refuses a change that already holds', async () => {
    const { client } = fakeDb(world(w))
    const [r] = await stageSuggestions(ctxFor(client), [{ ...moveToTodo, set: { status: 'Backlog' } }])
    expect(r).toMatchObject({ result: 'refused', refusal: 'already_true' })
  })

  it('refuses a status the team does not have, naming the ones it does', async () => {
    const { client } = fakeDb(world(w))
    const [r] = await stageSuggestions(ctxFor(client), [{ ...moveToTodo, set: { status: 'Shipped' } }])
    expect(r.result).toBe('refused')
    expect(r.note).toContain('Backlog, Todo, Done')
  })

  it('refuses an unknown target and an unsupported combo, and still stages the rest', async () => {
    const { client } = fakeDb(world(w))
    const out = await stageSuggestions(ctxFor(client), [
      { ...moveToTodo, target: 'GEN-999' },
      { change: 'delete', entity: 'project', target: 'X', summary: 'Delete X', why: 'stale' } as never,
      { change: 'assign', entity: 'action', target: 'GEN-297', summary: 'Give GEN-297 to Kenan', set: { assignee: 'Kenan' }, why: 'his pitch' },
    ])
    expect(out.map((r) => r.result)).toEqual(['refused', 'refused', 'staged'])
    expect(out[0].refusal).toBe('target_not_found')
    expect(out[1].refusal).toBe('unsupported')
    expect(w.inserted[0]).toMatchObject({ change_type: 'assign', assignee_member_id: 'mem-kenan' })
  })

  it('a create needs no target and takes its title from the summary', async () => {
    const { client } = fakeDb(world(w))
    const [r] = await stageSuggestions(ctxFor(client), [
      { change: 'create', entity: 'action', summary: 'Draft the United Front one-pager', set: { assignee: 'me', priority: 'high' }, why: 'Owed before Oct 15' },
    ])
    expect(r.result).toBe('staged')
    expect(w.inserted[0]).toMatchObject({
      change_type: 'create',
      entity_id: null,
      title: 'Draft the United Front one-pager',
      assignee_member_id: 'mem-liam',
      priority: 'high',
    })
  })

  it('validates priority and due date', async () => {
    const { client } = fakeDb(world(w))
    const out = await stageSuggestions(ctxFor(client), [
      { ...moveToTodo, set: { priority: 'critical' } },
      { ...moveToTodo, set: { due_date: 'next friday' } },
    ])
    expect(out.every((r) => r.refusal === 'invalid')).toBe(true)
  })

  it('a run stages with no home and its tracked job, for delivery to re-home', async () => {
    const { client } = fakeDb(world(w))
    await stageSuggestions({ ...ctxFor(client), home: null, origin: 'skill_run', trackedJobId: 'job-1' }, [moveToTodo])
    expect(w.inserted[0]).toMatchObject({ tracked_job_id: 'job-1', document_id: null, conversation_id: null, capture_id: null, origin: 'skill_run' })
  })

  it('refuses everything when the person is not in the workspace', async () => {
    const { client } = fakeDb(world(w))
    const out = await stageSuggestions({ ...ctxFor(client), workspaceId: 'ws-other' }, [moveToTodo])
    expect(out[0]).toMatchObject({ result: 'refused', refusal: 'invalid' })
  })
})

describe('rehomeRunSuggestions', () => {
  it('moves only the run’s homeless suggestions onto the document', async () => {
    const { client, calls } = fakeDb((q) => (q.op === 'update' ? { data: [{ id: 'pc-1' }, { id: 'pc-2' }] } : { data: null }))
    const ids = await rehomeRunSuggestions(client, { trackedJobId: 'job-1', documentId: 'doc-1' })
    expect(ids).toEqual(['pc-1', 'pc-2'])
    const q = calls[0]
    expect(q.payload).toEqual({ document_id: 'doc-1' })
    expect(has(q, 'tracked_job_id', 'job-1')).toBe(true)
    expect(q.filters.filter(([k]) => k === 'is').map(([, c]) => c).sort()).toEqual(['capture_id', 'conversation_id', 'document_id'])
  })
})
