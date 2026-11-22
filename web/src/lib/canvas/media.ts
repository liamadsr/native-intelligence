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
