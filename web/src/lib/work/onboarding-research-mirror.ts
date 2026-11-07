/**
 * Onboarding research in the work ledger (docs/plans/agent-orchestration-product.md
 * §1.1, Sequence row 6). There is no run table: the state is
 * `member.onboarding_progress.research` plus an eve session. The ledger row
 * (kind `onboarding_research`, `run_key` = the eve session id) is its Activity
 * projection.
 *
 *   mirrorOnboardingResearchStarted   the research route, once the session id
 *                                     is recorded (status running)
 *   settleOnboardingResearchWork      after finish_research persisted done /
 *                                     skipped — called by the internal settle
 *                                     route, because the researcher runs in the
 *                                     eve runtime and cannot import this module.
 *                                     It reads the member's stored state and
 *                                     mirrors THAT; the caller's word is only
 *                                     the session id.
 *
 * A session that dies before finish_research leaves the row running; the
 * ledger's reaper fails it after its running deadline ("no report back").
 * The research comes from a bot (bots-v4.md Phase 5, workTeammateId): the
 * workspace's Researcher, else the Assistant, stamped on the ledger row only.
 * Fail-soft; needs the SERVICE client.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { attachWork, findWork, inertWork, startWork, type WorkHandle } from './recorder'
import { workTeammateId } from './system-teammates'
import { WORK_KINDS } from './types'

export async function mirrorOnboardingResearchStarted(
  supabase: SupabaseClient,
  args: { workspaceId: string; memberId: string; sessionId: string },
): Promise<WorkHandle> {
  try {
    // Who it comes from (Phase 5): attribution on the ledger row only.
    const aiTeamMemberId = await workTeammateId(supabase, {
      workspaceId: args.workspaceId,
      kind: 'onboarding_research',
      memberId: args.memberId,
    })
    return await startWork(supabase, {
      workspaceId: args.workspaceId,
      memberId: args.memberId,
      aiTeamMemberId,
      kind: WORK_KINDS.onboardingResearch,
      title: 'Researching your company',
      actor: 'agent',
      status: 'running',
      runKey: args.sessionId,
      source: { eve_session_id: args.sessionId },
    })
  } catch (err) {
    console.warn('[work] onboarding research mirror (start) failed:', err instanceof Error ? err.message : err)
    return inertWork({ kind: WORK_KINDS.onboardingResearch, workspaceId: args.workspaceId, memberId: args.memberId })
  }
}

interface StoredResearch {
  sessionId?: string
  status?: string
  companyFound?: boolean
  seededSummary?: { projectName?: string; actionCount?: number } | null
}

/** "Found your company; set up Launch plan with 4 actions" — one line. */
export function researchSummary(research: StoredResearch): string {
  const parts: string[] = []
  parts.push(research.companyFound ? 'Found your company' : 'No company profile found')
  const seeded = research.seededSummary
  if (seeded?.projectName) {
    const n = seeded.actionCount ?? 0
    parts.push(`set up ${seeded.projectName} with ${n} action${n === 1 ? '' : 's'}`)
  }
  return parts.join('; ')
}

export type ResearchSettleResult =
  | { settled: 'done' | 'skipped' }
  | { settled: null; reason: 'no_item' | 'session_mismatch' | 'not_finished' }

/** Mirror the member's stored research state for this session onto its row. */
export async function settleOnboardingResearchWork(
  supabase: SupabaseClient,
  sessionId: string,
): Promise<ResearchSettleResult> {
  const row = await findWork(supabase, { runKey: sessionId, kind: WORK_KINDS.onboardingResearch })
  if (!row) return { settled: null, reason: 'no_item' }
  const { data } = await supabase
    .from('member')
    .select('onboarding_progress')
    .eq('id', row.member_id)
    .maybeSingle()
  const research = ((data as { onboarding_progress?: { research?: StoredResearch } | null } | null)
    ?.onboarding_progress?.research ?? null) as StoredResearch | null
  if (!research || research.sessionId !== sessionId) return { settled: null, reason: 'session_mismatch' }
  const handle = attachWork(supabase, row)
  if (research.status === 'done') {
    await handle.finish({ summary: researchSummary(research) })
    return { settled: 'done' }
  }
  if (research.status === 'skipped') {
    await handle.skip(researchSummary(research))
    return { settled: 'skipped' }
  }
  return { settled: null, reason: 'not_finished' }
}
