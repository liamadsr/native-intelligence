/** Copy, cut and paste for the canvas: through the browser's clipboard events, and through the menu. */
import { itemText, makeRecord, makeText } from '@/lib/canvas/engine/defaults'
import { fromExcalidraw, parseExcalidraw } from '@/lib/canvas/engine/excalidraw'
import { DEEP_LINK_TYPES } from '@/lib/entities/entity-actions-registry'
import { isMentionableType } from '@/lib/entity-links/mentionable'
import { frontKey, patchScene } from '@/lib/canvas/engine/scene'
import { parseFragment, type CanvasStore, type Fragment } from './store'

export const FRAGMENT_MIME = 'application/x-ni-canvas'

const plainOf = (f: Fragment): string =>
  f.items
    .map((it) => itemText(it))
    .filter(Boolean)
    .join('\n')

/** Fill a copy event's clipboard from the selection. Returns false with nothing selected. */
export function writeCopy(store: CanvasStore, data: DataTransfer | null): boolean {
  const fragment = store.copyFragment()
  if (!fragment || !data) return false
  data.setData(FRAGMENT_MIME, JSON.stringify(fragment))
  data.setData('text/plain', plainOf(fragment))
  return true
}

/** Words pasted onto the canvas become a wrapped text box in the middle of the view. */
export function pasteText(store: CanvasStore, text: string): void {
  const words = text.replace(/\r\n/g, '\n').trim()
  if (!words || store.getState().readOnly) return
  const state = store.getState()
  const c = store.viewCenter()
  const long = words.length > 40 || words.includes('\n')
  const width = long ? 320 : undefined
  const item = { ...makeText({ x: c.x - (width ?? 80) / 2, y: c.y - 14 }, frontKey(state.base), { width, plain: words, text: state.defaults.text }) }
  store.commit(patchScene(state.base, [item]), { selection: [item.id], tool: 'select' })
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The record a pasted link of this app points at (`/account?document=<id>`),
 * or null. Only this app's own address, and only kinds that can be linked.
 */
export function recordFromLink(text: string, origin: string): { type: string; id: string } | null {
  const t = text.trim()
  if (!t || /\s/.test(t) || t.length > 400) return null
  let url: URL
  try {
    url = new URL(t)
  } catch {
    return null
  }
  if (url.origin !== origin || !url.pathname.startsWith('/account')) return null
  for (const [key, value] of url.searchParams) {
    if (key !== 'canvas' && (DEEP_LINK_TYPES as readonly string[]).includes(key) && isMentionableType(key) && UUID.test(value)) return { type: key, id: value }
  }
  return null
}

/** Put a record's card in the middle of the view, in front. */
export function insertRecord(store: CanvasStore, ref: { type: string; id: string; label?: string }, at = store.viewCenter()): void {
  const state = store.getState()
  if (state.readOnly) return
  const item = makeRecord(at, frontKey(state.base), ref)
  store.commit(patchScene(state.base, [item]), { selection: [item.id], tool: 'select' })
}

/** Words pasted on the canvas: an Excalidraw selection, a link to a record, or just words. */
function pasteWords(store: CanvasStore, text: string, inPlace: boolean): boolean {
  const fragment = parseFragment(text)
  if (fragment) {
    store.pasteFragment(fragment, inPlace)
    return true
  }
  const drawn = parseExcalidraw(text)
  if (drawn) {
    const items = fromExcalidraw(drawn)
    if (items.length) store.pasteFragment({ kind: 'ni-canvas-fragment', source: 'excalidraw', items }, inPlace)
    else store.notify?.('Nothing in that Excalidraw selection can be placed on a canvas.')
    return true
  }
  const ref = typeof window !== 'undefined' ? recordFromLink(text, window.location.origin) : null
  if (ref) {
    insertRecord(store, ref)
    return true
  }
  if (text.trim()) {
    pasteText(store, text)
    return true
  }
  return false
}

/** The image and video files on a clipboard or in a drop. */
export function mediaFiles(data: DataTransfer | null): File[] {
  if (!data) return []
  return [...data.files].filter((f) => f.type.startsWith('image/') || f.type.startsWith('video/'))
}

/** Take a paste event's clipboard. Returns true when something was pasted. Files are the caller's (they upload). */
export function readPaste(store: CanvasStore, data: DataTransfer | null, inPlace: boolean): boolean {
  if (!data) return false
  const raw = data.getData(FRAGMENT_MIME)
  const fragment = raw ? parseFragment(raw) : null
  if (fragment) {
    store.pasteFragment(fragment, inPlace)
    return true
  }
  return pasteWords(store, data.getData('text/plain'), inPlace)
}

/** Copy from the menu: the fragment is kept here, the words go to the system clipboard. */
export async function menuCopy(store: CanvasStore): Promise<boolean> {
  const fragment = store.copyFragment()
  if (!fragment) return false
  try {
    await navigator.clipboard.writeText(plainOf(fragment) || ' ')
  } catch {
    // No clipboard permission: a paste from the menu still works in this editor.
  }
  return true
}

/** Paste from the menu: what was copied here, or else the words on the system clipboard. */
export async function menuPaste(store: CanvasStore, inPlace: boolean): Promise<void> {
  const mine = store.lastFragment()
  let text = ''
  try {
    text = await navigator.clipboard.readText()
  } catch {
    text = ''
  }
  // The clipboard still holds what this editor put there (or cannot be read): paste the fragment.
  if (mine && (!text || text === (plainOf(mine) || ' '))) return store.pasteFragment(mine, inPlace)
  if (text) pasteWords(store, text, inPlace)
}
