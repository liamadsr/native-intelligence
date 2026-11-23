/**
 * Recent's direct reads (src/lib/entities/recents.ts): each source reads only
 * the viewer's own doing, in their workspace, on the client it is given (the
 * session's: RLS decides the rest), and one failing source leaves the others.
 * Fixtures are made up.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { codeJobs, driveUploads, loadRecentSources } from '../recents'

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

  it('coding jobs: the viewer’s own, titled by what they asked, at when they last moved', async () => {
    const { client, calls } = fakeClient({
      local_agent_session: {
        data: [
          { id: 'j1', request: '\n Fix the   export\nand more', created_at: '2026-11-20T09:00:00Z', updated_at: '2026-11-20T11:00:00Z' },
          { id: 'j2', request: '', created_at: '2026-11-19T09:00:00Z', updated_at: null },
        ],
        error: null,
      },
    })
    expect(await codeJobs(client, VIEWER)).toEqual([
      { type: 'code_job', id: 'j1', label: 'Fix the export', context: 'Code', at: '2026-11-20T11:00:00Z' },
      { type: 'code_job', id: 'j2', label: 'Untitled', context: 'Code', at: '2026-11-19T09:00:00Z' },
    ])
    expect(calls[0].eq).toEqual([
      ['workspace_id', 'ws-1'],
      ['user_id', 'user-ana'],
    ])
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
