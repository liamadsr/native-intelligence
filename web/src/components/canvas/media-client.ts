/** Putting an image or a video on the canvas from the browser: its size, a preview at once, the upload behind it. */
import { CANVAS_MEDIA_MAX_BYTES, CANVAS_MEDIA_MAX_LABEL, canvasMediaKind } from '@/lib/canvas/media'
import { makeMedia } from '@/lib/canvas/engine/defaults'
import type { Point } from '@/lib/canvas/engine/geometry'
import { deleteItems } from '@/lib/canvas/engine/ops'
import { frontKeys, patchScene } from '@/lib/canvas/engine/scene'
import type { CanvasItem, MediaItem } from '@/lib/canvas/types'
import type { CanvasStore } from './store'

export function naturalSize(file: File, kind: 'image' | 'video', url: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const fallback = () => resolve({ w: 640, h: 480 })
    if (kind === 'image') {
      const img = new Image()
      img.onload = () => resolve({ w: img.naturalWidth || 640, h: img.naturalHeight || 480 })
      img.onerror = fallback
      img.src = url
    } else {
      const v = document.createElement('video')
      v.preload = 'metadata'
      v.onloadedmetadata = () => resolve({ w: v.videoWidth || 640, h: v.videoHeight || 480 })
      v.onerror = fallback
      v.src = url
    }
    setTimeout(fallback, 4000)
  })
}

export type Upload = (file: File) => Promise<{ path: string } | { error: string }>

export const uploadTo =
  (canvasId: string): Upload =>
  async (file) => {
    const body = new FormData()
    body.set('file', file)
    try {
      const r = await fetch(`/api/account/canvases/${canvasId}/media`, { method: 'POST', body })
      const j = (await r.json().catch(() => null)) as { path?: string; error?: string } | null
      if (!r.ok || !j?.path) return { error: j?.error ?? 'That file could not be stored.' }
      return { path: j.path }
    } catch {
      return { error: 'That file could not be stored.' }
    }
  }

/**
 * Place files on the canvas around a point: each shows at once from a local
 * preview, as one undo step for the batch, and takes its stored path when its
 * upload lands. One that fails is taken off again. Returns what was refused.
 */
export async function insertMediaFiles(store: CanvasStore, files: readonly File[], at: Point, upload: Upload): Promise<string[]> {
  const refused: string[] = []
  if (store.getState().readOnly) return refused
  const ready: Array<{ file: File; kind: 'image' | 'video'; url: string; size: { w: number; h: number } }> = []
  for (const file of files) {
    const kind = canvasMediaKind(file.type)
    if (!kind) {
      refused.push(`${file.name || 'That file'} is not an image or a video a canvas takes.`)
      continue
    }
    if (file.size > CANVAS_MEDIA_MAX_BYTES) {
      refused.push(`${file.name || 'That file'} is over ${CANVAS_MEDIA_MAX_LABEL}.`)
      continue
    }
    const url = URL.createObjectURL(file)
    ready.push({ file, kind, url, size: await naturalSize(file, kind, url) })
  }
  if (!ready.length) return refused
  const state = store.getState()
  const keys = frontKeys(state.base, ready.length)
  const step = store.snapStep()
  const items: MediaItem[] = ready.map((r, i) => {
    const center = { x: at.x + i * 24, y: at.y + i * 24 }
    const item = makeMedia(r.kind, center, keys[i], { naturalW: r.size.w, naturalH: r.size.h, src: r.url, name: r.file.name })
    return step ? { ...item, x: Math.round(item.x / step) * step, y: Math.round(item.y / step) * step } : item
  })
  store.commit(patchScene(state.base, items), { selection: items.map((it) => it.id), tool: 'select' })
  await Promise.all(
    ready.map(async (r, i) => {
      const result = await upload(r.file)
      const now = store.getState().base.items[items[i].id] as CanvasItem | undefined
      if ('error' in result) {
        refused.push(result.error)
        if (now) store.forget([now.id])
        URL.revokeObjectURL(r.url)
        return
      }
      // Still there (not deleted meanwhile): it now has somewhere to be read from.
      if (now && (now.kind === 'image' || now.kind === 'video')) store.adjust([{ ...now, path: result.path }])
    }),
  )
  return refused
}

export { deleteItems }
