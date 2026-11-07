import { NextResponse, type NextRequest } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { requireCronSecret } from '@/lib/api-auth'
import { inngest } from '@/lib/inngest/client'
import {
  DISPATCH_LEASE_MS,
  INFLIGHT_STALE_MS,
  MAX_DISPATCH_ATTEMPTS,
  shouldExitAsReplied,
} from '@/lib/sequences/engine-logic'
import { notifySequenceIssue } from '@/lib/sequences/notify'
import { syncSequenceEnrolmentLedger } from '@/lib/work/sequence-enrolment-mirror'
import type { SequenceStepDueEvent } from '@/lib/sequences/types'
import { chunk, inChunks } from '@/lib/supabase/paging'

// Scan bound per pass — the whole engine is sized for tens of enrollments, so
// these are ceilings, not throughput targets.
const EXIT_SCAN_LIMIT = 500
const DUE_CLAIM_LIMIT = 50

export const maxDuration = 300

/**
 * GET /api/cron/sequence-dispatch — the Sequences engine's clock (every 5
 * minutes, vercel.json). Vercel cron is the ONLY tick (deliberately NOT an
 * Inngest cron — registration has silently failed before; see
 * /api/cron/flow-schedule's header). Three passes:
 *
 *   EXIT-EVAL — arithmetic reply detection. Active enrollments whose synced
 *   email_thread_index shows MORE messages than expected_message_count exit
 *   'replied' (any foreign thread activity — reply, human takeover, bounce —
 *   stops the drip; see 227's header).
 *
 *   REAPER — 'claimed'/'sending' ledger rows stuck > 15 min are zombies from a
 *   crashed send: mark failed, exit their enrollments 'failed' (at-most-once
 *   bias — the provider may have delivered before the crash, so never resend).
 *   Enrollments whose dispatch_attempts exceeded the cap likewise exit
 *   'failed'. ONE grouped notification per affected sequence.
 *
 *   DUE-CLAIM — LEASE-FORWARD claim of due enrollments: push next_send_at 10
 *   minutes ahead + bump dispatch_attempts, CAS-guarded on the exact
 *   next_send_at value read (never claim-by-NULL, which strands rows when the
 *   claimer crashes before emitting), then emit `sequence/step.due`. A lost
 *   emit self-heals: the lease lapses in 10 min and the row is re-claimed; the
 *   attempts counter + reaper bound the retries.
 *
 *   LEDGER — projects every enrolment written in the last half hour (and
 *   every ledger row whose deadline is near) onto its Activity row, one per
 *   enrolment (src/lib/work/sequence-enrolment-mirror.ts). Runs last, so this
 *   tick's own exits land in the same tick.
 *
 * Vercel cron issues GET with `Authorization: Bearer ${CRON_SECRET}`.
 */
export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const supabase = getServiceClient()
  const now = new Date()

  const exits = await runExitEvalPass(supabase, now)
  const reaped = await runReaperPass(supabase, now)
  const dispatch = await runDueClaimPass(supabase, now)
  const ledger = await syncSequenceEnrolmentLedger(supabase, new Date())

  return NextResponse.json({ ok: true, exits, reaped, dispatch, ledger })
}

type ServiceClient = ReturnType<typeof getServiceClient>

// ──────────────────────────────────────────────────────────────────
// Pass 1: exit evaluation — thread grew beyond what the engine sent.
// ──────────────────────────────────────────────────────────────────

