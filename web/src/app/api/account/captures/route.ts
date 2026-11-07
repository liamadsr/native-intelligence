import { requireWorkspace } from '@/lib/api-auth'
import { seedSelfParticipant } from '@/lib/crm/contacts'
import { trackServerEvent } from '@/lib/posthog'
import { NextResponse, type NextRequest } from 'next/server'

// `user_id` travels with `visibility`: the capture scope control renders only
// for the creator, so a payload carrying visibility but not user_id leaves the
// control hidden on a freshly created capture (capture-visibility-control.tsx).
const CAPTURE_LIST_FIELDS = `
  id, user_id, title, summary, recorded_at, created_at, status, is_pinned, participants, duration_seconds,
  started_at, ended_at, ai_processed, auto_capture_status, scheduled_start, scheduled_end, visibility
`

/**
 * Capture visibility predicate: 'workspace' captures are visible to every
 * member; 'private' ones only to their creator. Defence-in-depth alongside the
 * RLS policy — this route uses a user-scoped client, but the predicate keeps
 * the intent explicit at every query site.
 */
function visibilityOr(userId: string) {
  return `visibility.eq.workspace,user_id.eq.${userId}`
}

// PostgREST caps a response at 1000 rows (silently) and `.in()` rides in the
// URL, so the per-capture count reads go in id chunks, each paged by .range()
// until a short page.
const PAGE_SIZE = 1000
const ID_CHUNK = 100

async function readInChunks<T>(
  ids: string[],
  read: (
    chunk: string[],
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<{ rows: T[]; error: string | null }> {
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += ID_CHUNK) chunks.push(ids.slice(i, i + ID_CHUNK))
  const results = await Promise.all(
    chunks.map(async (chunk) => {
      const rows: T[] = []
      for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await read(chunk, from, from + PAGE_SIZE - 1)
        if (error) return { rows, error: error.message }
        rows.push(...(data ?? []))
        if ((data ?? []).length < PAGE_SIZE) return { rows, error: null }
      }
    }),
  )
  const failed = results.find((r) => r.error)
  return { rows: results.flatMap((r) => r.rows), error: failed?.error ?? null }
}

