import { type NextRequest, NextResponse } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import {
  MEETING_GOAL_MAX_CHARS,
  clearMeetingGoal,
  findMeetingGoalForCapture,
  getMeetingGoal,
  isMeetingGoalSource,
  meetingKeyForCapture,
  normalizeEventId,
  normalizeGoalText,
  normalizeStartsAt,
  upsertMeetingGoal,
} from '@/lib/meetings/meeting-goal'

/**
 * /api/account/meeting-goal — the caller's own goal for one meeting
 * (migration 356), keyed by its calendar event id and start. The prep card's
 * composer reads and writes it (MeetingGoalComposer); the main chat writes it
 * with set_meeting_goal; the live HUD's goal line asks for a capture's meeting
 * first, then writes it with source 'hud' (components/live-hud/save-hud-goal.ts).
 *
 *   GET    ?calendar_event_id&starts_at → { goal: MeetingGoal | null }
 *   GET    ?capture_id → { goal, meeting: { calendarEventId, startsAt } | null }:
 *          the goal for a capture's meeting (findMeetingGoalForCapture) and the
 *          meeting to write it under: the goal's own when there is one, else
 *          the capture's (meetingKeyForCapture: its calendar event at its
 *          start, or for an ad-hoc call `capture:<id>` at its start). 404 for
 *          a capture the caller can't see.
 *   PUT    { calendar_event_id, starts_at, capture_id?, goal, source } → { goal }
 *          An empty goal is a 400: clearing is DELETE. A capture_id that is no
 *          longer a capture in this workspace saves the goal without the link.
 *   DELETE ?calendar_event_id&starts_at (or the same in a JSON body) → { cleared }
 *
 * Private to the caller: every query fences on the signed-in person and the
 * current workspace (RLS too on a user session; a device token's client is the
 * service role, so the fence is what holds there).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The meeting from a query string or a body, or a 400. */
function meetingOf(source: { calendar_event_id?: unknown; starts_at?: unknown }) {
  const calendarEventId = normalizeEventId(source.calendar_event_id)
  if (!calendarEventId) return badRequest('calendar_event_id is required')
  const startsAt = normalizeStartsAt(source.starts_at)
  if (!startsAt) return badRequest('starts_at must be a date-time')
  return { calendarEventId, startsAt }
}

function fromQuery(request: NextRequest) {
  const params = new URL(request.url).searchParams
  return { calendar_event_id: params.get('calendar_event_id') ?? undefined, starts_at: params.get('starts_at') ?? undefined }
}

export async function GET(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  const captureParam = new URL(request.url).searchParams.get('capture_id')
  if (captureParam != null) {
    if (!UUID_RE.test(captureParam)) return badRequest('capture_id must be a UUID')
    // The capture as the caller may see it: this workspace's, and shared with
    // the workspace or their own (a private capture stays its creator's).
    const { data: capture, error } = await supabase
      .from('captures')
      .select('id, calendar_event_id, occurrence_start, scheduled_start, started_at, created_at')
      .eq('id', captureParam)
      .eq('workspace_id', workspaceId)
      .or(`visibility.eq.workspace,user_id.eq.${user.id}`)
      .maybeSingle()
    if (error) return serverError(error.message)
    if (!capture) return notFound('Capture not found')
    try {
      const goal = await findMeetingGoalForCapture(supabase, { workspaceId, userId: user.id, captureId: captureParam })
      const meeting = goal
        ? { calendarEventId: goal.calendarEventId, startsAt: goal.startsAt }
        : meetingKeyForCapture(captureParam, capture as Record<string, unknown>)
      return NextResponse.json({ goal, meeting })
    } catch (err) {
      return serverError(err instanceof Error ? err.message : undefined)
    }
  }

  const meeting = meetingOf(fromQuery(request))
  if (meeting instanceof Response) return meeting
  try {
    const goal = await getMeetingGoal(supabase, { workspaceId, userId: user.id, ...meeting })
    return NextResponse.json({ goal })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : undefined)
  }
}

export async function PUT(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  let body: Record<string, unknown>
  try {
    const parsed: unknown = await request.json()
    if (!parsed || typeof parsed !== 'object') return badRequest('Invalid JSON body')
    body = parsed as Record<string, unknown>
  } catch {
    return badRequest('Invalid JSON body')
  }
  const meeting = meetingOf(body)
  if (meeting instanceof Response) return meeting
  const text = normalizeGoalText(body.goal)
  if (!text.ok) {
    return badRequest(text.reason === 'too_long' ? `goal is at most ${MEETING_GOAL_MAX_CHARS} characters` : 'goal is required')
  }
  if (!text.goal) return badRequest('goal is required (DELETE clears it)')
  if (!isMeetingGoalSource(body.source)) return badRequest('source must be prep_card, chat or hud')

  let captureId: string | null = null
  if (body.capture_id != null) {
    if (typeof body.capture_id !== 'string' || !UUID_RE.test(body.capture_id)) return badRequest('capture_id must be a UUID')
    // Only a capture in this workspace: the link is how the live agent finds the
    // goal. A stale one (deleted, or not this workspace's) saves the goal
    // without the link: the goal is still found by its meeting.
    const { data: capture, error } = await supabase
      .from('captures')
      .select('id')
      .eq('id', body.capture_id)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    if (error) return serverError(error.message)
    captureId = capture ? body.capture_id : null
  }

  const result = await upsertMeetingGoal(supabase, {
    workspaceId,
    userId: user.id,
    ...meeting,
    goal: text.goal,
    source: body.source,
    captureId,
  })
  if (!result.ok) return result.reason === 'error' ? serverError(result.message) : badRequest(result.message)
  return NextResponse.json({ goal: result.goal })
}

export async function DELETE(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  // The query string, else a JSON body (a client that can't send a body on DELETE uses the query).
  let source: { calendar_event_id?: unknown; starts_at?: unknown } = fromQuery(request)
  if (!source.calendar_event_id && !source.starts_at) {
    try {
      const parsed: unknown = await request.json()
      if (parsed && typeof parsed === 'object') source = parsed as typeof source
    } catch {
      // No body: the query's (missing) fields answer below.
    }
  }
  const meeting = meetingOf(source)
  if (meeting instanceof Response) return meeting
  try {
    const cleared = await clearMeetingGoal(supabase, { workspaceId, userId: user.id, ...meeting })
    return NextResponse.json({ cleared })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : undefined)
  }
}
