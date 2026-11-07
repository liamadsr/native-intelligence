/**
 * isLiveCallTurn: the server, not the client's liveCaptureId, decides whether a
 * chat turn is a live call's turn.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { isLiveCallTurn } from '../live-turn-gate'

const CAP = '11111111-2222-4333-8444-555555555555'
const OTHER = '99999999-2222-4333-8444-555555555555'

interface Rows {
  conversation?: { capture_id: string | null } | null
  capture?: { id: string; ended_at: string | null } | null
  error?: boolean
}

function client(rows: Rows) {
  const filters: Array<[string, string, unknown]> = []
  const from = (table: string) => {
    const q = {
      select: () => q,
      eq: (col: string, val: unknown) => {
        filters.push([table, col, val])
        return q
      },
      maybeSingle: async () => ({
        data: table === 'chat_conversations' ? (rows.conversation ?? null) : (rows.capture ?? null),
        error: rows.error ? { message: 'boom' } : null,
      }),
    }
    return q
  }
  return { supabase: { from } as unknown as SupabaseClient, filters }
}

const input = (captureId: unknown = CAP) => ({ conversationId: 'conv-1', captureId, workspaceId: 'ws-1', userId: 'user-1' })

describe('isLiveCallTurn', () => {
  it('live: the conversation is the capture’s, the capture is the caller’s own and still going', async () => {
    const { supabase, filters } = client({ conversation: { capture_id: CAP }, capture: { id: CAP, ended_at: null } })
    expect(await isLiveCallTurn(supabase, input())).toBe(true)
    expect(filters).toEqual(
      expect.arrayContaining([
        ['chat_conversations', 'id', 'conv-1'],
        ['chat_conversations', 'user_id', 'user-1'],
        ['captures', 'id', CAP],
        ['captures', 'workspace_id', 'ws-1'],
        ['captures', 'user_id', 'user-1'],
      ]),
    )
  })

  it('not live: another conversation (the main chat naming a capture)', async () => {
    const { supabase } = client({ conversation: { capture_id: null }, capture: { id: CAP, ended_at: null } })
    expect(await isLiveCallTurn(supabase, input())).toBe(false)
    const other = client({ conversation: { capture_id: OTHER }, capture: { id: CAP, ended_at: null } })
    expect(await isLiveCallTurn(other.supabase, input())).toBe(false)
  })

  it('not live: not the caller’s capture (no row under their id), or the call ended', async () => {
    expect(await isLiveCallTurn(client({ conversation: { capture_id: CAP }, capture: null }).supabase, input())).toBe(false)
    const ended = client({ conversation: { capture_id: CAP }, capture: { id: CAP, ended_at: '2026-10-15T10:00:00Z' } })
    expect(await isLiveCallTurn(ended.supabase, input())).toBe(false)
  })

  it('not live: a malformed id (no read), or a failed read', async () => {
    const { supabase, filters } = client({ conversation: { capture_id: CAP }, capture: { id: CAP, ended_at: null } })
    expect(await isLiveCallTurn(supabase, input('cap-1'))).toBe(false)
    expect(await isLiveCallTurn(supabase, input(42))).toBe(false)
    expect(filters).toHaveLength(0)
    const failed = client({ conversation: { capture_id: CAP }, capture: { id: CAP, ended_at: null }, error: true })
    expect(await isLiveCallTurn(failed.supabase, input())).toBe(false)
  })
})