export async function GET(request: NextRequest) {
  // Cookie session OR Bearer (desktop / device token), with workspace
  // resolution — matches the POST handler. Previously this was cookie-only,
  // which 401'd non-browser clients.
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  const { searchParams } = request.nextUrl
  const projectId = searchParams.get('project_id')
  const teamId = searchParams.get('team_id')
  // Optional page cap. Additive — callers that omit it get the full list as
  // before. The chat @-picker passes a small value: it used to pull EVERY
  // capture (490 on the main DEV workspace, ~2MB with summaries + participants)
  // just to show a handful of rows, which was the delay you felt on open.
  const limitParam = parseInt(searchParams.get('limit') || '', 10)
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 500) : null
  // Optional title search, so a capped caller can still find an older capture
  // by typing its name instead of only seeing the most recent page. Strip the
  // chars PostgREST parses in an .ilike pattern value (same hardening as the
  // contacts route's .or()).
  const searchRaw = searchParams.get('search') || ''
  const search = searchRaw.replace(/[,()"`\\%]/g, '').trim()

  let query = supabase
    .from('captures')
    .select(CAPTURE_LIST_FIELDS)
    .eq('workspace_id', workspaceId)
    .neq('status', 'archived')
    // Eval captures (`is_eval`, migration 252) are synthetic mock meetings the
    // Evals surface authors and replays. They are real `captures` rows so the
    // unmodified live-agent engine can run against them, which means this list
    // — the Captures page — would show them next to real meetings without an
    // explicit predicate. See docs/plans/evals.md §5.2.
    .neq('is_eval', true)
    .or('auto_capture_status.is.null,auto_capture_status.neq.skipped')

  // When scoped to a project, show all captures in that project (workspace-shared).
  // Otherwise restrict to the current user's own captures.
  if (projectId) {
    // Defence-in-depth: verify the project belongs to this workspace before
    // dropping the user_id guard. Without this, a malicious caller could
    // pass another workspace's project_id and (if RLS or workspace_id
    // filtering ever regresses) read captures across workspaces.
    const { data: proj } = await supabase
      .from('projects')
      .select('id')
      .eq('id', projectId)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    if (!proj) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    query = query.eq('project_id', projectId)
    // Dropping the user_id guard exposes every member's captures in the
    // project — private ones must still be creator-only.
    query = query.or(visibilityOr(user.id))
  } else {
    // Already creator-scoped, which implies visibility.
    query = query.eq('user_id', user.id)
  }

  if (teamId) {
    query = query.eq('team_id', teamId)
  }

  if (search) {
    query = query.ilike('title', `%${search}%`)
  }

  query = query
    .order('is_pinned', { ascending: false })
    .order('recorded_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })

  if (limit !== null) query = query.limit(limit)

  const { data, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const captures = (data || []).map((c) => {
    return {
      id: c.id,
      title: c.title,
      summary: c.summary,
      recorded_at: c.recorded_at,
      created_at: c.created_at,
      status: c.status,
      is_pinned: c.is_pinned,
      participants: c.participants,
      duration_seconds: c.duration_seconds,
      started_at: c.started_at,
      ended_at: c.ended_at,
      ai_processed: c.ai_processed || false,
    }
  })

  const captureIds = captures.map((c) => c.id)

  // Batch-fetch action counts (total + suggested) and comment counts
  const actionCounts: Record<string, { total: number; suggested: number }> = {}
  let commentCounts: Record<string, number> = {}
  if (captureIds.length > 0) {
    const [actionRead, commentRead] = await Promise.all([
      readInChunks<{ source_capture_id: string; confirmation: string | null }>(
        captureIds,
        (chunk, from, to) =>
          supabase
            .from('actions')
            .select('source_capture_id, confirmation')
            .in('source_capture_id', chunk)
            .order('id')
            .range(from, to),
      ),
      readInChunks<{ commentable_id: string }>(captureIds, (chunk, from, to) =>
        supabase
          .from('comment')
          .select('commentable_id')
          .eq('commentable_type', 'capture')
          .in('commentable_id', chunk)
          .order('id')
          .range(from, to),
      ),
    ])
    const readError = actionRead.error ?? commentRead.error
    if (readError) {
      return NextResponse.json({ error: readError }, { status: 500 })
    }
    for (const row of actionRead.rows) {
      const id = row.source_capture_id
      if (!actionCounts[id]) actionCounts[id] = { total: 0, suggested: 0 }
      actionCounts[id].total++
      if (row.confirmation === 'suggested') actionCounts[id].suggested++
    }
    commentCounts = commentRead.rows.reduce((acc: Record<string, number>, c) => {
      acc[c.commentable_id] = (acc[c.commentable_id] || 0) + 1
      return acc
    }, {})
  }

  const capturesWithCounts = captures.map((c) => ({
    ...c,
    comment_count: commentCounts[c.id] || 0,
    source_action_count: actionCounts[c.id]?.total || 0,
    suggested_action_count: actionCounts[c.id]?.suggested || 0,
  }))

  return NextResponse.json({ captures: capturesWithCounts })
}

export async function POST(request: NextRequest) {
  // Centralized auth: accepts a cookie session (browser) or an
  // `Authorization: Bearer <token>` header (desktop app, hardware devices).
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  const body = await request.json()
  const title = (body.title || 'Untitled Capture').trim()

  // Optimistic start: the client may mint the capture id (crypto.randomUUID) so
  // it can open the capture panel BEFORE this round trip resolves. Strictly a
  // UUID — anything else is a client bug, rejected rather than guessed around.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  let clientId: string | null = null
  if (body.id !== undefined) {
    if (typeof body.id !== 'string' || !UUID_RE.test(body.id)) {
      return NextResponse.json({ error: 'Invalid capture id' }, { status: 400 })
    }
    clientId = body.id
  }

  const now = new Date().toISOString()
  const insert: Record<string, unknown> = {
    user_id: user.id,
    workspace_id: workspaceId,
    title,
    status: 'active',
    recorded_at: now,
    // Default started_at to now so the capture always lands in a dated group in
    // the captures list (which groups by started_at). Without this, clients
    // that don't send started_at — e.g. the hardware device — produce captures
    // with a null started_at that sort into a "no date" group at the bottom.
    started_at: now,
  }

  if (clientId) insert.id = clientId
  if (body.project_id) insert.project_id = body.project_id
  if (body.team_id) insert.team_id = body.team_id
  if (body.started_at) insert.started_at = body.started_at
  // Live mode: ON = process every pause; OFF = batch at meeting end. Column
  // defaults to true (legacy live behavior) so only persist when explicitly
  // provided by the recorder.
  if (typeof body.live_mode === 'boolean') insert.live_mode = body.live_mode
  // Audio topology of the recorder. desktop_dual = mic + system audio on
  // separate channels (only this mode can ever earn a position self-binding —
  // see self-binding.ts); web_mic_only = every participant on one mic channel.
  if (body.capture_mode === 'desktop_dual' || body.capture_mode === 'web_mic_only') {
    insert.metadata = { capture_mode: body.capture_mode }
  }

  const { data, error } = await supabase
    .from('captures')
    .insert(insert)
    .select(CAPTURE_LIST_FIELDS)
    .single()

  if (error) {
    // Idempotent create for client-minted ids: a retried/double-fired POST of
    // the same id lands here as a unique violation. Return the existing row iff
    // it belongs to this user+workspace — a collision with anyone else's row is
    // a conflict, never a leak.
    if (clientId && error.code === '23505') {
      const { data: existing } = await supabase
        .from('captures')
        .select(CAPTURE_LIST_FIELDS)
        .eq('id', clientId)
        .eq('workspace_id', workspaceId)
        .eq('user_id', user.id)
        .single()
      if (existing) {
        return NextResponse.json({
          capture: {
            id: existing.id,
            user_id: existing.user_id,
            title: existing.title,
            summary: existing.summary,
            recorded_at: existing.recorded_at,
            created_at: existing.created_at,
            status: existing.status,
            is_pinned: existing.is_pinned,
            visibility: existing.visibility,
          },
        })
      }
      return NextResponse.json({ error: 'Capture id already in use' }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Identity anchor: seed the owner's self participant row (member +
  // self-contact, is_self=true, no speaker label yet). Best-effort — a capture
  // must never fail to create over this; extraction routes re-seed lazily.
  try {
    await seedSelfParticipant(workspaceId, data.id, user)
  } catch (err) {
    console.warn('[captures POST] seedSelfParticipant failed:', err)
  }

  trackServerEvent('capture_created', { userId: user.id, workspaceId, email: user.email }, {
    capture_id: data.id,
    has_project: Boolean(body.project_id),
    has_team: Boolean(body.team_id),
    live_mode: typeof body.live_mode === 'boolean' ? body.live_mode : null,
  })

  return NextResponse.json({
    capture: {
      id: data.id,
      user_id: data.user_id,
      title: data.title,
      summary: data.summary,
      recorded_at: data.recorded_at,
      created_at: data.created_at,
      status: data.status,
      is_pinned: data.is_pinned,
      visibility: data.visibility,
    },
  })
}
