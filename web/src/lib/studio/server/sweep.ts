// The Studio's housekeeping, run every hour by GET /api/cron/studio-sweep. What a Studio keeps for good (its library,
// its videos and their thumbnails) is never touched; what is only on the way somewhere, or a by-product, goes once it
// can no longer be wanted:
//
//   pending writes      older than 24 h: an upload links that was never committed (its parts, and its record);
//                       a take's tracks (`live/…`) are not touched here, see live tracks
//   live tracks         a take's pieces (live-takes.ts sweepLiveTakes) with no new piece for 7 days: a take never
//                       finished nor brought back, or one offered back after its recording could not be made; space
//                       held for a track that is gone; takes stopped a day ago with nothing of the screen; and pieces
//                       in storage no take points to
//                       brought back, or a recording whose import failed (a finished import removes its own)
//   uploads/*           older than 24 h, or whose job (import, slides, sound-import) ended without using it (one an
//                       open job names is kept, whatever its kind)
//   stills/*            older than 7 days: the frames the agent looked at
//   exports/*           older than 30 days: the job row still says it was exported; its link answers 404 with why
//   upload links' leftovers  once an export made on a computer, or an upload's job, ended and its links have run out
//                       (3 h): parts under its keys that no committed file accounts for (a refused commit's, parts
//                       stored again after their file was removed, parts past the file's count), and a committed
//                       file whose parts are not the sizes it was committed at
//   local exports       never taken by a computer within 15 minutes: ended (jobs.ts endUntakenLocalExports); the
//                       read counts of their attempts (local-jobs.ts) go after two days
//   recordings          not settled: still importing or being put together 10 minutes on are followed up (the
//                       work after the worker's answer is lost when the app stops; the SQL reaper ends jobs
//                       without it), so a take is made or offered back, never left to the week pass
//   studio_job rows     finished, failed or cancelled more than 90 days ago
//
// Every run does a bounded amount of work (SWEEP_LIMIT objects in all) and is idempotent: what one run leaves the
// next takes. Works across workspaces with the service role, one workspace's context per object.
import type { SupabaseClient } from '@supabase/supabase-js'
import { deleteBlob, getBlob, PENDING, type StoredBlob } from './blobs'
import { blobParts } from './job-contract'
import { endUntakenLocalExports } from './jobs'
import { LINK_SAFE_MS } from './live-takes'
import { removeAll } from './storage'
import { must, type StudioContext } from './context'
import { sweepLiveTakes } from './live-takes'
import type { StudioStorage } from './storage'

/** How many objects (files, pending writes, job rows) one run handles at most. */
export const SWEEP_LIMIT = 500

const HOUR = 3600_000
const DAY = 24 * HOUR
/** How long each kind of thing is kept. */
export const KEEP = { pending: DAY, uploads: DAY, stills: 7 * DAY, exports: 30 * DAY, jobs: 90 * DAY, live: 7 * DAY } as const

/** What one run removed. */
export type SweepCounts = { pendingWrites: number; uploads: number; stills: number; exports: number; jobs: number; liveTracks: number; recordings: number; untaken: number; strays: number }

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
 * The parts under a key that no committed file accounts for, removed; answers how many went. No committed file: every
 * part (and a pending write left by a refused commit, with its record). A committed one: the parts past its count, and
 * the whole file when a part is not the size it was committed at (its bytes are no longer what was checked).
 */
async function strayParts(ctx: StudioContext, storage: StudioStorage, key: string): Promise<number> {
  const committed = await getBlob(ctx, key)
  const folder = `${ctx.workspaceId}/${key}`
  const listed = await storage.list(folder)
  if (!committed) {
    const pending = must(await ctx.supabase.from('studio_record').select('key').eq('workspace_id', ctx.workspaceId).eq('collection', PENDING).eq('key', key).maybeSingle(), 'check a pending write') as { key: string } | null
    if (!listed.length && !pending) return 0
    if (pending) await deleteBlob(ctx, key)
    else await removeAll(storage, listed.map((item) => `${folder}/${item.name}`))
    return Math.max(1, listed.length)
  }
  const shape = blobParts(committed.bytes, committed.partBytes)
  const wrong = listed.some((item) => /^\d+$/.test(item.name) && Number(item.name) < shape.length && item.size !== shape[Number(item.name)]!.bytes)
  if (wrong) {
    await deleteBlob(ctx, key)
    return listed.length
  }
  const extra = listed.filter((item) => !/^\d+$/.test(item.name) || Number(item.name) >= shape.length)
  if (extra.length) await removeAll(storage, extra.map((item) => `${folder}/${item.name}`))
  return extra.length
}

/**
 * Remove what the Studio no longer needs (see the header). `now` and `storage` are for tests. Logs and answers the
 * counts; a failure on one object is logged and skipped (the next run tries it again).
 */
