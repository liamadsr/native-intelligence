/**
 * A meeting prep knows its meeting (Liam, 2026-10-17: at 6:47 PM the chat
 * still called that morning's prepped meeting "still ahead"). The prep run's
 * meeting is its idempotency key (meeting-soon.ts parsePrepFireKey: the
 * meeting key and start) and its own brief (meeting-prep.ts parsePrepTaskIds:
 * the calendar event, pending capture and end), read back from agent_run, so the
 * link holds however the run was dispatched (the admission or the reaper).
 * Two places carry it:
 *   • the report: `metadata.meeting_prep` on the teammate_report message
 *     (src/lib/work/chat-report.ts), enough to find the meeting again, and
 *     the report's own `meeting` (its start in the person's zone, for the
 *     model's line about it: teammate-report.ts teammateReportContextLine);
 *   • the document: `document.frontmatter.meeting_prep` (the document's
 *     system metadata, as reference ingest's `generated` flags are), written
 *     server-side when the prep's ready-for-review report records its
 *     deliverables, with the person it is for. The cards note reads it in
 *     one batched read, only when document cards are on screen
 *     (loadPrepDocLabels), and says which meeting a prep is for and whether
 *     it is over, at turn time, in the person's zone.
 * Never throwing: a lost link is a missing label, never a failed settle or turn.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { parsePrepFireKey } from './meeting-soon'
import { parsePrepTaskIds } from './meeting-prep'
import { prepTimeLabel } from './meeting-time'
import { MEETING_PREP_KEY, parseMeetingPrepRef, type MeetingPrepRef } from './prep-ref'

export { MEETING_PREP_KEY, parseMeetingPrepRef, type MeetingPrepRef } from './prep-ref'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** At most this many prep documents are labelled per turn (the note describes three cards). */
const MAX_LABELLED_DOCS = 8

/**
 * The meeting a run preps, when it is a meeting prep (agent_run.server_helper
 * 'meeting_prep', with a prep fire key), with the person it is for. Null for
 * any other run or a failed read. Never throws.
 */
export async function meetingPrepForRun(
  supabase: SupabaseClient,
  args: { workspaceId: string; agentRunId: string },
): Promise<{ ref: MeetingPrepRef; userId: string; enrichContactIds: string[] } | null> {
  try {
    const { data, error } = await supabase
      .from('agent_run')
      .select('server_helper, fire_key, task_prompt, triggered_by')
      .eq('id', args.agentRunId)
      .eq('workspace_id', args.workspaceId)
      .maybeSingle()
    if (error || !data) return null
    const run = data as { server_helper?: unknown; fire_key?: unknown; task_prompt?: unknown; triggered_by?: unknown }
    if (run.server_helper !== 'meeting_prep' || typeof run.triggered_by !== 'string') return null
    const key = parsePrepFireKey(run.fire_key)
    if (!key) return null
    const brief = parsePrepTaskIds(run.task_prompt)
    const startIso = new Date(key.startMs).toISOString()
    const endIso = brief.endIso && Date.parse(brief.endIso) > key.startMs ? brief.endIso : null
    return {
      ref: { startIso, endIso, calendarEventId: brief.calendarEventId, captureId: brief.captureId, meetingKey: key.meetingKey },
      userId: run.triggered_by,
      // The attendees its report offers to enrich (meeting-prep.ts ENRICH_LINE).
      enrichContactIds: brief.enrichContactIds,
    }
  } catch {
    return null
  }
}

/**
 * Stamp the prep's documents (its deliverables of type document, in this
 * workspace) as the prep for its meeting: `frontmatter.meeting_prep`, the
 * rest of the frontmatter kept. Returns how many were stamped. Never throws.
 *
 * A prep is its person's alone (migration 369): it is written from their own
 * calendar and may quote their mail, so stamping also makes it private and
 * theirs (created_by = their member row here), the way the run created it.
 * A system document is never private: left as it is (the guard would refuse).
 */
export async function markPrepDocuments(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; ref: MeetingPrepRef; deliverables: ReadonlyArray<{ type?: unknown; id?: unknown; workspace_id?: unknown }> },
): Promise<number> {
  const ids = [
    ...new Set(
      args.deliverables
        .filter((d) => d?.type === 'document' && typeof d.id === 'string' && UUID_RE.test(d.id) && (d.workspace_id == null || d.workspace_id === args.workspaceId))
        .map((d) => d.id as string),
    ),
  ]
  if (!ids.length) return 0
  let stamped = 0
  try {
    const [{ data, error }, { data: owner }] = await Promise.all([
      supabase.from('document').select('id, frontmatter, canon_key').eq('workspace_id', args.workspaceId).in('id', ids),
      supabase.from('member').select('id').eq('workspace_id', args.workspaceId).eq('user_id', args.userId).maybeSingle(),
    ])
    if (error) {
      console.warn('[meeting-prep] prep document stamp skipped:', error.message)
      return 0
    }
    const ownerId = (owner as { id?: string } | null)?.id ?? null
    for (const doc of (data as Array<{ id?: unknown; frontmatter?: unknown; canon_key?: unknown }> | null) ?? []) {
      if (typeof doc.id !== 'string') continue
      const prior = doc.frontmatter && typeof doc.frontmatter === 'object' && !Array.isArray(doc.frontmatter) ? (doc.frontmatter as Record<string, unknown>) : {}
      const update: Record<string, unknown> = { frontmatter: { ...prior, [MEETING_PREP_KEY]: { ...args.ref, userId: args.userId } } }
      if (ownerId && !doc.canon_key) {
        update.visibility = 'private'
        update.created_by = ownerId
      }
      const { error: updateError } = await supabase
        .from('document')
        .update(update)
        .eq('id', doc.id)
        .eq('workspace_id', args.workspaceId)
      if (updateError) console.warn('[meeting-prep] prep document stamp skipped:', updateError.message)
      else stamped += 1
    }
  } catch (err) {
    console.warn('[meeting-prep] prep document stamp skipped:', err instanceof Error ? err.message : err)
  }
  return stamped
}