async function runExitEvalPass(
  supabase: ServiceClient,
  now: Date,
): Promise<{ scanned: number; exited: number; errored: number }> {
  void now
  const { data: enrollments, error } = await supabase
    .from('sequence_enrollment')
    .select('id, workspace_id, provider_thread_id, expected_message_count')
    .eq('status', 'active')
    .not('provider_thread_id', 'is', null)
    .limit(EXIT_SCAN_LIMIT)

  if (error) {
    console.error('[sequence-dispatch] exit-eval scan failed:', error.message)
    return { scanned: 0, exited: 0, errored: 1 }
  }

  const rows = enrollments ?? []
  if (rows.length === 0) return { scanned: 0, exited: 0, errored: 0 }

  // One read for all threads, matched back by (workspace_id, provider_thread_id).
  // email_thread_index is per (workspace, user, thread) — several members can
  // hold the same thread — so keep the MAX message_count per pair: any synced
  // copy showing foreign activity is proof enough.
  // Chunked: up to EXIT_SCAN_LIMIT thread ids (Outlook ids run ~150 chars)
  // overflow one URL, which failed the whole lookup every tick. A failed chunk
  // is counted; its threads just aren't evaluated this tick (no row = no exit).
  const threadIds = [...new Set(rows.map((r) => r.provider_thread_id as string))]
  let errored = 0
  const threads: Array<{ workspace_id: unknown; provider_thread_id: unknown; message_count: unknown }> = []
  const lookups = await Promise.all(
    chunk(threadIds, 50).map((chunkIds) =>
      supabase
        .from('email_thread_index')
        .select('workspace_id, provider_thread_id, message_count')
        .in('provider_thread_id', chunkIds),
    ),
  )
  for (const { data, error: threadError } of lookups) {
    if (threadError) {
      console.error('[sequence-dispatch] exit-eval thread lookup failed:', threadError.message)
      errored++
      continue
    }
    threads.push(...(data ?? []))
  }

  const maxCount = new Map<string, number>()
  for (const t of threads) {
    const key = `${t.workspace_id}:${t.provider_thread_id}`
    const count = (t.message_count as number | null) ?? 0
    if (count > (maxCount.get(key) ?? -1)) maxCount.set(key, count)
  }

  const exitIds = rows
    .filter((r) => {
      const key = `${r.workspace_id}:${r.provider_thread_id}`
      const threadRow = maxCount.has(key) ? { message_count: maxCount.get(key)! } : null
      return shouldExitAsReplied(
        {
          provider_thread_id: r.provider_thread_id as string,
          expected_message_count: (r.expected_message_count as number) ?? 0,
        },
        threadRow,
      )
    })
    .map((r) => r.id as string)

  if (exitIds.length === 0) return { scanned: rows.length, exited: 0, errored }

  const { data: exited, error: exitError } = await inChunks(exitIds, 100, (chunkIds) =>
    supabase
      .from('sequence_enrollment')
      .update({ status: 'exited', exit_reason: 'replied', next_send_at: null })
      .in('id', chunkIds)
      .eq('status', 'active')
      .select('id'),
  )

  if (exitError) {
    console.error('[sequence-dispatch] exit-eval update failed:', exitError.message)
    return { scanned: rows.length, exited: exited.length, errored: errored + 1 }
  }
  return { scanned: rows.length, exited: exited.length, errored }
}

// ──────────────────────────────────────────────────────────────────
// Pass 2: reaper — zombie in-flight sends + exhausted dispatchers.
// ──────────────────────────────────────────────────────────────────

async function runReaperPass(
  supabase: ServiceClient,
  now: Date,
): Promise<{ zombieSends: number; failedEnrollments: number; notified: number; errored: number }> {
  let errored = 0
  const staleCutoff = new Date(now.getTime() - INFLIGHT_STALE_MS).toISOString()

  // Zombie ledger rows: claimed/sending with no progress for > 15 min means the
  // send function died mid-flight. At-most-once bias: fail, never resend.
  const { data: zombies, error: zombieError } = await supabase
    .from('sequence_send')
    .update({
      status: 'failed',
      error: 'send did not complete — reaped after 15 minutes in flight',
    })
    .in('status', ['claimed', 'sending'])
    .lt('updated_at', staleCutoff)
    .select('id, enrollment_id')

  if (zombieError) {
    console.error('[sequence-dispatch] reaper zombie sweep failed:', zombieError.message)
    errored += 1
  }

  const affected = new Map<string, { id: string; sequence_id: string; workspace_id: string }>()

  const zombieEnrollmentIds = [...new Set((zombies ?? []).map((z) => z.enrollment_id as string))]
  if (zombieEnrollmentIds.length > 0) {
    const { data: exited, error } = await supabase
      .from('sequence_enrollment')
      .update({ status: 'exited', exit_reason: 'failed', next_send_at: null })
      .in('id', zombieEnrollmentIds)
      .eq('status', 'active')
      .select('id, sequence_id, workspace_id')
    if (error) {
      console.error('[sequence-dispatch] reaper zombie-enrollment exit failed:', error.message)
      errored += 1
    }
    for (const row of exited ?? []) {
      affected.set(row.id as string, row as { id: string; sequence_id: string; workspace_id: string })
    }
  }

  // Exhausted dispatchers: the lease-forward claim bumps dispatch_attempts on
  // every claim; a row that has been claimed more than MAX times without a
  // finalize resetting the counter is stuck.
  const { data: exhausted, error: exhaustedError } = await supabase
    .from('sequence_enrollment')
    .update({ status: 'exited', exit_reason: 'failed', next_send_at: null })
    .eq('status', 'active')
    .gt('dispatch_attempts', MAX_DISPATCH_ATTEMPTS)
    .select('id, sequence_id, workspace_id')

  if (exhaustedError) {
    console.error('[sequence-dispatch] reaper attempts sweep failed:', exhaustedError.message)
    errored += 1
  }
  for (const row of exhausted ?? []) {
    affected.set(row.id as string, row as { id: string; sequence_id: string; workspace_id: string })
  }

  // ONE grouped notification per affected sequence (notifySequenceIssue also
  // dedupes on a 24h window, so overlapping ticks don't stack).
  const bySequence = new Map<string, { workspace_id: string; count: number }>()
  for (const row of affected.values()) {
    const entry = bySequence.get(row.sequence_id) ?? { workspace_id: row.workspace_id, count: 0 }
    entry.count += 1
    bySequence.set(row.sequence_id, entry)
  }

  let notified = 0
  for (const [sequenceId, { workspace_id, count }] of bySequence) {
    const { data: sequence } = await supabase
      .from('sequence')
      .select('id, name, created_by')
      .eq('id', sequenceId)
      .maybeSingle()
    if (!sequence) continue
    await notifySequenceIssue(
      supabase,
      sequence as { id: string; name: string; created_by: string | null },
      workspace_id,
      'Sequence sends failed',
      `${count} enrollment${count === 1 ? '' : 's'} in "${(sequence as { name: string }).name}" exited after repeated send failures.`,
    )
    notified += 1
  }

  return {
    zombieSends: zombies?.length ?? 0,
    failedEnrollments: affected.size,
    notified,
    errored,
  }
}

