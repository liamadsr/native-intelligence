/**
 * Who pays for a check, decided before anything is bought.
 *
 *   MANUAL     a person asked: the access check (../access.ts) with their
 *              id (no key, a free-plan person, or a turn nobody is in is
 *              refused), and the spend is metered as theirs.
 *   SCHEDULED  nobody is watching, so the check goes ahead only when
 *                - the server has the provider's key;
 *                - the tracker is not paused and its schedule is on;
 *                - the person who set the schedule up still has an account,
 *                  is still a full member of the workspace (a guest's
 *                  schedule does not run, ../membership.ts), and is not on
 *                  the free plan. A plan we can't read skips this check rather
 *                  than spending: the next one tries again.
 *              It spends with userId null, so the workspace's monthly
 *              ceiling still applies; a ceiling refusal ends the check
 *              failed with the ceiling's own message (./engine.ts).
 *
 * The scheduled gate runs twice: in the cron before a check is created (a
 * refusal is written on the tracker as last_skip_reason) and again when the
 * background lane picks the check up (things change in between).
 */
import { isDataforseoConfigured } from '@/lib/seo/dataforseo'
import { isFullMemberRole, memberRole } from '@/lib/seo/membership'
import { onFreePlan } from '@/lib/seo/plan'
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'
import { SKIP_REASON_MESSAGES, type AiSkipReason } from './view'

export interface ScheduledGateDeps {
  isConfigured?: () => boolean
  isMember?: (workspaceId: string, userId: string) => Promise<boolean>
  /** True on the free plan; throws when the plan can't be read. */
  isFreePlan?: (userId: string) => Promise<boolean>
}

export type GateRefusal = {
  ok: false
  reason: AiSkipReason | 'paused' | 'schedule_off'
  message: string
}
export type GateResult = { ok: true } | GateRefusal

function refuse(reason: AiSkipReason): GateRefusal {
  return { ok: false, reason, message: SKIP_REASON_MESSAGES[reason] }
}

/** Whether the person is a full member of the workspace (owner, admin, member): a guest is not. Throws when it can't be read. */
export function memberCheck(svc: SupabaseClient) {
  return async (workspaceId: string, userId: string): Promise<boolean> =>
    isFullMemberRole(await memberRole(svc, workspaceId, userId))
}

/** May a scheduled check of this tracker spend now? */
export async function scheduledRunGate(
  svc: SupabaseClient,
  tracker: {
    workspace_id: string
    created_by: string | null
    paused: boolean
    schedule_interval: string
  },
  deps: ScheduledGateDeps = {},
): Promise<GateResult> {
  if (!(deps.isConfigured ?? isDataforseoConfigured)())
    return refuse('not_configured')
  if (tracker.paused)
    return { ok: false, reason: 'paused', message: 'The tracker is paused.' }
  if (tracker.schedule_interval === 'off')
    return {
      ok: false,
      reason: 'schedule_off',
      message: 'The tracker’s schedule is off.',
    }
  if (!tracker.created_by) return refuse('creator_gone')
  let member: boolean
  try {
    member = await (deps.isMember ?? memberCheck(svc))(
      tracker.workspace_id,
      tracker.created_by,
    )
  } catch (err) {
    console.error('[seo-ai] schedule gate: member check failed', err)
    return refuse('plan_unreadable')
  }
  if (!member) return refuse('creator_not_member')
  let free: boolean
  try {
    free = await (
      deps.isFreePlan ?? ((userId: string) => onFreePlan(userId, { attempts: 2 }))
    )(tracker.created_by)
  } catch (err) {
    console.error('[seo-ai] schedule gate: plan check failed', err)
    return refuse('plan_unreadable')
  }
  if (free) return refuse('free_plan')
  return { ok: true }
}
