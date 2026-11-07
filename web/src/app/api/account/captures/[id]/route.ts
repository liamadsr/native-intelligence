import { requireWorkspace } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import { loadPrecallBrief } from '@/lib/live-agent/precall-brief'
import { inngest } from '@/lib/inngest/client'
import {
  deriveSeriesIdentity,
  parseGoogleSeriesFromInstanceId,
} from '@/lib/integrations/meeting-series'
import { NextResponse, type NextRequest } from 'next/server'

// Fields whose change invalidates the capture's embeddings. Editing any of them
// (title, content, ai_summary) means the vectors in capture_chunks now point at
// stale text and would return the wrong capture for semantic queries. transcript
// is DELIBERATELY excluded: the live auto-save PATCHes it on every tick, and
// re-embedding on each keystroke would be ruinous — the transcript is indexed
// once at recording stop and does not need re-indexing on edit here.
//
// The re-index itself runs OUT of band: PATCH sends `capture/reindex.requested`
// and the capture-reindex Inngest function (per-capture 60s debounce) does the
// chunk + embed + reinsert. It used to run inline, awaited — 0.5–2s of OpenAI
// latency inside every debounced summary-save round trip.
const REINDEX_FIELDS = ['title', 'content', 'ai_summary'] as const

// Everything EXCEPT the heavy text fields — what list rows, the detail panel's
// poll, and metadata edits actually render. Kept as the base the full field set
// composes from so the two can never drift.
const CAPTURE_META_FIELDS = `
  id, user_id, title, summary, user_notes, audio_url, duration_seconds,
  source_url, calendar_event_id, meeting_url, location, organizer_email, participants,
  tags, metadata, ai_processed, ai_summary, status, is_pinned, recorded_at,
  started_at, ended_at, is_transcript_locked, project_id, team_id,
  live_mode, batch_processed_at, package_ids, created_at, updated_at, visibility,
  project:projects!project_id(id, name)
`

// The heavy text fields alone (plus id) — the lazy-load companion to `meta`.
// transcript can reach ~100KB on a long meeting; content and note_attributions
// scale with it.
const CAPTURE_TRANSCRIPT_FIELDS = 'id, transcript, content, note_attributions'

// The meeting's scheduled time alone (plus id): the live agent HUD's duration
// bar reads it once per call (lib/live-agent/hud-schedule.ts).
const CAPTURE_SCHEDULE_FIELDS = 'id, scheduled_start, scheduled_end'

// Full row: meta + the heavy text fields. The default (no `fields` param) for
// backcompat with every existing caller.
const CAPTURE_FIELDS = `${CAPTURE_META_FIELDS}, transcript, content, note_attributions`

/**
 * Capture visibility predicate: 'workspace' captures are visible to every
 * member; 'private' ones only to their creator. Defence-in-depth alongside RLS
 * — a non-creator asking for someone's private capture falls into the existing
 * not-found path rather than reading the row.
 */
function visibilityOr(userId: string) {
  return `visibility.eq.workspace,user_id.eq.${userId}`
}

