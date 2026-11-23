/**
 * Messages are read with poll_id once migration 703 is there, and without it
 * before, so a deploy ahead of 703 still reads team chat.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { messageColumns, resetMessageColumns } from '../store'
import { TEAM_CHAT_MESSAGE_COLUMNS, TEAM_CHAT_MESSAGE_COLUMNS_BEFORE_703 } from '../types'

function client(there: boolean) {
  const calls = { n: 0 }
  const supabase = {
    from: () => ({
      select: () => ({
        limit: async () => {
          calls.n += 1
          return there ? { data: [], error: null } : { data: null, error: { code: '42703', message: 'column team_chat_message.poll_id does not exist' } }
        },
      }),
    }),
  } as unknown as SupabaseClient
  return { supabase, calls }
}

beforeEach(() => resetMessageColumns())

describe('messageColumns', () => {
  it('with poll_id once it is there, asked once', async () => {
    const { supabase, calls } = client(true)
    expect(await messageColumns(supabase)).toBe(TEAM_CHAT_MESSAGE_COLUMNS)
    expect(await messageColumns(supabase)).toBe(TEAM_CHAT_MESSAGE_COLUMNS)
    expect(calls.n).toBe(1)
    expect(TEAM_CHAT_MESSAGE_COLUMNS).toContain('poll_id')
  })
  it('without it before 703, asking again after a minute', async () => {
    const { supabase, calls } = client(false)
    expect(await messageColumns(supabase, 1_000)).toBe(TEAM_CHAT_MESSAGE_COLUMNS_BEFORE_703)
    expect(await messageColumns(supabase, 30_000)).toBe(TEAM_CHAT_MESSAGE_COLUMNS_BEFORE_703)
    expect(calls.n).toBe(1)
    await messageColumns(supabase, 70_000)
    expect(calls.n).toBe(2)
    expect(TEAM_CHAT_MESSAGE_COLUMNS_BEFORE_703).not.toContain('poll_id')
    expect(TEAM_CHAT_MESSAGE_COLUMNS_BEFORE_703).toContain('guest_name')
  })
})
