/** Copy, cut and paste for the canvas: through the browser's clipboard events, and through the menu. */
import { itemText, makeText } from '@/lib/canvas/engine/defaults'
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

/** Take a paste event's clipboard. Returns true when something was pasted. */
export function readPaste(store: CanvasStore, data: DataTransfer | null, inPlace: boolean): boolean {
  if (!data) return false
  const raw = data.getData(FRAGMENT_MIME)
  const fragment = raw ? parseFragment(raw) : parseFragment(data.getData('text/plain'))
  if (fragment) {
    store.pasteFragment(fragment, inPlace)
    return true
  }
  const text = data.getData('text/plain')
  if (text) {
    pasteText(store, text)
    return true
  }
  return false
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
  const fromText = text ? parseFragment(text) : null
  if (fromText) return store.pasteFragment(fromText, inPlace)
  // The clipboard still holds what this editor put there (or cannot be read): paste the fragment.
  if (mine && (!text || text === (plainOf(mine) || ' '))) return store.pasteFragment(mine, inPlace)
  if (text) pasteText(store, text)
}
