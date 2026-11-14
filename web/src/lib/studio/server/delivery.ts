// A finished export is delivered the way the app delivers finished work: one row in the work ledger
// (src/lib/work/recorder.ts), which puts it in For you (needs_review, its video as the deliverable, the download
// link on it), sends the push, and for an export the agent started, reports in the person's home chat. A failed one
// is reported too, with the reason.
//
// Who hears about it, a rule simple enough to test:
//   - an export the agent started (export_studio_video: input.source 'agent') always;
//   - an export queued from the editor (input.source 'editor') only when the person left it: the editor's poll of
//     the job stamps it as watched (at most every WATCH_STAMP_EVERY_MS per process, in studio_record), and a job
//     whose last stamp is older than WATCHING_MS when it ends was finished with nobody watching the progress bar;
//   - a job that names no source (queued before this file) never: nothing says who would want it.
// One card per export: the ledger row's run key is the job's id (a second delivery finds the same row, and its
// settle loses the recorder's compare-and-set, so nothing is told twice), and a job ends only once
// (completeJob/failJob are compare-and-set on the running row).
//
// Best-effort, never throws: the job has already ended; a lost delivery is logged, never the worker's failure.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { StudioContext } from './context'
import { deleteRecord, getRecord, putRecord } from './records'

/** Where an export was queued from (recorded on its job's input). */
export const EXPORT_SOURCES = ['editor', 'agent'] as const
export type ExportSource = (typeof EXPORT_SOURCES)[number]

/** The person counts as watching an export the editor polled this recently. */
export const WATCHING_MS = 45_000
/** The editor's poll stamps a job at most this often, per process (it polls every second or so). */
export const WATCH_STAMP_EVERY_MS = 15_000
/** The studio_record collection the stamps live in (one record per running export, removed when it ends). */
export const WATCH_COLLECTION = 'export_watch'
/** The ledger's kind for an export delivered (WORK_KINDS.studioExport). */
export const STUDIO_EXPORT_KIND = 'studio_export'

/** The source a job's input names, or null for none (or anything else). */
export function exportSourceOf(input: unknown): ExportSource | null {
  const source = input && typeof input === 'object' ? (input as { source?: unknown }).source : undefined
  return (EXPORT_SOURCES as readonly unknown[]).includes(source) ? (source as ExportSource) : null
}

/** Is an ended export told to the person who queued it? (The rule above.) */
export function shouldDeliverExport(args: { source: ExportSource | null; watchedAt: string | null; now: number }): boolean {
  if (args.source === 'agent') return true
  if (args.source !== 'editor') return false
  const at = args.watchedAt ? Date.parse(args.watchedAt) : NaN
  return !Number.isFinite(at) || args.now - at > WATCHING_MS
}

/** When this process last stamped each job (the throttle; a few hundred jobs at most, then it starts again). */
const stamped = new Map<string, number>()

/** The editor polled a running export: the person is watching it. Throttled; never throws. */
export async function noteExportWatched(ctx: StudioContext, job: { id: string; kind: string; status: string }, now = Date.now()): Promise<void> {
  if (job.kind !== 'export' || job.status !== 'running') return
  const last = stamped.get(job.id)
  if (last !== undefined && now - last < WATCH_STAMP_EVERY_MS) return
  if (stamped.size > 500) stamped.clear()
  stamped.set(job.id, now)
  try {
    await putRecord(ctx, WATCH_COLLECTION, job.id, { at: new Date(now).toISOString() })
  } catch (error) {
    console.warn('[studio] stamping an export as watched failed:', error instanceof Error ? error.message : error)
  }
}

/** What delivery reads of an ended job. */
type EndedJob = {
  id: string
  workspace_id: string
  video_id: string | null
  kind: string
  status: string
  result: Record<string, unknown> | null
  error: string | null
  created_by: string | null
  input_title: string | null
  input_source: string | null
}

/** A file name safe for a download header (as jobs.ts names an export). */
const fileName = (title: string) => `${(title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim() || 'video').slice(0, 120)}.mp4`

/** The app's link to a finished export's file, as the editor's download button has it. */
export const exportDownloadUrl = (workspaceId: string, key: string, title: string) =>
  `/api/account/studio/file/${workspaceId}/${key}?download=${encodeURIComponent(fileName(title))}`

/** "0:42, 1080 × 1920, 12.3 MB": what a finished export is, from its result. */
export function exportFacts(result: Record<string, unknown> | null): string {
  const parts: string[] = []
  const seconds = Number(result?.durationSeconds)
  if (Number.isFinite(seconds) && seconds > 0) parts.push(`${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`)
  const width = Number(result?.width), height = Number(result?.height)
  if (width > 0 && height > 0) parts.push(`${width} × ${height}`)
  const megabytes = Math.round(Number(result?.bytes) / 100_000) / 10
  if (Number.isFinite(megabytes) && megabytes > 0) parts.push(`${megabytes} MB`)
  return parts.join(', ')
}

