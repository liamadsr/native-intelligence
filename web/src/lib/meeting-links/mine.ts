/**
 * The person's meetings for team chat's meetings section (server only):
 * every meeting whose conversation they are in (they host it, were invited,
 * or joined by its link), used or not, that is current or ended within
 * MEETING_RECENT_MS. Never someone else's: the meetings are read as the
 * person (RLS) and kept only when the person is a member of the meeting's
 * conversation. Each with whether its call is live and its link (made again
 * from its nonce, read with the service role: no client may read a nonce).
 * The section orders them (./section.ts).
 */
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { meetingLink } from './link'
import { MEETING_RECENT_MS, type MyMeeting } from './section'

const COLUMNS = 'id, channel_id, host_member_id, title, starts_at, ends_at, opens_at, closes_at, revoked_at, created_at'

type Row = Omit<MyMeeting, 'is_host' | 'live' | 'url'>

/** Throws on a failed read. */
export async function listMyMeetings(supabase: SupabaseClient, svc: SupabaseClient, args: { workspaceId: string; userId: string; now?: number }): Promise<MyMeeting[]> {
  const now = args.now ?? Date.now()
  const { data: me, error: meError } = await supabase.from('member').select('id').eq('user_id', args.userId).eq('workspace_id', args.workspaceId).maybeSingle<{ id: string }>()
  if (meError) throw new Error(`meetings: member read failed: ${meError.message}`)
  if (!me) return []
  const since = new Date(now - MEETING_RECENT_MS).toISOString()
  const [{ data: rows, error }, { data: mine, error: mineError }] = await Promise.all([
    supabase.from('meeting').select(COLUMNS).eq('workspace_id', args.workspaceId).gte('closes_at', since).order('created_at', { ascending: false }).limit(100),
    supabase.from('team_chat_member').select('channel_id').eq('member_id', me.id),
  ])
  if (error) throw new Error(`meetings: read failed: ${error.message}`)
  if (mineError) throw new Error(`meetings: memberships read failed: ${mineError.message}`)
  const inMine = new Set(((mine ?? []) as Array<{ channel_id: string }>).map((r) => r.channel_id))
  const meetings = ((rows ?? []) as Row[]).filter((m) => inMine.has(m.channel_id) && (!m.revoked_at || Date.parse(m.revoked_at) >= now - MEETING_RECENT_MS))
  if (!meetings.length) return []
  const ids = meetings.map((m) => m.id)
  const [{ data: calls }, { data: nonces, error: nonceError }] = await Promise.all([
    supabase.from('team_call').select('channel_id').in('channel_id', meetings.map((m) => m.channel_id)).eq('status', 'live'),
    svc.from('meeting').select('id, token_nonce').in('id', ids),
  ])
  if (nonceError) throw new Error(`meetings: links read failed: ${nonceError.message}`)
  const live = new Set(((calls ?? []) as Array<{ channel_id: string }>).map((c) => c.channel_id))
  const nonceOf = new Map(((nonces ?? []) as Array<{ id: string; token_nonce: string | null }>).map((n) => [n.id, n.token_nonce]))
  return meetings.map((m) => {
    const nonce = nonceOf.get(m.id)
    return {
      id: m.id,
      channel_id: m.channel_id,
      title: m.title,
      starts_at: m.starts_at,
      ends_at: m.ends_at,
      opens_at: m.opens_at,
      closes_at: m.closes_at,
      revoked_at: m.revoked_at,
      created_at: m.created_at,
      host_member_id: m.host_member_id,
      is_host: m.host_member_id === me.id,
      live: live.has(m.channel_id),
      url: !m.revoked_at && nonce ? meetingLink(m.id, nonce) : null,
    }
  })
}
