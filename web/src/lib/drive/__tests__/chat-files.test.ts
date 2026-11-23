import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { decodeChatCursor, encodeChatCursor, listChatFiles } from '../chat-files'

const MSG1 = '11111111-1111-4111-8111-111111111111'
const MSG2 = '22222222-2222-4222-8222-222222222222'
const ME = '33333333-3333-4333-8333-333333333333'

/** A fake session client recording the read it was asked for. */
function client(rows: unknown[], calls: Array<[string, ...unknown[]]>) {
  const chain: Record<string, (...args: unknown[]) => unknown> = {}
  for (const m of ['select', 'eq', 'is', 'neq', 'or', 'order']) {
    chain[m] = (...args: unknown[]) => {
      calls.push([m, ...args])
      return chain
    }
  }
  chain.limit = (n: unknown) => {
    calls.push(['limit', n])
    return Promise.resolve({ data: rows, error: null })
  }
  return { from: (t: string) => (calls.push(['from', t]), chain) } as unknown as SupabaseClient
}

const row = (id: string, at: string, files: Array<{ path: string; name: string }>, channel: unknown = { id: 'c1', kind: 'channel', name: 'design' }) => ({
  id,
  channel_id: 'c1',
  author_member_id: ME,
  created_at: at,
  attachments: files.map((f) => ({ ...f, size: 10, type: 'application/pdf' })),
  team_chat_channel: channel,
})

describe('listChatFiles', () => {
  it('reads the workspace’s live messages that carry files, newest first, through the session’s own row security', async () => {
    const calls: Array<[string, ...unknown[]]> = []
    const page = await listChatFiles(client([row(MSG1, '2026-11-20T10:00:00Z', [{ path: 'c1/u/a.pdf', name: 'Plan.pdf' }, { path: 'c1/u/b.png', name: 'shot.png' }])], calls), 'ws1', { limit: 50 })
    expect(calls).toContainEqual(['from', 'team_chat_message'])
    expect(calls).toContainEqual(['eq', 'workspace_id', 'ws1'])
    expect(calls).toContainEqual(['is', 'deleted_at', null])
    expect(calls).toContainEqual(['neq', 'attachments', '[]'])
    expect(calls).toContainEqual(['limit', 51])
    expect(page.files.map((f) => [f.key, f.name, f.channel.name])).toEqual([
      ['c1/u/a.pdf', 'Plan.pdf', 'design'],
      ['c1/u/b.png', 'shot.png', 'design'],
    ])
    expect(page.before).toBeNull()
  })

  it('pages on by a cursor of the last message, and filters by name and sender', async () => {
    const calls: Array<[string, ...unknown[]]> = []
    const rows = [row(MSG2, '2026-11-21T10:00:00Z', [{ path: 'c1/u/x.pdf', name: 'Budget.pdf' }, { path: 'c1/u/y.pdf', name: 'notes.pdf' }]), row(MSG1, '2026-11-20T10:00:00Z', [])]
    const page = await listChatFiles(client(rows, calls), 'ws1', { limit: 1, q: 'budget', authorMemberId: ME })
    expect(calls).toContainEqual(['eq', 'author_member_id', ME])
    expect(page.files.map((f) => f.name)).toEqual(['Budget.pdf'])
    expect(decodeChatCursor(page.before)).toEqual({ createdAt: '2026-11-21T10:00:00Z', id: MSG2 })
    const next: Array<[string, ...unknown[]]> = []
    await listChatFiles(client([], next), 'ws1', { limit: 1, before: page.before, notAuthorMemberId: ME })
    expect(next).toContainEqual(['or', `author_member_id.is.null,author_member_id.neq.${ME}`])
    expect(next).toContainEqual(['or', `created_at.lt."2026-11-21T10:00:00Z",and(created_at.eq."2026-11-21T10:00:00Z",id.lt.${MSG2})`])
  })

  it('lists nothing for a message whose channel the reader can’t see, and refuses a cursor it did not write', async () => {
    const page = await listChatFiles(client([row(MSG1, '2026-11-20T10:00:00Z', [{ path: 'c9/u/a.pdf', name: 'a.pdf' }], null)], []), 'ws1', { limit: 50 })
    expect(page.files).toEqual([])
    const calls: Array<[string, ...unknown[]]> = []
    expect(await listChatFiles(client([], calls), 'ws1', { limit: 50, before: 'junk' })).toEqual({ files: [], before: null })
    expect(calls.find((c) => c[0] === 'limit')).toBeUndefined()
    expect(decodeChatCursor(encodeChatCursor('2026-11-20T10:00:00Z', 'not-a-uuid'))).toBeNull()
  })
})
