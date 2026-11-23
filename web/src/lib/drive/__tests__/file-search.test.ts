import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const fence = vi.hoisted(() => ({ visible: (rows: Array<{ id: string }>) => rows }))
vi.mock('@/lib/attachments/visibility', () => ({
  filterVisibleAttachments: async (_s: unknown, _scope: unknown, rows: Array<{ id: string }>) => fence.visible(rows),
}))

import { searchChatFileText, searchUploadText, searchWords, snippetAround } from '../file-search'

function service(chunks: unknown[], files: unknown[], log: Array<[string, ...unknown[]]> = []) {
  return {
    from: (table: string) => {
      const q: Record<string, (...a: unknown[]) => unknown> = {}
      for (const m of ['select', 'eq', 'ilike', 'in']) q[m] = (...a: unknown[]) => (log.push([m, table, ...a]), q)
      q.limit = async () => ({ data: chunks, error: null })
      ;(q as { then?: unknown }).then = (resolve: (v: unknown) => void) => resolve({ data: files, error: null })
      return q
    },
    rpc: async (name: string, args: unknown) => (log.push(['rpc', name, args]), { data: [{ message_id: 'm1', channel_id: 'c1', channel_kind: 'channel', channel_name: 'design', file_path: 'c1/u/a.pdf', file_name: 'brief.pdf', snippet: ' launch  in spring ', created_at: '2026-11-20T00:00:00Z' }], error: null }),
  } as unknown as SupabaseClient
}

describe('the words and the passage', () => {
  it('keeps words of two letters or more, at most five, once each', () => {
    expect(searchWords('The Q3 budget, the BUDGET; a')).toEqual(['the', 'q3', 'budget'])
    expect(searchWords('a b c d e f g h i j k l')).toEqual([])
  })

  it('cuts a passage around the first word found', () => {
    const text = `${'x '.repeat(100)}the Fernhill budget grows ${'y '.repeat(100)}`
    const s = snippetAround(text, ['fernhill'], 20)
    expect(s).toContain('Fernhill')
    expect(s.startsWith('…')).toBe(true)
    expect(s.endsWith('…')).toBe(true)
  })
})

describe('searchUploadText', () => {
  it('matches every word in the extracted text, then keeps only what the person may read', async () => {
    const log: Array<[string, ...unknown[]]> = []
    fence.visible = (rows) => rows.filter((r) => r.id !== 'private')
    const { hits } = await searchUploadText(
      service(
        [
          { attachment_id: 'a1', chunk_text: 'The Fernhill budget for spring' },
          { attachment_id: 'private', chunk_text: 'Fernhill budget, private capture' },
        ],
        [
          { id: 'a1', user_id: 'u1', note_id: null, action_id: null, project_id: 'p1', data_row_id: null, file_name: 'plan.pdf', created_at: '2026-11-20T00:00:00Z' },
          { id: 'private', user_id: 'u2', note_id: 'cap', action_id: null, project_id: null, data_row_id: null, file_name: 'secret.pdf', created_at: '2026-11-21T00:00:00Z' },
        ],
        log,
      ),
      { workspaceId: 'ws', userId: 'u1' },
      'fernhill budget',
    )
    expect(hits.map((h) => h.fileName)).toEqual(['plan.pdf'])
    expect(hits[0].snippet).toContain('Fernhill budget')
    expect(log.filter((l) => l[0] === 'ilike').map((l) => l[3])).toEqual(['%fernhill%', '%budget%'])
    expect(log).toContainEqual(['eq', 'attachment_chunks', 'workspace_id', 'ws'])
  })

  it('finds nothing for nothing typed', async () => {
    expect((await searchUploadText(service([], []), { workspaceId: 'ws', userId: 'u1' }, ' . ')).hits).toEqual([])
  })
})

describe('searchChatFileText', () => {
  it('asks 697’s search for the person, and shapes its rows', async () => {
    const log: Array<[string, ...unknown[]]> = []
    const { hits } = await searchChatFileText(service([], [], log), { workspaceId: 'ws', requestingUserId: 'u1' }, 'spring launch', 50)
    expect(log).toContainEqual(['rpc', 'team_chat_file_search', { ws: 'ws', q: 'spring launch', lim: 25, p_requesting_user_id: 'u1' }])
    expect(hits).toEqual([{ messageId: 'm1', channelId: 'c1', channelKind: 'channel', channelName: 'design', filePath: 'c1/u/a.pdf', fileName: 'brief.pdf', snippet: 'launch in spring', createdAt: '2026-11-20T00:00:00Z' }])
  })

  it('on the caller’s own client names no one else', async () => {
    const log: Array<[string, ...unknown[]]> = []
    await searchChatFileText(service([], [], log), { workspaceId: 'ws' }, 'spring')
    expect(log[0][2]).toEqual({ ws: 'ws', q: 'spring', lim: 8 })
  })
})
