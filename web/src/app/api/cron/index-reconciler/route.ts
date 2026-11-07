import { NextResponse, type NextRequest } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { requireCronSecret } from '@/lib/api-auth'
import { MIN_SUMMARY_CHARS } from '@/lib/inngest/capture-ingest'
import { indexCaptureFinished } from '@/lib/ai/index-capture-finished'
import { fetchAllRows, inChunks } from '@/lib/supabase/paging'

export const maxDuration = 60

// Only look back this far. A 7-day window used to be the bet ("a straggler is
// always recent"), but PROD proved otherwise: a capture whose heal kept failing
// simply aged out of the window and became permanently unreachable. 30 days
// keeps the scan cheap (captures/week number well under 100, so ~400 rows worst
// case) while giving a repeatedly-failing heal a month of ticks to recover.
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000
// Grace period: a capture created/ended within the last 2h may still be
// mid-flight (summary write, first index-content, batch extraction). Healing it
// now would double-fire needlessly, so we wait for processing to settle.
const GRACE_MS = 2 * 60 * 60 * 1000
// A straggler older than this has survived a full day of hourly runs without
// healing — something is wrong beyond the race. Warn loudly (no state persisted;
// the age is the signal).
const STALE_STRAGGLER_MS = 26 * 60 * 60 * 1000
// Cap per run: oldest first, so the backlog drains over ticks without a single
// run doing an unbounded amount of embedding work. 10 was below the real
// concurrent-straggler count on PROD (11 in one workspace), which starved the
// tail every run — 25 clears a realistic backlog in one tick.
const BATCH_CAP = 25

interface CandidateRow {
  id: string
  user_id: string | null
  workspace_id: string | null
  project_id: string | null
  title: string | null
  ai_summary: string | null
  content: string | null
  metadata: unknown
  is_eval: boolean | null
  created_at: string
  ended_at: string | null
}

/**
 * GET /api/cron/index-reconciler — hourly self-heal for captures that missed
 * knowledge indexing due to the summary-timing race.
 *
 * The race: POST /api/ai/index-content is the universal capture-finished seam.
 * It indexes capture_chunks and fires claim/extract-from-source, but only when
 * the body (ai_summary/content) clears MIN_SUMMARY_CHARS. When AI summarization
 * completes AFTER index-content already ran (a slow/retried summary), the
 * capture ends up with a real ai_summary but 0 capture_chunks and 0 claims —
 * invisible to vector search forever. The only pre-existing self-heal was a
 * manual capture edit (the PATCH re-index hook). Confirmed on PROD 2026-07-20:
 * capture 9ab14fd0 ("APIM — mapping file configuration") got 0 chunks / 0 claims
 * while same-day siblings got 20-30 chunks and 30+ claims.
 *
 * This cron finds those stragglers and re-runs the exact index-content logic
 * (via the shared indexCaptureFinished helper): extraction send BEFORE indexing,
 * same guards, same row-resolved project_id/workspace_id. Both operations are
 * safe to re-run — indexCapture does a full delete-then-reinsert of
 * capture_chunks, and claim-extraction's 0.92 vector dedup collapses a repeat
 * into provenance growth.
 *
 * The two gaps (missing chunks, missing claims) are detected INDEPENDENTLY:
 * they can diverge (the send succeeded but indexing failed, or vice versa) and
 * both need healing. Re-running the full helper heals either.
 *
 * Vercel cron issues GET with `Authorization: Bearer ${CRON_SECRET}`. POST is
 * aliased below so manual curl-triggering works.
 */
