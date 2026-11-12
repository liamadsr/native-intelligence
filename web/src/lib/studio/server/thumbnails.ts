// A video's thumbnail for lists: one small JPEG (blob thumbs/<video id>.jpg) the worker renders. It is asked for
// lazily: when a list shows a video whose thumbnail is missing or older than the edit, one `thumbnail` job is
// queued (never one per request: not while one is waiting or running, not twice for the same version of the edit,
// and not more often than every few minutes for one video). Until it exists the image answers 404 and the list
// shows its own placeholder.
import { getBlob, type StoredBlob } from './blobs'
import { isUuid, must, type StudioContext } from './context'
import { queueJob } from './jobs'
import { openVideo, thumbnailSeconds } from './videos'

/** A video's thumbnail key. */
export const thumbnailKey = (videoId: string) => `thumbs/${videoId}.jpg`

/** How long after one thumbnail job another may be queued for the same video. */
const AGAIN_AFTER_MS = 3 * 60_000

type ThumbJob = { id: string; status: string; created_at: string; digest: string | null }

/** Whether a thumbnail job should be queued now, from the video's digest, its thumbnail and its recent thumbnail jobs. */
export function thumbnailDue(digest: string, hasThumbnail: boolean, recent: ThumbJob[], now = Date.now()): boolean {
  if (recent.some((job) => job.status === 'queued' || job.status === 'running')) return false
  if (recent.some((job) => job.digest === digest)) return false
  const newest = recent[0]
  if (hasThumbnail && newest && now - Date.parse(newest.created_at) < AGAIN_AFTER_MS) return false
  return true
}

/** The stored thumbnail (possibly of an older version), queuing a fresh one when it is due. Null when there is none yet. */
export async function videoThumbnail(ctx: StudioContext, videoId: string): Promise<StoredBlob | null> {
  const key = thumbnailKey(videoId)
  if (!isUuid(videoId)) return null
  const [blob, row] = await Promise.all([
    getBlob(ctx, key),
    ctx.supabase.from('studio_video').select('digest, archived_at').eq('workspace_id', ctx.workspaceId).eq('id', videoId).maybeSingle().then((r) => must(r, 'read that video') as { digest: string; archived_at: string | null } | null),
  ])
  if (!row || row.archived_at) return blob
  const recent = must(
    await ctx.supabase
      .from('studio_job')
      .select('id, status, created_at, digest:input->>digest')
      .eq('workspace_id', ctx.workspaceId)
      .eq('video_id', videoId)
      .eq('kind', 'thumbnail')
      .order('created_at', { ascending: false })
      .limit(5),
    'read thumbnail jobs',
  ) as ThumbJob[] | null
  if (thumbnailDue(row.digest, !!blob, recent ?? [])) {
    try {
      const { project, projectDigest } = await openVideo(ctx, videoId)
      await queueJob(ctx, 'thumbnail', { project, seconds: thumbnailSeconds(project), key, digest: projectDigest }, videoId)
    } catch (error) {
      console.error('[studio] queuing a thumbnail failed:', error instanceof Error ? error.message : error)
    }
  }
  return blob
}
