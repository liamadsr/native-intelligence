import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireCronSecret } from '@/lib/api-auth'
import * as Sentry from '@sentry/nextjs'

/**
 * GET /api/cron/reconcile-deepgram
 *
 * Transcription usage is logged from a CLIENT-reported duration (P1-1): the
 * client streams audio directly to Deepgram with a short-lived key and then
 * POSTs the duration to /api/ai/log-transcription. A modified client could
 * under-report. We can't attribute Deepgram usage per-user (the temp keys
 * aren't user-tagged on Deepgram's side), but we CAN catch systematic
 * under-reporting at the project level: compare Deepgram's total billed
 * seconds for the day against the sum of what we logged, and alert on a gap.
 *
 * Schedule: daily via Vercel cron (after midnight UTC, reconciling the prior
 * full day).
 */
export const maxDuration = 60

const GAP_ALERT_RATIO = 0.1 // alert if logged is >10% below Deepgram's number

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const key = process.env.DEEPGRAM_API_KEY
  if (!key) {
    return NextResponse.json({ error: 'Deepgram key not configured' }, { status: 500 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )

  // Reconcile the prior full UTC day.
  const now = new Date()
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000)
  const startIso = start.toISOString()
  const endIso = end.toISOString()

  // Sum what we logged for the window. Paged: PostgREST caps one response at
  // 1000 rows, and a truncated sum reads as false under-reporting.
  const PAGE_SIZE = 1000
  let loggedSeconds = 0
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data: logged, error: loggedErr } = await supabase
      .from('ai_usage_logs')
      .select('audio_seconds')
      .eq('provider', 'deepgram')
      .gte('created_at', startIso)
      .lt('created_at', endIso)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (loggedErr) {
      console.error('[reconcile-deepgram] usage query failed:', loggedErr)
      return NextResponse.json({ error: 'Usage query failed' }, { status: 500 })
    }
    const rows = logged ?? []
    loggedSeconds += rows.reduce((s, r) => s + (Number(r.audio_seconds) || 0), 0)
    if (rows.length < PAGE_SIZE) break
  }

  // Ask Deepgram for the project's billed usage over the same window.
  let deepgramSeconds = 0
  try {
    const projectsRes = await fetch('https://api.deepgram.com/v1/projects', {
      headers: { Authorization: `Token ${key}` },
    })
    const projects = await projectsRes.json()
    const projectId = projects?.projects?.[0]?.project_id
    if (projectId) {
      const usageRes = await fetch(
        `https://api.deepgram.com/v1/projects/${projectId}/usage?start=${start.toISOString().slice(0, 10)}&end=${end.toISOString().slice(0, 10)}`,
        { headers: { Authorization: `Token ${key}` } },
      )
      const usage = await usageRes.json()
      // Deepgram reports usage.results[].total_hours (or resolution buckets).
      const hours = Number(usage?.results?.reduce?.(
        (s: number, r: { total_hours?: number }) => s + (Number(r.total_hours) || 0), 0) ?? 0)
      deepgramSeconds = hours * 3600
    }
  } catch (err) {
    console.error('[reconcile-deepgram] Deepgram usage fetch failed:', err)
    return NextResponse.json({ error: 'Deepgram fetch failed' }, { status: 502 })
  }

  const gap = deepgramSeconds - loggedSeconds
  const underReported = deepgramSeconds > 0 && gap / deepgramSeconds > GAP_ALERT_RATIO

  if (underReported) {
    Sentry.captureMessage(
      `[reconcile-deepgram] under-reporting: logged ${Math.round(loggedSeconds)}s vs Deepgram ${Math.round(deepgramSeconds)}s (${Math.round((gap / deepgramSeconds) * 100)}% gap) for ${startIso.slice(0, 10)}`,
      'warning',
    )
  }

  return NextResponse.json({
    success: true,
    window: { start: startIso, end: endIso },
    logged_seconds: Math.round(loggedSeconds),
    deepgram_seconds: Math.round(deepgramSeconds),
    under_reported: underReported,
  })
}
