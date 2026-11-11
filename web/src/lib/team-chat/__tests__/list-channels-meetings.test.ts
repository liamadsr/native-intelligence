/**
 * Team chat's channel list and meeting conversations (src/lib/team-chat/
 * store.ts listChannels): a meeting's conversation is listed once it was
 * used, or while its meeting is current (just made, upcoming, or ended a
 * short while ago), so the meetings section can open it from the moment it
 * is made; one long over and never used stays out.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'

vi.mock('server-only', () => ({}))

import { listChannels } from '../store'
import { MEETING_RECENT_MS } from '@/lib/meeting-links/section'

const WS = 'ws-1'
const iso = (ms: number) => new Date(ms).toISOString()

describe('meeting conversations in the channel list', () => {
  it('used, or current: listed; long over and never used: not', async () => {
    const now = Date.now()
    const channel = (id: string, kind: string, last: string | null) => ({ id, workspace_id: WS, kind, name: id, topic: null, team_id: null, dm_key: null, last_message_at: last, archived_at: null, created_at: iso(now - 1000) })
    const tables = {
      team_chat_channel: [
        channel('general', 'channel', iso(now - 5000)),
        channel('used-meeting', 'meeting', iso(now - 9000)),
        channel('just-made', 'meeting', null),
        channel('revoked-now', 'meeting', null),
        channel('long-over', 'meeting', null),
        channel('revoked-long', 'meeting', null),
      ],
      meeting: [
        { channel_id: 'just-made', revoked_at: null, closes_at: iso(now + 30 * 24 * 3_600_000) },
        { channel_id: 'revoked-now', revoked_at: iso(now - 60_000), closes_at: iso(now + 24 * 3_600_000) },
        { channel_id: 'long-over', revoked_at: null, closes_at: iso(now - MEETING_RECENT_MS - 60_000) },
        { channel_id: 'revoked-long', revoked_at: iso(now - MEETING_RECENT_MS - 60_000), closes_at: iso(now + 24 * 3_600_000) },
      ],
      team_chat_member: [],
    }
    const db = Object.assign(memoryDb(tables), { rpc: async () => ({ data: [], error: null }) }) as unknown as SupabaseClient
    const { channels } = await listChannels(db, { workspaceId: WS, memberId: 'mem-me' })
    expect(channels.map((c) => c.id).sort()).toEqual(['general', 'just-made', 'revoked-now', 'used-meeting'])
  })
})
