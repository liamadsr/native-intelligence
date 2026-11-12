// The Studio's housekeeping, run every hour by GET /api/cron/studio-sweep. What a Studio keeps for good (its library,
// its videos and their thumbnails) is never touched; what is only on the way somewhere, or a by-product, goes once it
// can no longer be wanted:
//
//   pending writes      older than 24 h: an upload links that was never committed (its parts, and its record)
//   uploads/*           older than 24 h, or whose job (import, slides, sound-import) ended without using it (one an
//                       open job names is kept, whatever its kind)
//   stills/*            older than 7 days: the frames the agent looked at
//   exports/*           older than 30 days: the job row still says it was exported; its link answers 404 with why
//   studio_job rows     finished, failed or cancelled more than 90 days ago
//
// Every run does a bounded amount of work (SWEEP_LIMIT objects in all) and is idempotent: what one run leaves the
// next takes. Works across workspaces with the service role, one workspace's context per object.
import type { SupabaseClient } from '@supabase/supabase-js'
import { deleteBlob, getBlob, PENDING, type StoredBlob } from './blobs'
import { must, type StudioContext } from './context'
import type { StudioStorage } from './storage'

/** How many objects (files, pending writes, job rows) one run handles at most. */
export const SWEEP_LIMIT = 500

const HOUR = 3600_000
const DAY = 24 * HOUR
/** How long each kind of thing is kept. */
export const KEEP = { pending: DAY, uploads: DAY, stills: 7 * DAY, exports: 30 * DAY, jobs: 90 * DAY } as const

/** What one run removed. */
export type SweepCounts = { pendingWrites: number; uploads: number; stills: number; exports: number; jobs: number }

type BlobRef = { workspace_id: string; key: string }

/** A workspace's context, acting for nobody (the sweep). */
const contextOf = (supabase: SupabaseClient, storage: StudioStorage | undefined, workspaceId: string): StudioContext => ({ supabase, storage, workspaceId, userId: null })

/** The job kinds whose input names an upload (`uploadKey`): import, slides, sound-import. */
export const UPLOAD_KINDS = ['import', 'slides', 'sound-import'] as const

/**
 * Whether an open job of the workspace names this upload: running (even asked to stop: its worker may still be
 * reading it), or queued and not asked to stop. Checked per upload, so no cap on a list of open jobs can miss one.
 */
async function uploadInUse(supabase: SupabaseClient, ref: BlobRef): Promise<boolean> {
  const rows = must(
    await supabase.from('studio_job').select('status, cancel_requested').eq('workspace_id', ref.workspace_id).eq('input->>uploadKey', ref.key).in('status', ['queued', 'running']).limit(20),
    'list open jobs',
  ) as { status: string; cancel_requested: boolean }[] | null
  return (rows ?? []).some((job) => job.status === 'running' || !job.cancel_requested)
}

/** The committed blob under a key, null when there is none, or 'unknown' when it could not be read (then nothing is removed). */
async function committedOrUnknown(ctx: StudioContext, key: string): Promise<StoredBlob | null | 'unknown'> {
  try {
    return await getBlob(ctx, key)
  } catch (error) {
    console.error(`[studio-sweep] couldn't read ${key}; skipped:`, error instanceof Error ? error.message : error)
    return 'unknown'
  }
}

/**
 * Remove what the Studio no longer needs (see the header). `now` and `storage` are for tests. Logs and answers the
 * counts; a failure on one object is logged and skipped (the next run tries it again).
 */