// ──────────────────────────────────────────────────────────────────
// Pass 3: due-claim — lease-forward CAS, then emit the work event.
// ──────────────────────────────────────────────────────────────────

interface DueEnrollmentRow {
  id: string
  workspace_id: string
  next_send_at: string
  current_step_order: number
  dispatch_attempts: number
  sequence: {
    id: string
    status: string
    auto_send: boolean
    sending_account_id: string | null
  }
}

async function runDueClaimPass(
  supabase: ServiceClient,
  now: Date,
): Promise<{ due: number; claimed: number; lost: number; errored: number }> {
  const nowIso = now.toISOString()

  const { data: due, error } = await supabase
    .from('sequence_enrollment')
    .select(
      'id, workspace_id, next_send_at, current_step_order, dispatch_attempts, sequence:sequence_id!inner(id, status, auto_send, sending_account_id)',
    )
    .eq('status', 'active')
    // Belt-and-braces with the .lte below: a claim must NEVER match a NULL
    // next_send_at (staged-but-unlaunched enrollments are active with NULL).
    .not('next_send_at', 'is', null)
    .lte('next_send_at', nowIso)
    .eq('sequence.status', 'active')
    .eq('sequence.auto_send', true)
    .order('next_send_at', { ascending: true })
    .limit(DUE_CLAIM_LIMIT)

  if (error) {
    console.error('[sequence-dispatch] due-scan failed:', error.message)
    return { due: 0, claimed: 0, lost: 0, errored: 1 }
  }

  let claimedCount = 0
  let lost = 0
  let errored = 0

  for (const raw of (due ?? []) as unknown as DueEnrollmentRow[]) {
    try {
      const lease = new Date(now.getTime() + DISPATCH_LEASE_MS).toISOString()

      // LEASE-FORWARD CAS: push next_send_at ahead and count the attempt, but
      // only if the row still holds the exact value we read — overlapping
      // ticks can both see a due row; only one wins. A crash after this
      // write self-heals when the lease lapses.
      const { data: claimed, error: casError } = await supabase
        .from('sequence_enrollment')
        .update({
          next_send_at: lease,
          dispatch_attempts: raw.dispatch_attempts + 1,
        })
        .eq('id', raw.id)
        .eq('status', 'active')
        .eq('next_send_at', raw.next_send_at)
        .select('id')

      if (casError) {
        errored += 1
        console.error(`[sequence-dispatch] claim CAS failed for ${raw.id}:`, casError.message)
        continue
      }
      if (!claimed || claimed.length === 0) {
        lost += 1
        continue
      }

      const data: SequenceStepDueEvent = {
        enrollmentId: raw.id,
        stepOrder: raw.current_step_order,
        workspaceId: raw.workspace_id,
        accountId: raw.sequence.sending_account_id,
        concurrencyKey: raw.sequence.sending_account_id ?? raw.id,
      }
      await inngest.send({ name: 'sequence/step.due', data })
      claimedCount += 1
    } catch (err) {
      // A failed emit is NOT rolled back: the lease already moved next_send_at
      // 10 minutes out, so the row simply comes due again — bounded by the
      // attempts counter + reaper. One bad row must not stall the tick.
      errored += 1
      console.error(
        `[sequence-dispatch] dispatch failed for enrollment ${raw.id}:`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  return { due: due?.length ?? 0, claimed: claimedCount, lost, errored }
}