/** The person's home thread in the workspace (where a chat-asked row reports), or null. */
async function homeConversationId(supabase: SupabaseClient, workspaceId: string, userId: string): Promise<string | null> {
  const { data } = await supabase.from('chat_conversations').select('id').eq('user_id', userId).eq('workspace_id', workspaceId).eq('is_home', true).limit(1)
  const id = (data as Array<{ id?: unknown }> | null)?.[0]?.id
  return typeof id === 'string' ? id : null
}

/**
 * Deliver an export that just ended (completed or failed) to the person who queued it, when the rule says so.
 * Answers what it did. Called by completeJob and failJob once their own write has committed.
 */
export async function deliverEndedExport(deps: { supabase: SupabaseClient }, jobId: string, now = Date.now()): Promise<'delivered' | 'skipped'> {
  const { supabase } = deps
  try {
    const { data, error } = await supabase
      .from('studio_job')
      .select('id, workspace_id, video_id, kind, status, result, error, created_by, input_title:input->>title, input_source:input->>source')
      .eq('id', jobId)
      .maybeSingle()
    const job = data as EndedJob | null
    // An export on the server or on the person's own computer (local-jobs.ts) is delivered alike.
    if (error || !job || (job.kind !== 'export' && job.kind !== 'local-export') || (job.status !== 'completed' && job.status !== 'failed')) return 'skipped'
    const ctx: StudioContext = { supabase, workspaceId: job.workspace_id, userId: null }
    const watch = await getRecord<{ at?: unknown }>(ctx, WATCH_COLLECTION, job.id).catch(() => null)
    await deleteRecord(ctx, WATCH_COLLECTION, job.id).catch(() => undefined)
    stamped.delete(job.id)
    const source = exportSourceOf({ source: job.input_source })
    const watchedAt = typeof watch?.at === 'string' ? watch.at : null
    if (!shouldDeliverExport({ source, watchedAt, now }) || !job.created_by) return 'skipped'

    // Loaded here: the ledger's modules are large, and every other job ends without them.
    const [{ startWork }, { resolveMemberId }, { WORK_KINDS }] = await Promise.all([
      import('@/lib/work/recorder'),
      import('@/lib/work/agent-run-mirror'),
      import('@/lib/work/types'),
    ])
    const memberId = await resolveMemberId(supabase, job.workspace_id, job.created_by)
    if (!memberId) return 'skipped'
    const title = (job.input_title || 'Untitled video').slice(0, 200)
    // The agent asked in the chat: the row reports in the person's home thread (chat-report.ts), as a helper's does.
    const home = source === 'agent' ? await homeConversationId(supabase, job.workspace_id, job.created_by).catch(() => null) : null
    const work = await startWork(supabase, {
      workspaceId: job.workspace_id,
      memberId,
      kind: WORK_KINDS.studioExport,
      title: `Exporting “${title}”`,
      actor: source === 'agent' ? 'agent' : 'system',
      status: 'running',
      runKey: `studio_export:${job.id}`,
      origin: home ? 'chat' : 'user',
      area: 'studio',
      source: { studio_job_id: job.id, ...(job.video_id ? { studio_video_id: job.video_id } : {}), ...(home ? { chat_conversation_id: home } : {}) },
    })
    if (work.inert) return 'skipped'

    if (job.status === 'failed') {
      const reason = (job.error || 'The Studio worker stopped without saying why.').slice(0, 500)
      await work.fail(`The export of “${title}” failed: ${reason}`)
      return 'delivered'
    }
    const key = typeof job.result?.key === 'string' ? job.result.key : null
    const url = key ? exportDownloadUrl(job.workspace_id, key, title) : null
    const facts = exportFacts(job.result)
    const deliverable = job.video_id
      ? { type: 'studio_video' as const, id: job.video_id, label: title, ...(url ? { url } : {}) }
      : url
        ? { type: 'url' as const, id: url, label: title }
        : null
    // Made and kept on the person's computer: nothing on the server to download.
    const kept = job.result?.kept === 'computer'
    await work.finish({
      summary: kept ? `“${title}” is exported${facts ? ` (${facts})` : ''} and kept on the computer it was made on.` : `“${title}” is exported${facts ? ` (${facts})` : ''}. Open it in the Studio, or download the MP4.`,
      deliverables: deliverable ? [deliverable] : [],
      review: deliverable ? { kind: 'review', verb: 'check', deliverable: 0 } : null,
    })
    return 'delivered'
  } catch (error) {
    console.error('[studio] delivering an export failed:', error instanceof Error ? error.message : error)
    return 'skipped'
  }
}
