import { NextResponse, type NextRequest } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { inngest } from '@/lib/inngest/client'
import { requireCronSecret } from '@/lib/api-auth'
import { startWork } from '@/lib/work/recorder'
import { WORK_KINDS } from '@/lib/work/types'
import { systemTeammateId } from '@/lib/work/system-teammates'
import { isUsageAllowed } from '@/lib/inngest/usage-guard'
import {
  captureReadiness,
  collectCandidateCaptureIds,
  exhaustedCaptureIds,
  extractDecidedProposalIds,
  selectEligibleCaptures,
  type PendingProposalRow,
  type ReconcileCaptureRow,
} from '@/lib/flows/triage-reconciler'

// Verdict-ledger lookback: a proposal decided within this window must not
// re-trigger a fire. 14d per plan WS-4a.
const RECONCILE_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000
// At most this many captures fired per tick — the backlog converges over ticks.
const RECONCILE_CAP = 5
// Bounds so a single tick can't scan unboundedly on a large workspace.
const PENDING_SCAN_LIMIT = 2000
const RUN_SCAN_LIMIT = 1000
// Ids per `.in()` filter, so a large candidate set never builds an over-long URL.
const IN_CHUNK = 100

export const maxDuration = 60

/**
 * GET /api/cron/triage-reconciler — WS-4a. Finds captures that still need triage
 * and re-fires `flow/capture.processed` for them, removing F4's single-emit-point
 * fragility without touching the live-agent hot path.
 *
 * ENABLED BY DEFAULT since precondition A5 (docs/plans/agent-orchestration-
 * investigation.md): it shipped env-gated off (LOOP-CLOSURE-PHASE3-PLAN WS-4a's
 * go-live gate, a founder call, not a technical blocker) and was never turned
 * on. It is safe by construction — it fires only in workspaces with an enabled
 * capture_processed flow, only for captures with a genuinely un-triaged
 * pending proposal (no verdict-ledger decision in 14d, no live card) that are
 * finished, settled for 15 min and not private, only in workspaces whose loop
 * passes the AI usage gate, at most MAX_RECONCILES_PER_CAPTURE times per
 * capture ever and 5 captures per tick, each fire a ledger row — and the
 * dispatcher re-checks capture visibility on a reconciled fire. Set
 * RECONCILER_ENABLED=false to switch it off. The server's cron issues GET with
 * `Authorization: Bearer ${CRON_SECRET}`.
 */
