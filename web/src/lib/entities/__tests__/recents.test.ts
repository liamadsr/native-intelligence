/**
 * Recent's direct reads (src/lib/entities/recents.ts): each source reads only
 * the viewer's own doing, in their workspace, on the client it is given (the
 * session's: RLS decides the rest), and one failing source leaves the others.
 * Fixtures are made up.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { codeJobs, driveUploads, loadRecentSources, myRecentWork, RECENTS_SOURCE_MAX } from '../recents'

const VIEWER = { workspaceId: 'ws-1', userId: 'user-ana', memberId: 'm-ana' }

/** A client that records each query's filters and answers per table. */
function fakeClient(answers: Record<string, { data: unknown[] | null; error: { message: string } | null }>) {
  const calls: Array<{ table: string; select?: string; eq: Array<[string, unknown]>; order?: string; limit?: number }> = []
  const client = {
    from(table: string) {
      const call: (typeof calls)[number] = { table, eq: [] }
      calls.push(call)
      const chain = {
        select(cols: string) {
          call.select = cols
          return chain
        },
        eq(col: string, v: unknown) {
          call.eq.push([col, v])
          return chain
        },
        order(col: string) {
          call.order = col
          return chain
        },
        limit(n: number) {
          call.limit = n
          return Promise.resolve(answers[table] ?? { data: [], error: null })
        },
        in(col: string, values: unknown[]) {
          call.eq.push([col, values])
          return Promise.resolve(answers[table] ?? { data: [], error: null })
        },
      }
      return chain
    },
  }
  return { client: client as unknown as SupabaseClient, calls }
}

describe('Recent’s direct reads', () => {
  it('Drive uploads: only the viewer’s own, in their workspace, newest first, as files', async () => {
    const { client, calls } = fakeClient({
      attachments: { data: [{ id: 'f1', file_name: '  fernhill\nquote.pdf ', created_at: '2026-11-20T10:00:00Z' }, { id: 'f2', file_name: null, created_at: '2026-11-19T10:00:00Z' }], error: null },
    })
    expect(await driveUploads(client, VIEWER)).toEqual([
      { type: 'attachment', id: 'f1', label: 'fernhill quote.pdf', context: null, at: '2026-11-20T10:00:00Z' },
      { type: 'attachment', id: 'f2', label: 'Untitled file', context: null, at: '2026-11-19T10:00:00Z' },
    ])
    expect(calls[0]).toMatchObject({
      table: 'attachments',
      eq: [
        ['workspace_id', 'ws-1'],
        ['user_id', 'user-ana'],
        ['drive_upload', true],
      ],
      order: 'created_at',
    })
  })

  it('coding chats: the viewer’s own, titled by what they asked, at when they last moved, each with its state', async () => {
    const { client, calls } = fakeClient({
      local_agent_session: {
        data: [
          { id: 'j1', request: '\n Fix the   export\nand more', created_at: '2026-11-20T09:00:00Z', updated_at: '2026-11-20T11:00:00Z', status: 'waiting', last_signal: 'ask', tracked_job_id: 'tj-old', current_tracked_job_id: 'tj-1', mac_queued_at: null, action_id: null },
          { id: 'j2', request: '', created_at: '2026-11-19T09:00:00Z', updated_at: null, status: 'starting', last_signal: null, tracked_job_id: null, current_tracked_job_id: null, mac_queued_at: '2026-11-19T09:00:05Z', action_id: null },
        ],
        error: null,
      },
    })
    expect(await codeJobs(client, VIEWER)).toEqual([
      { type: 'code_job', id: 'j1', label: 'Fix the export', context: 'Code', at: '2026-11-20T11:00:00Z', code: { status: 'waiting', lastSignal: 'ask', workItemId: 'tj-1', actionIdentifier: null, queuedOnMac: false } },
      { type: 'code_job', id: 'j2', label: 'Untitled', context: 'Code', at: '2026-11-19T09:00:00Z', code: { status: 'starting', lastSignal: null, workItemId: null, actionIdentifier: null, queuedOnMac: true } },
    ])
    expect(calls[0].eq).toEqual([
      ['workspace_id', 'ws-1'],
      ['user_id', 'user-ana'],
    ])
    // By when they last moved: an old chat that just asked something is among the ones read.
    expect(calls[0].order).toBe('updated_at')
    expect(calls[0].limit).toBe(RECENTS_SOURCE_MAX)
    // No action among them: no second read.
    expect(calls).toHaveLength(1)
  })

  it('a coding chat working an action goes by the action: its title, and its identifier for the row', async () => {
    const { client, calls } = fakeClient({
      local_agent_session: {
        data: [{ id: 'j1', request: 'A long brief the agent wrote for itself', created_at: '2026-11-20T09:00:00Z', updated_at: '2026-11-20T09:30:00Z', status: 'running', last_signal: null, tracked_job_id: 'tj-1', current_tracked_job_id: null, action_id: 'act-1' }],
        error: null,
      },
      actions: { data: [{ id: 'act-1', identifier: 'ENG-42', title: 'Fix the date picker' }], error: null },
    })
    expect(await codeJobs(client, VIEWER)).toEqual([
      { type: 'code_job', id: 'j1', label: 'Fix the date picker', context: 'Code', at: '2026-11-20T09:30:00Z', code: { status: 'running', lastSignal: null, workItemId: 'tj-1', actionIdentifier: 'ENG-42', queuedOnMac: false } },
    ])
    // The actions are read in the viewer's own workspace, on the client given (their RLS).
    expect(calls[1]).toMatchObject({ table: 'actions', eq: [['workspace_id', 'ws-1'], ['id', ['act-1']]] })
  })

  it('an action that can’t be read leaves the chat named by its request', async () => {
    const { client } = fakeClient({
      local_agent_session: { data: [{ id: 'j1', request: 'Ship it', created_at: '2026-11-20T09:00:00Z', updated_at: null, status: 'failed', last_signal: null, action_id: 'act-1' }], error: null },
      actions: { data: null, error: { message: 'no' } },
    })
    expect((await codeJobs(client, VIEWER))[0]).toMatchObject({ label: 'Ship it', code: { status: 'failed', actionIdentifier: null } })
  })

  it('a source that fails is left out; the others still answer', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { client } = fakeClient({
      attachments: { data: null, error: { message: 'boom' } },
      local_agent_session: { data: [{ id: 'j1', request: 'Ship it', created_at: '2026-11-20T09:00:00Z', updated_at: null }], error: null },
    })
    expect((await loadRecentSources(client, VIEWER)).map((e) => e.id)).toEqual(['j1'])
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
})

// ── 713's my_recent_work, fenced and labelled again ────────

const fence = vi.hoisted(() => ({ hidden: new Set<string>(), labels: new Map<string, string>() }))
vi.mock('@/lib/knowledge/entity-fences', () => ({ hiddenPrivateRefs: async () => fence.hidden }))
vi.mock('@/lib/knowledge/graph-map/source', () => ({ resolveEntityLabels: async () => fence.labels }))


/** A client whose rpc answers my_recent_work, and whose reads answer per table. */
function workClient(rows: unknown[], tables: Record<string, unknown[]>, rpcError: { message: string } | null = null) {
  const rpc = vi.fn(async () => ({ data: rpcError ? null : rows, error: rpcError }))
  const client = {
    rpc,
    from(table: string) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        in: () => Promise.resolve({ data: tables[table] ?? [], error: null }),
      }
      return chain
    },
  }
  return { client: client as unknown as SupabaseClient, rpc }
}