/**
 * GET /api/account/captures/[id]
 *
 * `?fields=` selects the payload variant:
 *  - absent (default) → the FULL capture row + rollups (backcompat).
 *  - `meta`           → the full shape minus transcript, content and
 *                       note_attributions (the keys are absent, not null).
 *                       Rollups (counts, labels, source_actions, project_name)
 *                       are included — this is the panel/poll payload.
 *  - `transcript`     → ONLY { id, transcript, content, note_attributions }.
 *                       No rollups, no project_name — the lazy-load companion
 *                       to `meta`.
 *  - `schedule`       → ONLY { id, scheduled_start, scheduled_end }. No
 *                       rollups — the live agent HUD header's time fill.
 *  - `brief`          → ONLY { id, brief }: the SIGNED-IN person's pre-call
 *                       brief for the capture's meeting (their goal, their
 *                       prep's top; null when neither), for the HUD's
 *                       Briefing line (lib/live-agent/precall-brief.ts). The
 *                       capture must be visible to them first.
 * Any other value falls back to the full payload (forward-compatible default).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  const { id } = await params
  const fields = request.nextUrl.searchParams.get('fields')

  // The pre-call brief: the visibility-fenced capture first, then the brief
  // for the signed-in person alone (loadPrecallBrief fences on them and the
  // workspace). No rollups.
  if (fields === 'brief') {
    const { data: visible, error: visibleError } = await supabase
      .from('captures')
      .select('id')
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .or(visibilityOr(user.id))
      .maybeSingle()
    if (visibleError) return serverError(visibleError.message)
    if (!visible) return notFound('Capture not found')
    try {
      const brief = await loadPrecallBrief(supabase, { workspaceId, userId: user.id, captureId: id })
      return NextResponse.json({ capture: { id, brief } })
    } catch (err) {
      return serverError(err instanceof Error ? err.message : 'The brief could not be read')
    }
  }

  // Typed as plain string: the select list is decided at runtime, so the
  // client's template-literal query parser can't type the rows — the response
  // shaping below works on loosely-typed records (as this route always has).
  const selectFields: string =
    fields === 'transcript'
      ? CAPTURE_TRANSCRIPT_FIELDS
      : fields === 'schedule'
        ? CAPTURE_SCHEDULE_FIELDS
        : fields === 'meta'
          ? CAPTURE_META_FIELDS
          : CAPTURE_FIELDS

  const captureQuery = supabase
    .from('captures')
    .select(selectFields)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .or(visibilityOr(user.id))
    .maybeSingle()

  // Transcript and schedule variants: their own columns only. The rollup
  // queries below would be pure waste here — the transcript's caller already
  // has them from the meta fetch, and the HUD's bar never reads them.
  if (fields === 'transcript' || fields === 'schedule') {
    const { data, error } = await captureQuery
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    if (!data) {
      return NextResponse.json({ error: 'Capture not found' }, { status: 404 })
    }
    return NextResponse.json({ capture: data })
  }

  // ONE query wave: the capture row and every rollup fire in parallel instead
  // of the old capture → counts → actions → labels serial chain. The capture
  // result is evaluated FIRST so 404 semantics are identical — when the row is
  // missing/foreign/private the companions' results are simply discarded.
  //
  // DELIBERATE TRADEOFF: because the wave is unconditional, a 404 now runs all
  // seven queries where the serial version stopped after one. That is accepted
  // rather than fixed — gating the rollups on the capture row resolving first
  // would re-serialize the wave and hand back the round trip this phase exists
  // to remove, on every SUCCESSFUL fetch, to save DB work only on the miss
  // path. Nothing leaks: the six companions are keyed on capture_id alone but
  // their results are discarded before the 404 is written, and RLS scopes them
  // regardless (`actions` additionally carries the workspace filter).
  const [
    captureRes,
    { count: participantCount },
    { count: decisionCount },
    { count: suggestedDecisionCount },
    { count: commentCount },
    { data: actions },
    { data: captureLabelRows },
  ] = await Promise.all([
    captureQuery,
    supabase.from('capture_participant').select('id', { count: 'exact', head: true }).eq('capture_id', id),
    supabase.from('decision').select('id', { count: 'exact', head: true }).eq('capture_id', id),
    supabase.from('decision').select('id', { count: 'exact', head: true }).eq('capture_id', id).eq('confirmation', 'suggested'),
    supabase.from('comment').select('*', { count: 'exact', head: true }).eq('commentable_type', 'capture').eq('commentable_id', id),
    supabase
      .from('actions')
      .select('id, identifier, title, status_id, workflow_state:workflow_state!status_id(name, category, color)')
      .eq('source_capture_id', id)
      .eq('workspace_id', workspaceId)
      .limit(20),
    supabase.from('capture_label').select('label:label(id, name, color)').eq('capture_id', id),
  ])

  if (captureRes.error) {
    return NextResponse.json({ error: captureRes.error.message }, { status: 500 })
  }

  const data = captureRes.data as unknown as Record<string, unknown> | null

  // Missing, in another workspace, or someone else's private capture — all
  // indistinguishable to the caller by design.
  if (!data) {
    return NextResponse.json({ error: 'Capture not found' }, { status: 404 })
  }

  const labels = (captureLabelRows || [])
    .map((row) => row.label as unknown as { id: string; name: string; color: string } | null)
    .filter(Boolean)

  const projectData = data.project as unknown as { id: string; name: string } | null

  return NextResponse.json({
    capture: {
      ...data,
      project: undefined,
      project_name: projectData?.name || null,
      participant_count: participantCount || 0,
      decision_count: decisionCount || 0,
      suggested_decision_count: suggestedDecisionCount || 0,
      comment_count: commentCount || 0,
      labels,
      source_actions: (actions || []).map((a) => {
        const ws = a.workflow_state as unknown as { name: string; category: string; color: string } | null
        return {
          id: a.id,
          identifier: a.identifier,
          title: a.title,
          status_name: ws?.name || '',
          status_category: ws?.category || '',
          status_color: ws?.color || '',
        }
      }),
    },
  })
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  const { id } = await params
  const body = await request.json()

  const updates: Record<string, unknown> = {}
  // `visibility` is DELIBERATELY absent from this allowlist. This route is
  // workspace-scoped — teammates may edit each other's capture metadata — but
  // only the creator may change scope. Use PATCH /captures/[id]/visibility.
  if (body.title !== undefined) updates.title = body.title
  if (body.content !== undefined) updates.content = body.content
  // Transcript no-shrink guard. The live-recording auto-save (the ONLY caller
  // that ever PATCHes `transcript`) sends the WHOLE transcript string each tick,
  // rebuilt from the in-memory segments. If a save fires after those segments
  // were reset (remount/restart) while captureId still points at the live
  // capture, the rebuilt string is empty/short and a blind overwrite would
  // clobber a good, longer transcript — the exact mechanism behind the prod
  // captures that ended alive-for-minutes with an empty transcript.
  //
  // So by default we REFUSE to replace a non-empty transcript with one that is
  // empty or strictly shorter: we simply drop that field from the update (other
  // fields in the same PATCH still apply). The authoritative final save on stop
  // passes `force_transcript: true` to opt out — it may legitimately be shorter
  // (e.g. a very short session) and must always win.
  let transcriptGuardSkipped = false
  if (body.transcript !== undefined) {
    if (body.force_transcript === true) {
      updates.transcript = body.transcript
    } else {
      const incoming = typeof body.transcript === 'string' ? body.transcript : ''
      const { data: existingRow } = await supabase
        .from('captures')
        .select('transcript')
        .eq('id', id)
        .eq('workspace_id', workspaceId)
        .single()
      const existing = typeof existingRow?.transcript === 'string' ? existingRow.transcript : ''
      // Block only when the existing copy is non-empty AND the incoming one is
      // empty or strictly shorter. Equal-or-longer always proceeds.
      if (existing.trim().length > 0 && incoming.trim().length < existing.trim().length) {
        transcriptGuardSkipped = true
      } else {
        updates.transcript = body.transcript
      }
    }
  }
  if (body.user_notes !== undefined) updates.user_notes = body.user_notes
  if (body.ai_summary !== undefined) updates.ai_summary = body.ai_summary
  if (body.is_pinned !== undefined) updates.is_pinned = body.is_pinned
  if (body.tags !== undefined) updates.tags = body.tags
  if (body.status !== undefined) updates.status = body.status
  if (body.project_id !== undefined) updates.project_id = body.project_id || null
  if (body.team_id !== undefined) updates.team_id = body.team_id || null
  if (body.started_at !== undefined) updates.started_at = body.started_at
  if (body.ended_at !== undefined) updates.ended_at = body.ended_at
  if (body.ai_processed !== undefined) updates.ai_processed = body.ai_processed
  if (body.note_attributions !== undefined) updates.note_attributions = body.note_attributions
  if (body.auto_capture_status !== undefined) updates.auto_capture_status = body.auto_capture_status
  // Event linking through the generic PATCH (link-event is the primary path —
  // it also re-seeds participants and 409s on conflicts). Kept for API
  // compatibility, but it must stamp the series-thread identity like every
  // other event-link writer, or the capture never joins its meeting's history.
  if (body.calendar_event_id !== undefined) {
    updates.calendar_event_id = body.calendar_event_id
    if (body.calendar_event_id === null) {
      updates.series_key = null
      updates.ical_uid = null
      updates.occurrence_start = null
    } else {
      const identity = deriveSeriesIdentity({
        id: body.calendar_event_id,
        start: body.scheduled_start ?? null,
        hasRecurrence: undefined,
      })
      updates.series_key = parseGoogleSeriesFromInstanceId(body.calendar_event_id)
      updates.ical_uid = identity.icalUid
      updates.occurrence_start = identity.occurrenceStart
    }
  }
  if (body.calendar_provider !== undefined) updates.calendar_provider = body.calendar_provider
  if (body.scheduled_start !== undefined) updates.scheduled_start = body.scheduled_start
  if (body.scheduled_end !== undefined) updates.scheduled_end = body.scheduled_end
  if (body.is_transcript_locked !== undefined) updates.is_transcript_locked = body.is_transcript_locked
  // "+ Packages" chip — context packages attached to this capture (mig 239).
  // Each id must be a package the caller can SEE (mig 238 predicate, resolved
  // via auth.uid() on this user-JWT client); ids that fail — deleted, foreign,
  // or visibility-narrowed since the picker loaded — are dropped silently (the
  // chip only offers visible packages, so a miss is a race, not user error).
  // Injection re-checks against the capture owner anyway; this write-side
  // filter just keeps garbage out of the row.
  if (body.package_ids !== undefined) {
    const raw: unknown[] = Array.isArray(body.package_ids) ? body.package_ids : []
    const candidates = [...new Set(raw.filter((v): v is string => typeof v === 'string' && !!v))].slice(0, 5)
    const checks = await Promise.all(
      candidates.map(async (pid) => {
        const { data } = await supabase.rpc('package_visible_to', { p_package_id: pid })
        return data === true
      }),
    )
    updates.package_ids = candidates.filter((_, i) => checks[i])
  }
  // duration_seconds derive-and-clamp. The client sends its in-memory `elapsed`
  // counter, which RESETS to 0 on every fresh recording session — so after a
  // crash/reload that spins up a short post-restart session, a 48-minute capture
  // can land an absurd `duration_seconds` (observed: 3) even though the real
  // span is ended_at − started_at. We never trust the raw client value blindly:
  // when we can compute a wall-clock span from the timestamps (body value wins,
  // else the stored row), we use the LARGER of (derived span, clamped client
  // value). Falls back to the clamped (non-negative) client value when no
  // timestamps are available.
  if (body.duration_seconds !== undefined) {
    const clientVal = Number(body.duration_seconds)
    const safeClient = Number.isFinite(clientVal) && clientVal > 0 ? Math.floor(clientVal) : 0

    // Resolve effective started_at / ended_at: prefer this PATCH's body, then
    // the stored row. Only hit the DB when a timestamp is missing from the body.
    let startedAt: string | null = typeof body.started_at === 'string' ? body.started_at : null
    let endedAt: string | null = typeof body.ended_at === 'string' ? body.ended_at : null
    if (!startedAt || !endedAt) {
      const { data: tsRow } = await supabase
        .from('captures')
        .select('started_at, ended_at')
        .eq('id', id)
        .eq('workspace_id', workspaceId)
        .single()
      startedAt = startedAt ?? (typeof tsRow?.started_at === 'string' ? tsRow.started_at : null)
      endedAt = endedAt ?? (typeof tsRow?.ended_at === 'string' ? tsRow.ended_at : null)
    }

    let derived: number | null = null
    if (startedAt && endedAt) {
      const startMs = Date.parse(startedAt)
      const endMs = Date.parse(endedAt)
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
        derived = Math.floor((endMs - startMs) / 1000)
      }
    }

    updates.duration_seconds = derived !== null ? Math.max(derived, safeClient) : safeClient
  }
  if (typeof body.live_mode === 'boolean') updates.live_mode = body.live_mode

  // NOTE: Processing is handled in real-time by the live agent during
  // recording. No post-capture processing is triggered here.

  // If the no-shrink guard dropped the only field in this PATCH, there's nothing
  // to write. Return the slim no-op shape and flag the skip so the client knows
  // the shorter transcript was intentionally rejected, not persisted.
  if (Object.keys(updates).length === 0) {
    const { data, error } = await supabase
      .from('captures')
      .select('id, updated_at')
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .single()
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({
      capture: { id: data.id, updated_at: data.updated_at },
      transcript_guard_skipped: transcriptGuardSkipped,
    })
  }

  // Workspace-scoped: teammates can update metadata (project, status, tags, etc.)
  // on each other's captures. DELETE remains owner-only.
  //
  // The response is SLIM by design: id + updated_at + only the fields this
  // PATCH wrote. The old full-CAPTURE_FIELDS echo shipped the whole transcript
  // (~100KB late in a meeting) back on every 500ms-debounced summary save.
  // Consumers merge partially (mergeCaptureResponse spreads over prev state) or
  // ignore the body entirely, so absent keys are simply left untouched.
  const updatedKeys = Object.keys(updates)
  const { data, error } = await supabase
    .from('captures')
    .update(updates)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .select(['id', 'updated_at', ...updatedKeys].join(', '))
    .single()

  if (error) {
    // One live capture per user per event (mig 226): an event-link or un-end
    // write that collides is a conflict, not a server error — and the raw PG
    // duplicate-key text must not surface as a 500.
    if (error.code === '23505') {
      return NextResponse.json(
        { error: 'Another capture already links this event' },
        { status: 409 },
      )
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Re-index embeddings when the edit changed title/content/ai_summary. Without
  // this, a post-stop summary/title correction leaves capture_chunks pointing at
  // the old text forever. The work happens in the capture-reindex Inngest
  // function (debounced ~60s per capture, reading the row's FULL current values
  // at run time) — the PATCH response must not wait on chunking + OpenAI
  // embedding. transcript changes never reach here (excluded from
  // REINDEX_FIELDS). Best-effort both ways: a failed event send must never fail
  // the PATCH, mirroring the old inline reindex's swallow-all contract.
  const changedReindexField = REINDEX_FIELDS.some((f) => f in updates)
  if (changedReindexField) {
    try {
      await inngest.send({
        name: 'capture/reindex.requested',
        data: { captureId: id, workspaceId, userId: user.id },
      })
    } catch (err) {
      console.error('[captures.patch] reindex event send failed (non-fatal):', err)
    }
  }

  const row = data as unknown as Record<string, unknown>
  const capture: Record<string, unknown> = { id: row.id, updated_at: row.updated_at }
  for (const key of updatedKeys) capture[key] = row[key]

  return NextResponse.json({
    capture,
    ...(transcriptGuardSkipped ? { transcript_guard_skipped: true } : {}),
  })
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  const { id } = await params
  const permanent = request.nextUrl.searchParams.get('permanent') === 'true'

  if (permanent) {
    // Permanent delete must also tear down the knowledge graph derived from
    // this capture. claim_source.source_id and entity_link.{source,target}_id
    // are polymorphic bare UUIDs with NO foreign key (migration 109), so a bare
    // captures.delete() would strand every claim learned only from this
    // recording as evidence-orphaned while its embeddings survive and keep
    // surfacing in RAG. The RPC (migration 178) partitions claims sole-sourced
    // by this capture (or its attachments) from shared ones, hard-deletes the
    // former, prunes the latter's evidence, and deletes the capture row — all
    // atomically, owner-only.
    const { error } = await supabase.rpc('delete_capture_with_knowledge', {
      p_capture_id: id,
      p_workspace_id: workspaceId,
      p_user_id: user.id,
    })

    if (error) {
      // P0002 = not found (or not owned by this user in this workspace).
      const code = (error as { code?: string }).code
      if (code === 'P0002') {
        return NextResponse.json({ error: 'Capture not found' }, { status: 404 })
      }
      if (code === '42501') {
        return NextResponse.json({ error: 'Not allowed' }, { status: 403 })
      }
      console.error('[captures.delete] cleanup RPC failed:', code, error.message)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
  } else {
    // count: 'exact' so a capture this user does not own (a teammate's
    // workspace-visible one, excluded by the user_id filter) or one already
    // gone answers 404 like the permanent branch, not a silent success.
    const { error, count } = await supabase
      .from('captures')
      .update({ status: 'archived' }, { count: 'exact' })
      .eq('id', id)
      .eq('user_id', user.id)
      .eq('workspace_id', workspaceId)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    if (!count) {
      return NextResponse.json({ error: 'Capture not found' }, { status: 404 })
    }
  }

  return NextResponse.json({ success: true })
}