export async function GET(request: NextRequest) {
  // Fails CLOSED on an unset secret (see requireCronSecret).
  const denied = requireCronSecret(request)
  if (denied) return denied

  if (process.env.RECONCILER_ENABLED === 'false') {
    return NextResponse.json({ ok: true, skipped: 'RECONCILER_ENABLED=false' })
  }

  const supabase = getServiceClient()
  const now = Date.now()

  // 1. Workspaces with an enabled capture_processed flow — the only workspaces a
  //    reconcile fire could do anything in. Carry the flow's run-as user so the
  //    tracked_job owner (member) resolves to the loop's identity.
  const { data: capFlows } = await supabase
    .from('flow')
    .select('workspace_id, created_by')
    .eq('trigger_type', 'capture_processed')
    .eq('enabled', true)
  if (!capFlows || capFlows.length === 0) {
    return NextResponse.json({ ok: true, workspaces: 0, eligible: 0, fired: 0 })
  }
  const wsRunAs = new Map<string, string | null>()
  // Every run-as identity per workspace (null = the flow has no creator, so the
  // dispatcher runs it as the workspace owner) — the usage gate's subjects.
  const wsRunAsAll = new Map<string, Set<string | null>>()
  for (const f of capFlows as Array<{ workspace_id: string; created_by: string | null }>) {
    if (!wsRunAs.has(f.workspace_id)) wsRunAs.set(f.workspace_id, f.created_by ?? null)
    const all = wsRunAsAll.get(f.workspace_id) ?? new Set<string | null>()
    all.add(f.created_by ?? null)
    wsRunAsAll.set(f.workspace_id, all)
  }
  const workspaceIds = [...wsRunAs.keys()]

  // 2. Pending proposals in those workspaces, oldest-first (drives fire order).
  //    A proposal with no capture (chat, sweeps) has nothing to reconcile.
  const { data: pending } = await supabase
    .from('proposed_change')
    .select('id, capture_id, workspace_id')
    .eq('status', 'pending')
    .not('capture_id', 'is', null)
    .in('workspace_id', workspaceIds)
    .order('created_at', { ascending: true })
    .limit(PENDING_SCAN_LIMIT)
  const pendingProposals = (pending ?? []) as PendingProposalRow[]
  if (pendingProposals.length === 0) {
    return NextResponse.json({ ok: true, workspaces: workspaceIds.length, eligible: 0, fired: 0 })
  }

  // 3. Proposals already decided in any verdict ledger of the lookback window.
  //    Scoped by flow_id (flow_run has no workspace_id column); a proposal id is
  //    globally unique so cross-workspace decided ids simply never match.
  const { data: wsFlows } = await supabase
    .from('flow')
    .select('id')
    .in('workspace_id', workspaceIds)
  const flowIds = (wsFlows ?? []).map((f) => (f as { id: string }).id)
  let decidedProposalIds = new Set<string>()
  if (flowIds.length > 0) {
    const { data: runs } = await supabase
      .from('flow_run')
      .select('action_results')
      .in('flow_id', flowIds)
      .gte('fired_at', new Date(now - RECONCILE_LOOKBACK_MS).toISOString())
      .order('fired_at', { ascending: false })
      .limit(RUN_SCAN_LIMIT)
    decidedProposalIds = extractDecidedProposalIds((runs ?? []) as Array<{ action_results?: unknown }>)
  }

  // 4. Proposals holding a LIVE (pending, unexpired) card. Unexpired is filtered
  //    in code so a null expires_at (never-expires) counts as live.
  const nowIso = new Date(now).toISOString()
  const { data: cards } = await supabase
    .from('attention_item')
    .select('proposal_id, expires_at')
    .eq('status', 'pending')
    .in('workspace_id', workspaceIds)
    .not('proposal_id', 'is', null)
  const liveCardProposalIds = new Set<string>()
  for (const c of (cards ?? []) as Array<{ proposal_id: string | null; expires_at: string | null }>) {
    if (c.proposal_id && (!c.expires_at || c.expires_at > nowIso)) liveCardProposalIds.add(c.proposal_id)
  }

  // 5. The captures still holding an un-triaged proposal — the only ones the
  //    remaining checks need rows for.
  const candidates = collectCandidateCaptureIds({ pendingProposals, decidedProposalIds, liveCardProposalIds })
  if (candidates.length === 0) {
    return NextResponse.json({ ok: true, workspaces: workspaceIds.length, eligible: 0, fired: 0 })
  }
  const candidateIds = candidates.map((c) => c.capture_id)

  // 5a. Readiness: eval, private, still recording, or ended under 15 min ago →
  //     not yet (or never) — see captureReadiness.
  const captureRows = new Map<string, ReconcileCaptureRow>()
  for (const ids of chunk(candidateIds, IN_CHUNK)) {
    const { data } = await supabase
      .from('captures')
      .select('id, visibility, ended_at, batch_processed_at, is_eval, metadata')
      .in('id', ids)
    for (const row of (data ?? []) as ReconcileCaptureRow[]) captureRows.set(row.id, row)
  }
  const unreadyCaptureIds = new Set<string>()
  for (const id of candidateIds) {
    if (captureReadiness(captureRows.get(id), now) !== 'ready') unreadyCaptureIds.add(id)
  }

  // 5b. The lifetime cap: every reconcile this capture ever had (no window).
  const priorJobs: Array<{ source: { capture_id?: unknown } | null }> = []
  for (const ids of chunk(candidateIds, IN_CHUNK)) {
    const { data } = await supabase
      .from('tracked_job')
      .select('source')
      .eq('kind', 'triage_reconcile')
      .in('workspace_id', workspaceIds)
      .in('source->>capture_id', ids)
    priorJobs.push(...((data ?? []) as Array<{ source: { capture_id?: unknown } | null }>))
  }
  const exhausted = exhaustedCaptureIds(priorJobs)

  // 5c. The usage gate, BEFORE enqueueing: a workspace whose loop would fail
  //     `subscription_required` (or any plan limit) downstream gets no fire, so
  //     no failed run and no `work_failed` notice. Only workspaces that still
  //     hold a fireable capture are checked; one allowed run-as identity is
  //     enough (that loop runs).
  const gatedWorkspaces = new Set(
    candidates
      .filter((c) => !unreadyCaptureIds.has(c.capture_id) && !exhausted.has(c.capture_id))
      .map((c) => c.workspace_id),
  )
  const blockedWorkspaceIds = new Set<string>()
  for (const wsId of gatedWorkspaces) {
    if (!(await workspaceLoopAllowed(supabase, wsId, wsRunAsAll.get(wsId) ?? new Set([null])))) {
      blockedWorkspaceIds.add(wsId)
    }
  }

  // 6. Decide, capped.
  const eligible = selectEligibleCaptures({
    pendingProposals,
    decidedProposalIds,
    liveCardProposalIds,
    exhaustedCaptureIds: exhausted,
    unreadyCaptureIds,
    blockedWorkspaceIds,
    cap: RECONCILE_CAP,
  })

  // 7. Fire each: create the tracked_job (the cap's ledger) FIRST so the attempt
  //    counts even if the emit is retried, THEN dispatch.
  let fired = 0
  for (const cap of eligible) {
    const memberId = await resolveMemberId(supabase, cap.workspace_id, wsRunAs.get(cap.workspace_id) ?? null)
    if (!memberId) continue

    const job = await startWork(supabase, {
      workspaceId: cap.workspace_id,
      memberId,
      // The Captures face is who ran it (row 4; the Reconciler until migration 318); null is fine.
      aiTeamMemberId: await systemTeammateId(supabase, cap.workspace_id, 'captures'),
      kind: WORK_KINDS.triageReconcile,
      title: 'Reconcile triage for capture',
      actor: 'loop',
      status: 'running',
      source: { capture_id: cap.capture_id },
    })
    // The row IS the cap's count — without it the fire would be uncounted.
    if (job.inert) continue

    try {
      // Same send shape as emit-capture-processed.ts, plus reconciled:true so the
      // dispatch is distinguishable from a fresh batch-extraction emit (the
      // dispatcher ignores extra fields).
      await inngest.send({
        name: 'flow/capture.processed',
        data: {
          workspace_id: cap.workspace_id,
          capture_id: cap.capture_id,
          processed_at: new Date().toISOString(),
          reconciled: true,
        },
      })
      await job.finish({ summary: 'reconcile dispatched' })
      fired += 1
    } catch (err) {
      console.error('[triage-reconciler] emit failed:', err instanceof Error ? err.message : err)
      // The attempt still counts toward the cap (the job row exists); mark it
      // failed so the miss is visible in Activity rather than silent.
      await job.fail('dispatch failed')
    }
  }

  return NextResponse.json({
    ok: true,
    workspaces: workspaceIds.length,
    eligible: eligible.length,
    fired,
  })
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * Would at least one of this workspace's capture_processed loops pass the AI
 * usage gate (run-skill's check_ai_usage_limit, via isUsageAllowed)? A null
 * run-as identity is the workspace owner, as run-skill resolves it. A workspace
 * with no resolvable identity at all is blocked: run-skill fails it too.
 */
async function workspaceLoopAllowed(
  supabase: ReturnType<typeof getServiceClient>,
  workspaceId: string,
  runAs: ReadonlySet<string | null>,
): Promise<boolean> {
  const userIds = new Set<string>()
  for (const u of runAs) {
    if (u) {
      userIds.add(u)
      continue
    }
    const { data: owner } = await supabase
      .from('member')
      .select('user_id')
      .eq('workspace_id', workspaceId)
      .eq('role', 'owner')
      .limit(1)
      .maybeSingle()
    if (owner?.user_id) userIds.add(owner.user_id as string)
  }
  for (const userId of userIds) {
    if (await isUsageAllowed(supabase, userId)) return true
  }
  return false
}

/**
 * The tracked_job owner (member). Prefer the loop's run-as user (the flow
 * creator); fall back to the workspace owner — mirrors run-skill's run-as
 * resolution so the reconcile job is owned by whoever the loop runs as.
 */
async function resolveMemberId(
  supabase: ReturnType<typeof getServiceClient>,
  workspaceId: string,
  preferredUserId: string | null,
): Promise<string | null> {
  if (preferredUserId) {
    const { data } = await supabase
      .from('member')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('user_id', preferredUserId)
      .limit(1)
      .maybeSingle()
    if (data?.id) return data.id as string
  }
  const { data: owner } = await supabase
    .from('member')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('role', 'owner')
    .limit(1)
    .maybeSingle()
  return (owner?.id as string | undefined) ?? null
}