export async function GET(request: NextRequest) {
  // Fails CLOSED on an unset secret (see requireCronSecret).
  const denied = requireCronSecret(request)
  if (denied) return denied

  const supabase = getServiceClient()
  const now = Date.now()
  const lookbackIso = new Date(now - LOOKBACK_MS).toISOString()
  const graceIso = new Date(now - GRACE_MS).toISOString()

  // 1. Candidate captures: recent, past the grace window, real summary, not
  //    demo. PostgREST can't express `length(ai_summary)` in a filter, so we
  //    gate on ai_summary presence here and enforce the MIN_SUMMARY_CHARS floor
  //    in code below. Demos are excluded with an explicit `is.null OR neq.true`:
  //    a bare `not.eq.true` is NULL (so excluded) when the key is absent, which
  //    is every real capture.
  //    ended_at more-than-2h-ago is enforced in code (a null ended_at falls back
  //    to created_at, which is already <= graceIso).
  //    Paged (oldest first, id as the tiebreak): this scan is platform-wide
  //    and a single response stops at 1000 rows, which left the newest
  //    captures never examined. A failed read aborts the pass.
  const { data: candidateRows, error: candidatesError } = await fetchAllRows(
    () =>
      supabase
        .from('captures')
        // title is part of the indexed summary chunk — without it the cron's heal
        // would index a title-less body the route path would have included.
        .select('id, user_id, workspace_id, project_id, title, ai_summary, content, metadata, is_eval, created_at, ended_at')
        .gte('created_at', lookbackIso)
        .lte('created_at', graceIso)
        .not('ai_summary', 'is', null)
        .or('metadata->>demo.is.null,metadata->>demo.neq.true')
        .order('created_at', { ascending: true })
        .order('id', { ascending: true }),
    { orderBy: null },
  )
  if (candidatesError) {
    console.error('[index-reconciler] candidate read failed:', candidatesError.message)
    return NextResponse.json({ ok: false, error: candidatesError.message }, { status: 500 })
  }

  const candidates = (candidateRows as CandidateRow[]).filter((c) => {
    // MIN_SUMMARY_CHARS floor (can't be a PostgREST filter). Trim to match the
    // helper's body-length gate.
    if ((c.ai_summary ?? '').trim().length < MIN_SUMMARY_CHARS) return false
    // "ended/created more than 2 hours ago" — when ended_at is present it must
    // also be past the grace window (a capture can be created early but end
    // recently). created_at is already <= graceIso from the query.
    if (c.ended_at) {
      const endedMs = Date.parse(c.ended_at)
      if (Number.isFinite(endedMs) && endedMs > now - GRACE_MS) return false
    }
    return true
  })

  if (candidates.length === 0) {
    return NextResponse.json({ ok: true, candidates: 0, stragglers: 0, healed: 0 })
  }

  const candidateIds = candidates.map((c) => c.id)

  // 2. Batch-detect the two gaps INDEPENDENTLY (one query each, not per-capture).
  //    A capture with zero capture_chunks OR zero capture-citing claim_source
  //    rows is a straggler; either gap alone qualifies.
  //    Chunked (the id list overflows one URL past a few hundred captures) and
  //    paged (each capture has many chunks). A failed read aborts the pass: as
  //    "no rows" it made every candidate a straggler and re-indexed them.
  const [chunkRes, claimRes] = await Promise.all([
    inChunks(candidateIds, 100, (chunkIds) =>
      fetchAllRows(() =>
        supabase
          .from('capture_chunks')
          .select('id, capture_id')
          .in('capture_id', chunkIds),
      ),
    ),
    inChunks(candidateIds, 100, (chunkIds) =>
      fetchAllRows(() =>
        supabase
          .from('claim_source')
          .select('id, source_id')
          .eq('source_type', 'capture')
          .in('source_id', chunkIds),
      ),
    ),
  ])
  const gapReadError = chunkRes.error ?? claimRes.error
  if (gapReadError) {
    console.error('[index-reconciler] gap detection read failed:', gapReadError.message)
    return NextResponse.json({ ok: false, error: gapReadError.message }, { status: 500 })
  }
  const captureIdsWithChunks = new Set(
    (chunkRes.data as Array<{ capture_id: string }>).map((r) => r.capture_id),
  )

  const captureIdsWithClaims = new Set(
    (claimRes.data as Array<{ source_id: string | null }>)
      .map((r) => r.source_id)
      .filter((v): v is string => !!v),
  )

  const stragglers = candidates.filter(
    (c) => !captureIdsWithChunks.has(c.id) || !captureIdsWithClaims.has(c.id),
  )

  // 3. Warn loudly for any straggler that survived a full day of hourly runs
  //    (created > ~26h ago). Nothing is persisted — age IS the signal — so this
  //    fires every run until the capture heals. A stable grep-able prefix keeps
  //    repeated misses visible in Vercel logs.
  const staleThresholdMs = now - STALE_STRAGGLER_MS
  for (const c of stragglers) {
    const createdMs = Date.parse(c.created_at)
    if (Number.isFinite(createdMs) && createdMs < staleThresholdMs) {
      console.warn(
        `[index-reconciler] capture ${c.id} STILL UNHEALED after >26h ` +
          `(created ${c.created_at}, chunks=${captureIdsWithChunks.has(c.id)}, ` +
          `claims=${captureIdsWithClaims.has(c.id)}) — heal is failing repeatedly`,
      )
    }
  }

  // 4. Heal, oldest first, capped. Re-running the full helper heals whichever
  //    gap exists (both operations are idempotent-ish and safe to repeat).
  const batch = stragglers.slice(0, BATCH_CAP)
  let healed = 0
  const failures: Array<{ captureId: string; error: string }> = []

  for (const c of batch) {
    // Attribute to the capture OWNER (captures.user_id), matching
    // capture-ingest.ts — the acting user for the extraction event's usage
    // guard + embedding-spend attribution. A null owner is pathological; skip
    // rather than run an unattributed job.
    if (!c.user_id) {
      failures.push({ captureId: c.id, error: 'no capture owner (user_id null)' })
      continue
    }
    try {
      await indexCaptureFinished({
        supabase,
        captureId: c.id,
        captureRow: {
          workspace_id: c.workspace_id,
          project_id: c.project_id,
          title: c.title,
          ai_summary: c.ai_summary,
          content: c.content,
          metadata: c.metadata,
          is_eval: c.is_eval,
        },
        userId: c.user_id,
        workspaceId: c.workspace_id,
      })
      healed += 1
    } catch (err) {
      failures.push({
        captureId: c.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const summary = {
    ok: true,
    candidates: candidates.length,
    stragglers: stragglers.length,
    healed,
    failures: failures.length,
  }
  if (failures.length > 0) {
    console.warn('[index-reconciler] per-capture failures:', JSON.stringify(failures))
  }
  console.log(
    `[index-reconciler] candidates=${summary.candidates} stragglers=${summary.stragglers} ` +
      `healed=${summary.healed} failures=${summary.failures}`,
  )

  return NextResponse.json(summary)
}

// Allow manual curl-triggering via POST too (same handler, same bearer check).
export const POST = GET