/**
 * Which of these documents are PROVEN to come from the person's own meeting
 * prep: a deliverable (type document) of one of their tracked jobs in the
 * workspace whose agent run is a `meeting_prep` server helper they triggered.
 *
 * Why this and not the stamp alone (or `created_by`): since migration 359 a
 * client can no longer set or change the stamp, and only an owner or admin
 * can change created_by (the document guard and policies), but rows written
 * before 359 (when the document RLS was workspace-wide) prove nothing on
 * their own. tracked_job is written by the service role only (no
 * member INSERT/UPDATE policy, migration 170) and a member can't update
 * agent_run (migration 200) or insert a chat-origin one (299), so a teammate
 * can't make a document a deliverable of the person's prep run. Reads: the
 * person's member row, one bounded containment read per document (member +
 * workspace, the member index), one agent_run read. Never throws: a failed
 * read proves nothing.
 */
export async function provenPrepDocIds(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; docIds: readonly string[] },
): Promise<Set<string>> {
  const out = new Set<string>()
  const ids = [...new Set(args.docIds.filter((id) => UUID_RE.test(id)))].slice(0, MAX_LABELLED_DOCS)
  if (!ids.length) return out
  try {
    const { data: member, error: memberError } = await supabase
      .from('member')
      .select('id')
      .eq('user_id', args.userId)
      .eq('workspace_id', args.workspaceId)
      .maybeSingle()
    const memberId = (member as { id?: unknown } | null)?.id
    if (memberError || typeof memberId !== 'string') return out
    const jobs = await Promise.all(
      ids.map(async (docId) => {
        const { data, error } = await supabase
          .from('tracked_job')
          .select('agent_run_id, deliverables')
          .eq('workspace_id', args.workspaceId)
          .eq('member_id', memberId)
          .not('agent_run_id', 'is', null)
          .contains('deliverables', [{ id: docId }])
          .limit(3)
        if (error) return []
        return ((data as Array<{ agent_run_id?: unknown; deliverables?: unknown }> | null) ?? [])
          .filter(
            (j) =>
              typeof j.agent_run_id === 'string' &&
              Array.isArray(j.deliverables) &&
              j.deliverables.some((d) => (d as { type?: unknown; id?: unknown } | null)?.type === 'document' && (d as { id?: unknown }).id === docId),
          )
          .map((j) => ({ docId, runId: j.agent_run_id as string }))
      }),
    )
    const pairs = jobs.flat()
    if (!pairs.length) return out
    const { data: runs, error: runError } = await supabase
      .from('agent_run')
      .select('id')
      .in('id', [...new Set(pairs.map((p) => p.runId))])
      .eq('workspace_id', args.workspaceId)
      .eq('server_helper', 'meeting_prep')
      .eq('triggered_by', args.userId)
    if (runError) return out
    const prepRuns = new Set(((runs as Array<{ id?: unknown }> | null) ?? []).map((r) => r.id))
    for (const p of pairs) if (prepRuns.has(p.runId)) out.add(p.docId)
  } catch {
    // Nothing proven.
  }
  return out
}

/**
 * The cards note's label for each of these documents that is the person's
 * own meeting prep (document id → "prep for the 12:00 PM meeting · over"),
 * at `nowMs` in their zone (meeting-time.ts prepTimeLabel). One read, plus
 * the provenance check (provenPrepDocIds) for the stamped ones; none without
 * ids. A prep stamped for someone else, or a stamp not backed by the
 * person's own prep run (a forged one), gets no label. Never throws.
 */
export async function loadPrepDocLabels(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; docIds: readonly string[]; timeZone: unknown; nowMs?: number },
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const ids = [...new Set(args.docIds.filter((id) => UUID_RE.test(id)))].slice(0, MAX_LABELLED_DOCS)
  if (!ids.length) return out
  try {
    const { data, error } = await supabase.from('document').select('id, frontmatter').eq('workspace_id', args.workspaceId).in('id', ids)
    if (error) return out
    const nowMs = args.nowMs ?? Date.now()
    const stamped: Array<{ id: string; ref: MeetingPrepRef }> = []
    for (const doc of (data as Array<{ id?: unknown; frontmatter?: unknown }> | null) ?? []) {
      const stored = (doc.frontmatter as Record<string, unknown> | null)?.[MEETING_PREP_KEY] as { userId?: unknown } | undefined
      const ref = parseMeetingPrepRef(stored)
      if (typeof doc.id !== 'string' || !ref || stored?.userId !== args.userId) continue
      stamped.push({ id: doc.id, ref })
    }
    if (!stamped.length) return out
    const proven = await provenPrepDocIds(supabase, { workspaceId: args.workspaceId, userId: args.userId, docIds: stamped.map((d) => d.id) })
    for (const { id, ref } of stamped) {
      if (!proven.has(id)) continue
      // A meeting runs to its calendar end (a two-hour workshop is not over after one).
      const label = prepTimeLabel(ref.startIso, nowMs, args.timeZone, ref.endIso)
      if (label) out.set(id, label)
    }
  } catch {
    // No labels: the note reads as before.
  }
  return out
}
