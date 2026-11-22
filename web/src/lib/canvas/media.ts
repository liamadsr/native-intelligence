/**
 * Images and video on a canvas. The file lives in the `attachments` bucket
 * under the canvas's own folder; the item keeps the path. Nobody reads the
 * bucket directly: the canvas's media route checks that the caller can open
 * the canvas, then hands out a short-lived link.
 */

export const CANVAS_MEDIA_BUCKET = 'attachments'
export const CANVAS_MEDIA_MAX_BYTES = 25 * 1024 * 1024
export const CANVAS_MEDIA_MAX_LABEL = '25 MB'

/** What a canvas takes, by MIME type: the extension it is stored under. */
export const CANVAS_MEDIA_TYPES: Readonly<Record<string, { ext: string; kind: 'image' | 'video' }>> = {
  'image/png': { ext: 'png', kind: 'image' },
  'image/jpeg': { ext: 'jpg', kind: 'image' },
  'image/gif': { ext: 'gif', kind: 'image' },
  'image/webp': { ext: 'webp', kind: 'image' },
  'video/mp4': { ext: 'mp4', kind: 'video' },
  'video/webm': { ext: 'webm', kind: 'video' },
  'video/quicktime': { ext: 'mov', kind: 'video' },
}
export const CANVAS_MEDIA_ACCEPT = Object.keys(CANVAS_MEDIA_TYPES).join(',')

export const canvasMediaKind = (mime: string): 'image' | 'video' | null => CANVAS_MEDIA_TYPES[mime.toLowerCase()]?.kind ?? null

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const PATH = new RegExp(`^canvas/(${UUID})/(${UUID})/(${UUID})\\.(png|jpg|gif|webp|mp4|webm|mov)$`)

/** Where a new file for this canvas goes. */
export function canvasMediaPath(workspaceId: string, canvasId: string, fileId: string, ext: string): string {
  return `canvas/${workspaceId}/${canvasId}/${fileId}.${ext}`
}

/** Is this a path the given canvas owns? Anything else (another canvas's, another folder's, a traversal) is not. */
export function isCanvasMediaPath(path: unknown, workspaceId: string, canvasId: string): path is string {
  if (typeof path !== 'string') return false
  const m = PATH.exec(path)
  return !!m && m[1] === workspaceId && m[2] === canvasId
}

/** The address an item draws its media from. */
export const canvasMediaUrl = (canvasId: string, path: string): string => `/api/account/canvases/${canvasId}/media?path=${encodeURIComponent(path)}`

/** What clearing a canvas's folder needs of a storage bucket. */
export interface MediaBucket {
  list(path: string, options: { limit: number }): Promise<{ data: Array<{ name: string }> | null; error: { message: string } | null }>
  remove(paths: string[]): Promise<{ error: { message: string } | null }>
}

/**
 * Delete every file a canvas owns: what a permanent delete calls once the
 * canvas's row is gone, so nothing is left that no canvas can reach. Only the
 * canvas's own folder, and only names a canvas file can have. Returns how many
 * went; a failure is reported, never thrown (the canvas is already deleted).
 */
export async function removeCanvasMedia(bucket: MediaBucket, workspaceId: string, canvasId: string): Promise<{ removed: number; error: string | null }> {
  const folder = `canvas/${workspaceId}/${canvasId}`
  if (!new RegExp(`^canvas/${UUID}/${UUID}$`).test(folder)) return { removed: 0, error: 'Not a canvas folder' }
  let removed = 0
  // A folder is emptied a page at a time; the bound stops a listing that never shrinks.
  for (let round = 0; round < 50; round++) {
    const { data, error } = await bucket.list(folder, { limit: 1000 })
    if (error) return { removed, error: error.message }
    const paths = (data ?? []).map((f) => `${folder}/${f.name}`).filter((p) => isCanvasMediaPath(p, workspaceId, canvasId))
    if (!paths.length) return { removed, error: null }
    const gone = await bucket.remove(paths)
    if (gone.error) return { removed, error: gone.error.message }
    removed += paths.length
    if ((data ?? []).length < 1000) return { removed, error: null }
  }
  return { removed, error: 'Too many files' }
}