export async function sweepStudio(supabase: SupabaseClient, options: { now?: Date; storage?: StudioStorage; limit?: number } = {}): Promise<SweepCounts> {
  const now = options.now?.getTime() ?? Date.now()
  const before = (ms: number) => new Date(now - ms).toISOString()
  let left = options.limit ?? SWEEP_LIMIT
  const counts: SweepCounts = { pendingWrites: 0, uploads: 0, stills: 0, exports: 0, jobs: 0, liveTracks: 0, recordings: 0, untaken: 0, strays: 0 }
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

  // 0. Local exports no computer took in time end (they would count as open jobs for good).
  counts.untaken = await endUntakenLocalExports(supabase, null, now).catch((error) => {
    console.error("[studio-sweep] couldn't end untaken local exports:", error instanceof Error ? error.message : error)
    return 0
  })

  // 1. Pending writes never committed. One that would replace a committed file only loses its record: the file stays.
  if (left > 0) {
    const pending = must(
      // A take's track holds its space as a pending write for as long as the take is kept (step 5), so its rows are
      // left out here, in the query: however many there are, they never crowd out the others.
      await supabase.from('studio_record').select('workspace_id, key').eq('collection', PENDING).not('key', 'like', 'live/%').lt('updated_at', before(KEEP.pending)).order('updated_at').limit(left),
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

  // 4b. What upload links left once their job ended and the links ran out: a computer's export links (never trusted)
  // and the person's own upload links (removed early by the import, while its links still worked).
  if (left > 0) {
    const jobs = must(
      await supabase.from('studio_job').select('id, workspace_id, kind, upload:input->>uploadKey').in('kind', ['local-export', ...UPLOAD_KINDS]).in('status', ['completed', 'failed', 'cancelled'])
        .lt('updated_at', before(LINK_SAFE_MS)).gte('updated_at', before(LINK_SAFE_MS + DAY)).order('updated_at').limit(Math.min(left, 100)),
      'list ended jobs with upload links',
    ) as { id: string; workspace_id: string; kind: string; upload: string | null }[] | null
    for (const job of jobs ?? []) {
      if (left <= 0) break
      left--
      try {
        const storage = options.storage ?? (await import('./storage')).supabaseStorage(supabase)
        const ctx = contextOf(supabase, storage, job.workspace_id)
        const keys = job.kind === 'local-export'
          ? (await storage.folders(`${job.workspace_id}/exports/${job.id}`)).filter((n) => /^\d+$/.test(n)).map((n) => `exports/${job.id}/${n}/video.mp4`)
          : job.upload && /^uploads\/[0-9a-f-]{36}$/.test(job.upload) ? [job.upload] : []
        for (const key of keys) counts.strays += await strayParts(ctx, storage, key)
      } catch (error) {
        console.error(`[studio-sweep] couldn't check the upload links of job ${job.id}; skipped:`, error instanceof Error ? error.message : error)
      }
    }
  }

  // 5. Recordings not settled 10 minutes on: followed up as the worker's end of their last import would have
  // (recordings.ts recordingImportEnded: idempotent, one builder at a time by its claim). Before step 6, which
  // never clears the footage of a recording that could still use it.
  if (left > 0) {
    const rows = must(
      await supabase.from('studio_record').select('workspace_id, key, value').eq('collection', 'recordings').in('value->>status', ['importing', 'building']).lt('updated_at', before(10 * 60_000)).order('updated_at').limit(Math.min(left, 100)),
      'list recordings not settled',
    ) as { workspace_id: string; key: string; value: { status: string } }[] | null
    const { recordingImportEnded } = await import('./recordings')
    for (const row of rows ?? []) {
      if (left <= 0) break
      left--
      await recordingImportEnded(supabase, options.storage, row.workspace_id, row.key)
      const now = must(await supabase.from('studio_record').select('value').eq('workspace_id', row.workspace_id).eq('collection', 'recordings').eq('key', row.key).maybeSingle(), 'read a recording') as { value: { status: string } } | null
      if (now?.value.status === 'done' || now?.value.status === 'failed') counts.recordings++
    }
  }

  // 6. What takes leave behind (live-takes.ts sweepLiveTakes).
  if (left > 0) {
    const live = await sweepLiveTakes({ supabase, storage: options.storage }, { now, keepMs: KEEP.live, budget: left })
    left -= live.used
    counts.liveTracks += live.removed
  }

  // 7. Job rows long finished.
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
    // The read counts of local exports' attempts (local-jobs.ts), two days on.
    must(await supabase.from('studio_record').delete().eq('collection', 'local-reads').lt('updated_at', before(2 * DAY)), 'remove old read counts')
  }

  console.info('[studio-sweep]', JSON.stringify(counts))
  return counts
}
