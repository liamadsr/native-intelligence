/**
 * The pieces every way of reaching a person outside the app shares
 * (docs/plans/reach-follows-you.md; the router itself is ./route.ts):
 *
 *   - quiet hours: 21:00 to 08:00 in the person's zone. Routine messages wait
 *     them out on every channel; only an urgent one goes through;
 *   - Slack: their linked Slack account in the workspace, with the DMs on
 *     (slack_user_link.alerts_off_at);
 *   - texts: their verified phone, not opted out (STOP). Linking a phone is
 *     the agreement (Liam, 2026-10-31: "I don't want this to be a setting, it
 *     should just happen"): there is no separate switch for texts while they
 *     are away, and STOP is the way out (smsConsent).
 *
 * The person's own texts are never capped (Liam, 2026-10-31: "We don't need a
 * text cap"); a guest's are (text-turn-server.ts), and so are the replies to
 * numbers Dial8 can't tie to anyone (src/lib/sms/store.ts).
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/** Quiet hours: from QUIET_START_HOUR to QUIET_END_HOUR, in the person's zone. */
export const QUIET_START_HOUR = 21
export const QUIET_END_HOUR = 8

/**
 * The hour and minute in `timeZone` at `nowMs`, and the instant of the next
 * QUIET_END_HOUR:00 there when it is inside quiet hours (else null). Pure.
 */
export function quietUntil(nowMs: number, timeZone: string): number | null {
  let hour: number
  let minute: number
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(nowMs))
    hour = Number(parts.find((p) => p.type === 'hour')?.value)
    minute = Number(parts.find((p) => p.type === 'minute')?.value)
  } catch {
    return quietUntil(nowMs, 'UTC')
  }
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null
  const quiet = hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR
  if (!quiet) return null
  const hoursLeft = hour >= QUIET_START_HOUR ? 24 - hour + QUIET_END_HOUR : QUIET_END_HOUR - hour
  // Whole minutes from now to QUIET_END_HOUR:00 local (a zone's DST shift that night moves it by its hour at most).
  return nowMs + (hoursLeft * 60 - minute) * 60_000
}

/**
 * Texts go only to US and Canadian numbers: with no known zone, quiet hours
 * hold in every mainland zone from Eastern to Pacific (the later end). Pure.
 */
export function smsQuietUntil(nowMs: number, timeZone: string | null): number | null {
  const zones = timeZone ? [timeZone] : ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles']
  const untils = zones.map((z) => quietUntil(nowMs, z)).filter((u): u is number => u !== null)
  return untils.length ? Math.max(...untils) : null
}

/** Their linked Slack account in a workspace with the DMs on. */
export interface SlackReachTarget {
  installationId: string
  slackUserId: string
}

/** Their linked Slack account in the workspace with the DMs on, or null. Never throws (null). */
export async function slackTarget(supabase: SupabaseClient, input: { userId: string; workspaceId: string }): Promise<SlackReachTarget | null> {
  try {
    const { data: installs, error } = await supabase
      .from('slack_installation')
      .select('slack_team_id, connect_installation_id')
      .eq('workspace_id', input.workspaceId)
      .eq('status', 'active')
    if (error || !Array.isArray(installs) || installs.length === 0) return null
    const teams = installs as Array<{ slack_team_id: string; connect_installation_id: string }>
    const { data: links, error: linkError } = await supabase
      .from('slack_user_link')
      .select('slack_team_id, slack_user_id, alerts_off_at')
      .eq('user_id', input.userId)
      .in('slack_team_id', teams.map((t) => t.slack_team_id))
    // A failed read (a database without 426 has no alerts_off_at) reaches nobody.
    if (linkError || !Array.isArray(links)) return null
    const link = (links as Array<{ slack_team_id: string; slack_user_id: string; alerts_off_at: string | null }>).find((l) => !l.alerts_off_at)
    const team = link && teams.find((t) => t.slack_team_id === link.slack_team_id)
    return link && team ? { installationId: team.connect_installation_id, slackUserId: link.slack_user_id } : null
  } catch {
    return null
  }
}

/**
 * Whether Dial8 may text them while they are away: 'away' for any verified
 * phone that hasn't said STOP (linking is the agreement, no separate switch:
 * Liam, 2026-10-31), null for no verified phone or one that said STOP.
 * Never throws (null).
 */
export type SmsConsent = 'away' | null

export async function smsConsent(supabase: SupabaseClient, userId: string): Promise<SmsConsent> {
  try {
    const { data, error } = await supabase
      .from('user_phone')
      .select('opted_out_at')
      .eq('user_id', userId)
      .not('verified_at', 'is', null)
      .maybeSingle<{ opted_out_at: string | null }>()
    // A reply by code is answered before the phone's own workspace check
    // (src/lib/sms/inbound.ts), so a person who left that workspace can still answer.
    if (error || !data || data.opted_out_at) return null
    return 'away'
  } catch {
    return null
  }
}