export async function sweepStudio(supabase: SupabaseClient, options: { now?: Date; storage?: StudioStorage; limit?: number } = {}): Promise<SweepCounts> {
  const now = options.now?.getTime() ?? Date.now()
  const before = (ms: number) => new Date(now - ms).toISOString()
  let left = options.limit ?? SWEEP_LIMIT
  const counts: SweepCounts = { pendingWrites: 0, uploads: 0, stills: 0, exports: 0, jobs: 0 }
  const remove = async (ref: BlobRef): Promise<boolean> => {
    left--
    try {
      await deleteBlob(contextOf(supabase, options.storage, ref.workspace_id), ref.key)
      return true
    } catch (error) {
      console.error(`[studio-sweep] couldn't remove ${ref.key}:`, error instanceof Error ? error.message : error)
      return false
    }
  }

  // 1. Pending writes never committed. One that would replace a committed file only loses its record: the file stays.
  if (left > 0) {
    const pending = must(
      await supabase.from('studio_record').select('workspace_id, key').eq('collection', PENDING).lt('updated_at', before(KEEP.pending)).order('updated_at').limit(left),
      'list pending writes',
    ) as BlobRef[] | null
    for (const ref of pending ?? []) {
      if (left <= 0) break
      const ctx = contextOf(supabase, options.storage, ref.workspace_id)
      // A failed read is not "not committed": removing then would take a stored file's parts. Skipped: the next run tries.
      const committed = await committedOrUnknown(ctx, ref.key)
      if (committed === 'unknown') continue
      if (committed) {
        left--
        must(await supabase.from('studio_record').delete().eq('workspace_id', ref.workspace_id).eq('collection', PENDING).eq('key', ref.key), 'remove a pending write')
        counts.pendingWrites++
      } else if (await remove(ref)) counts.pendingWrites++
    }
  }

  // 2. Uploads: those an open job is about to use are kept; those whose job ended without them, and all old ones, go.
  if (left > 0) {
    const ended = must(
      await supabase.from('studio_job').select('workspace_id, key:input->>uploadKey').in('kind', [...UPLOAD_KINDS]).in('status', ['failed', 'cancelled']).gte('updated_at', before(2 * DAY)).order('updated_at', { ascending: false }).limit(Math.min(left, 100)),
      'list ended jobs',
    ) as BlobRef[] | null
    const old = must(
      await supabase.from('studio_blob').select('workspace_id, key').like('key', 'uploads/%').lt('created_at', before(KEEP.uploads)).order('created_at').limit(left),
      'list old uploads',
    ) as BlobRef[] | null
    const seen = new Set<string>()
    for (const ref of [...(ended ?? []), ...(old ?? [])]) {
      const slot = `${ref.workspace_id}:${ref.key}`
      if (left <= 0) break
      if (!ref.key || !/^uploads\/[0-9a-f-]{36}$/.test(ref.key) || seen.has(slot)) continue
      seen.add(slot)
      // An ended job's upload may be gone already (failJob removes it): only a stored one counts.
      if (!(await getBlob(contextOf(supabase, options.storage, ref.workspace_id), ref.key).catch(() => null))) continue
      // One an open job (another, or a retry) is about to use is kept; one that can't be checked is too.
      if (await uploadInUse(supabase, ref).catch(() => true)) continue
      if (await remove(ref)) counts.uploads++
    }
  }

  // 3–4. Old frames and old exports.
  for (const [prefix, age, field] of [['stills/', KEEP.stills, 'stills'], ['exports/', KEEP.exports, 'exports']] as const) {
    if (left <= 0) break
    const rows = must(
      await supabase.from('studio_blob').select('workspace_id, key').like('key', `${prefix}%`).lt('created_at', before(age)).order('created_at').limit(left),
      `list old ${field}`,
    ) as BlobRef[] | null
    for (const ref of rows ?? []) {
      if (left <= 0) break
      if (await remove(ref)) counts[field]++
    }
  }

  // 5. Job rows long finished.
  if (left > 0) {
    const rows = must(
      await supabase.from('studio_job').select('id').in('status', ['completed', 'failed', 'cancelled']).lt('updated_at', before(KEEP.jobs)).order('updated_at').limit(left),
      'list old jobs',
    ) as { id: string }[] | null
    const ids = (rows ?? []).map((row) => row.id)
    for (let at = 0; at < ids.length; at += 100) {
      const chunk = ids.slice(at, at + 100)
      must(await supabase.from('studio_job').delete().in('id', chunk), 'remove old jobs')
      counts.jobs += chunk.length
    }
  }

  console.info('[studio-sweep]', JSON.stringify(counts))
  return counts
}
