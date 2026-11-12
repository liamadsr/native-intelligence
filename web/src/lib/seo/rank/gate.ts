/**
 * Whether a tracker's scheduled check may run: the one gate, used by the
 * schedule's cron before it starts a check and by the check itself before
 * it spends (the person's standing can change while a check waits).
 *
 * A scheduled check is nobody's turn, so it does not go through the access
 * check a person's request goes through (../access.ts refuses every
 * unattended lookup). It runs on the standing of the person who set the
 * tracker up, and only while:
 *
 *   1. the server has the search data key;
 *   2. the tracker is not paused;
 *   3. it has keywords;
 *   4. that person still has an account, and is still a member of the
 *      workspace (owner, admin or member: a guest's schedule does not run);
 *   5. that person is not on the free plan (their own ChatGPT plan: nothing
 *      of ours is spent for them, as in ../access.ts).
 *
 * The workspace's monthly ceiling still applies to every search (the check
 * spends through the metered client), and a ceiling refusal fails the check
 * with the ceiling's own words; the schedule tries again at its next time.
 *
 * An answer that can't be read (the membership or plan lookup failed) skips
 * this tick rather than spending: the tracker stays due and the next tick
 * asks again. Every other refusal skips this check for good: the schedule
 * moves on and the tracker says why.
 */
import { isDataforseoConfigured } from '@/lib/seo/dataforseo'
import { isFullMemberRole } from '@/lib/seo/membership'
import { onFreePlan } from '@/lib/seo/plan'
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'
import { skipReasonMessage, type RankSkipReason } from './view'

export type ScheduledGateResult =
  | { ok: true }
  /** Skip this check: the schedule advances and the reason is kept on the tracker. */
  | {
      ok: false
      retry: false
      reason: RankSkipReason | 'paused'
      message: string
    }
  /** Couldn't tell: leave the tracker due and ask again next tick. Spends nothing. */
  | { ok: false; retry: true; reason: 'unreadable'; message: string }

export interface GateDeps {
  configured: () => boolean
  /** The person's role in the workspace, or null when they are not in it. Throws when it can't be read. */
  memberRole: (workspaceId: string, userId: string) => Promise<string | null>
  /** Whether the person runs on their own ChatGPT plan (the free tier). Throws when it can't be read. */
  onFreePlan: (userId: string) => Promise<boolean>
}

function skip(reason: RankSkipReason | 'paused'): ScheduledGateResult {
  return {
    ok: false,
    retry: false,
    reason,
    message:
      reason === 'paused'
        ? 'The tracker is paused.'
        : (skipReasonMessage(reason) ?? 'Skipped.'),
  }
}

export async function scheduledCheckGate(
  tracker: { workspace_id: string; created_by: string | null; paused: boolean },
  keywordCount: number,
  deps: GateDeps,
): Promise<ScheduledGateResult> {
  if (!deps.configured()) return skip('not_configured')
  if (tracker.paused) return skip('paused')
  if (keywordCount <= 0) return skip('no_keywords')
  if (!tracker.created_by) return skip('creator_gone')

  let role: string | null
  let freePlan: boolean
  try {
    role = await deps.memberRole(tracker.workspace_id, tracker.created_by)
    if (!isFullMemberRole(role))
      return skip('creator_not_member')
    freePlan = await deps.onFreePlan(tracker.created_by)
  } catch (err) {
    console.error(
      '[seo-rank] schedule gate: could not read the person’s standing',
      err,
    )
    return {
      ok: false,
      retry: true,
      reason: 'unreadable',
      message:
        'Could not check the plan of the person who set this tracker up.',
    }
  }
  if (freePlan) return skip('free_plan')
  return { ok: true }
}

/** The gate's lookups against the database and the plan check. */
export function gateDeps(svc: SupabaseClient): GateDeps {
  return {
    configured: isDataforseoConfigured,
    memberRole: async (workspaceId, userId) => {
      const { data, error } = await svc
        .from('member')
        .select('role')
        .eq('workspace_id', workspaceId)
        .eq('user_id', userId)
        .maybeSingle()
      if (error) throw new Error(`member read failed: ${error.message}`)
      return (data as { role?: string } | null)?.role ?? null
    },
    // An unreadable plan throws, so the gate skips instead of spending.
    onFreePlan: (userId) => onFreePlan(userId),
  }
}