describe('what they did, through my_recent_work', () => {
  const ME = 'm-ana'
  it('asks for the caller’s own work only (no member argument), names channels as team chat does, and drops what the fences hide or can’t label', async () => {
    fence.hidden = new Set(['canvas:cv-hidden'])
    fence.labels = new Map([['document:doc-1', 'Q4 renewals plan']])
    const { client, rpc } = workClient(
      [
        { kind: 'team_chat_channel', id: 'ch-general', at: '2026-11-20T12:00:00Z' },
        { kind: 'team_chat_channel', id: 'ch-dm', at: '2026-11-20T11:00:00Z' },
        { kind: 'team_chat_channel', id: 'ch-self', at: '2026-11-20T10:30:00Z' },
        { kind: 'team_chat_channel', id: 'ch-gone', at: '2026-11-20T10:00:00Z' },
        { kind: 'document', id: 'doc-1', at: '2026-11-20T09:00:00Z' },
        { kind: 'document', id: 'doc-private', at: '2026-11-20T08:00:00Z' },
        { kind: 'canvas', id: 'cv-hidden', at: '2026-11-20T07:00:00Z' },
        { kind: 'conversation', id: 'conv-1', at: '2026-11-20T06:00:00Z' },
        { kind: 'nothing_like_it', id: 'x', at: '2026-11-20T05:00:00Z' },
      ],
      {
        team_chat_channel: [
          { id: 'ch-general', kind: 'channel', name: 'general', dm_key: null },
          { id: 'ch-dm', kind: 'dm', name: null, dm_key: `m-ben:${ME}` },
          { id: 'ch-self', kind: 'dm', name: null, dm_key: ME },
        ],
        member: [
          { id: 'm-ben', display_name: 'Ben Okafor' },
          { id: ME, display_name: 'Ana Reyes' },
        ],
      },
    )
    const out = await myRecentWork(client, { ...VIEWER, memberId: ME })
    expect(rpc).toHaveBeenCalledTimes(1)
    const [name, args] = rpc.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(name).toBe('my_recent_work')
    expect(Object.keys(args).sort()).toEqual(['p_limit', 'p_since', 'p_workspace'])
    expect(args).toMatchObject({ p_workspace: 'ws-1', p_limit: RECENTS_SOURCE_MAX })
    expect(out.map((e) => [e.type, e.id, e.label])).toEqual([
      ['team_chat_channel', 'ch-general', '#general'],
      ['team_chat_channel', 'ch-dm', 'Ben Okafor'],
      ['team_chat_channel', 'ch-self', 'Ana Reyes (you)'],
      ['document', 'doc-1', 'Q4 renewals plan'],
      ['conversation', 'conv-1', 'Untitled chat'],
    ])
  })

  it('before 713 is applied the call fails: the source is left out, the others answer', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { client } = workClient([], {}, { message: 'function my_recent_work does not exist' })
    await expect(myRecentWork(client, VIEWER)).rejects.toThrow('my_recent_work')
    err.mockRestore()
  })
})
