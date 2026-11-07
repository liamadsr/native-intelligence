/**
 * `member.time_zone` (migration 336): the person's IANA zone in a workspace,
 * for the 8:00 local digest (A6 slice 4) and every time the server writes
 * with no browser behind it (a server-written chat turn's clock, a meeting
 * prep's start: readMemberTimeZone). Saved by the chat spec
 * (chat-run-rebuild.ts) from the browser's zone, which the spec already checks
 * (isTimeZone) before it is trusted anywhere, and only when it differs from
 * the stored one, so a steady zone costs one small read per turn and no write.
 * Off the turn's path, never throwing.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isTimeZone } from '@/lib/chat-cards/calendar'

/** The column's check (migration 336): letters, digits and _ + - / only, at most 64 characters. */
const STORABLE_ZONE_RE = /^[A-Za-z0-9_+/-]{1,64}$/

export function isStorableTimeZone(value: unknown): value is string {
  return typeof value === 'string' && STORABLE_ZONE_RE.test(value) && isTimeZone(value)
}

/**
 * Save `timeZone` on the person's member row in the workspace when it is a
 * checked zone that differs from the stored one. Returns whether it wrote.
 * Never throws.
 */
export async function saveMemberTimeZone(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; timeZone: string | null | undefined },
): Promise<boolean> {
  try {
    if (!isStorableTimeZone(args.timeZone)) return false
    const { data, error } = await supabase
      .from('member')
      .select('id, time_zone')
      .eq('workspace_id', args.workspaceId)
      .eq('user_id', args.userId)
      .maybeSingle()
    if (error || !data) return false
    const row = data as { id?: unknown; time_zone?: unknown }
    if (row.time_zone === args.timeZone || typeof row.id !== 'string') return false
    const { error: updateError } = await supabase.from('member').update({ time_zone: args.timeZone }).eq('id', row.id).eq('workspace_id', args.workspaceId)
    if (updateError) {
      console.warn('[chat-spec] time zone save skipped:', updateError.message)
      return false
    }
    return true
  } catch (err) {
    console.warn('[chat-spec] time zone save skipped:', err instanceof Error ? err.message : err)
    return false
  }
}

/**
 * Where a person's zone came from, best first. There is no stored calendar
 * zone (calendar events are read live from the provider) and no workspace zone
 * (workspace.settings carries none; team.timezone is per team and 'UTC' by
 * default), so the chain is:
 *   'member'          — member.time_zone in THIS workspace (the browser zone the
 *                       chat spec saved here);
 *   'other_workspace' — the same person's member.time_zone saved in another
 *                       workspace (the same browser zone, saved there);
 *   'profile'         — the legacy profile zone (user_profiles.timezone, set
 *                       in the iOS app);
 *   'utc'             — none known: UTC, still scheduled.
 */
export type TimeZoneSource = 'member' | 'other_workspace' | 'profile' | 'utc'

/** The first checked zone in the chain, else UTC. Pure. */
export function pickTimeZone(zones: {
  member?: unknown
  otherWorkspace?: unknown
  profile?: unknown
}): { timeZone: string; source: TimeZoneSource } {
  if (isStorableTimeZone(zones.member)) return { timeZone: zones.member, source: 'member' }
  if (isStorableTimeZone(zones.otherWorkspace)) return { timeZone: zones.otherWorkspace, source: 'other_workspace' }
  if (isStorableTimeZone(zones.profile)) return { timeZone: zones.profile, source: 'profile' }
  return { timeZone: 'UTC', source: 'utc' }
}

const PROFILE_CHUNK = 200

/**
 * The legacy profile zone for each of `userIds` that has a checked one. A
 * failed read keeps what was read so far (the chain then falls to UTC).
 */
export async function profileTimeZones(supabase: SupabaseClient, userIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const ids = [...new Set(userIds)]
  for (let i = 0; i < ids.length; i += PROFILE_CHUNK) {
    const { data, error } = await supabase
      .from('user_profiles')
      .select('user_id, timezone')
      .in('user_id', ids.slice(i, i + PROFILE_CHUNK))
      .not('timezone', 'is', null)
    if (error) {
      console.warn('[member-time-zone] profile zone read failed:', error.message)
      break
    }
    for (const r of (data as Array<{ user_id?: unknown; timezone?: unknown }> | null) ?? []) {
      if (typeof r.user_id === 'string' && isStorableTimeZone(r.timezone) && !out.has(r.user_id)) out.set(r.user_id, r.timezone)
    }
  }
  return out
}

/**
 * One person's zone in a workspace, down the chain (pickTimeZone). Reads the
 * fallbacks only when this workspace's member row has no zone. Never throws.
 */
export async function resolveMemberTimeZone(
  supabase: SupabaseClient,
  args: { userId: string; memberTimeZone: string | null | undefined },
): Promise<{ timeZone: string; source: TimeZoneSource }> {
  if (isStorableTimeZone(args.memberTimeZone)) return { timeZone: args.memberTimeZone, source: 'member' }
  try {
    const { data } = await supabase
      .from('member')
      .select('time_zone')
      .eq('user_id', args.userId)
      .not('time_zone', 'is', null)
      .limit(5)
    const other = ((data as Array<{ time_zone?: unknown }> | null) ?? []).map((r) => r.time_zone).find(isStorableTimeZone)
    if (other) return { timeZone: other, source: 'other_workspace' }
    const profiles = await profileTimeZones(supabase, [args.userId])
    return pickTimeZone({ profile: profiles.get(args.userId) })
  } catch (err) {
    console.warn('[member-time-zone] zone fallback skipped:', err instanceof Error ? err.message : err)
    return { timeZone: 'UTC', source: 'utc' }
  }
}

/**
 * One person's zone in a workspace, read from scratch, down the chain
 * (pickTimeZone): their member row's zone here, then one saved in another
 * workspace, then the profile zone, UTC last. Its reads go out together (one
 * round trip). For what the server writes with no browser behind it: a
 * server-written chat turn (a helper's report, the digest, an event: the chat
 * spec), a meeting prep's brief and its report. Never throws.
 */
export async function readMemberTimeZone(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string },
): Promise<{ timeZone: string; source: TimeZoneSource }> {
  try {
    const [members, profiles] = await Promise.all([
      supabase.from('member').select('workspace_id, time_zone').eq('user_id', args.userId).limit(50),
      profileTimeZones(supabase, [args.userId]),
    ])
    const rows = members.error ? [] : ((members.data as Array<{ workspace_id?: unknown; time_zone?: unknown }> | null) ?? [])
    return pickTimeZone({
      member: rows.find((r) => r.workspace_id === args.workspaceId)?.time_zone,
      otherWorkspace: rows.filter((r) => r.workspace_id !== args.workspaceId).map((r) => r.time_zone).find(isStorableTimeZone),
      profile: profiles.get(args.userId),
    })
  } catch (err) {
    console.warn('[member-time-zone] zone read skipped:', err instanceof Error ? err.message : err)
    return { timeZone: 'UTC', source: 'utc' }
  }
}
