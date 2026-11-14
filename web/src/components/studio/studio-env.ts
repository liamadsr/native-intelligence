/**
 * What the Studio's editor needs to know about living inside the app, in one place.
 *
 * The editor was written as a page of its own: it listened for keys on the whole window, drew its menus straight
 * into the document, and asked its server at the root. Here it is one page among the app's, so:
 *
 *   studioKeys      its keyboard and right-click handlers hear an event only while the Studio is what the person
 *                   is using: the Studio is on screen, and the event did not come from a field elsewhere in the
 *                   app (the chat's composer under an open page, a dialog). Space must not start playback while
 *                   someone types a message.
 *   studioPortal    its menus, popovers and dialogs are drawn in a layer of its own at the end of the document,
 *                   which wears the Studio's class so its stylesheet (ui/studio.css) reaches them.
 *   STUDIO_API      where its server is.
 *   studioFileBase  where a workspace's stored files (media, exports, thumbnails) are read from.
 *
 * Client-only.
 */

/** The Studio's API (src/app/api/account/studio). */
export const STUDIO_API = '/api/account/studio'

/** Where one workspace's Studio files are served from: `<base><key>`, e.g. `…/assets/<sha256>.mp4`. */
export const studioFileBase = (workspaceId: string) => `${STUDIO_API}/file/${workspaceId}/`

let workspace: string | null = null

/** The workspace the Studio is open in (studio-root.tsx sets it): what it hands to the app's own surfaces, such as the agent's chat. */
export function setStudioWorkspace(workspaceId: string | null): void {
  workspace = workspaceId
}
export const studioWorkspaceId = (): string | null => workspace

let root: HTMLElement | null = null
let portal: HTMLElement | null = null
/**
 * Every Studio root mounted now. More than one can be (a Studio card in two places at once, or one remounting while
 * the old one goes): the shared layer stays while any of them does, and `root` is the newest one still in the page.
 */
const roots = new Set<HTMLElement>()

/** Forget roots no longer in the page; the layer goes with the last of them. */
function prune(): void {
  for (const element of roots) if (!element.isConnected) roots.delete(element)
  if (root && !roots.has(root)) root = [...roots].at(-1) ?? null
  if (!roots.size && portal) {
    portal.remove()
    portal = null
  }
}

/**
 * A Studio root mounted (studio-root.tsx's ref), or one went (null: React does not say which). A root that went is
 * still in the page while React detaches its ref, so the roots are counted again just after, when it is gone: one
 * Studio closing never takes the layer, and a dialog open in it, from another.
 */
export function setStudioRoot(element: HTMLElement | null): void {
  if (element) {
    roots.add(element)
    root = element
    return
  }
  queueMicrotask(prune)
}

/** The layer the Studio's menus, popovers and dialogs are drawn in. */
export function studioPortal(): HTMLElement {
  if (portal && portal.isConnected) return portal
  portal = document.createElement('div')
  // display: contents, so the layer is no box of its own: what is drawn in it places itself.
  portal.className = 'ni-studio ni-studio-portal'
  portal.dataset.studioPortal = ''
  document.body.appendChild(portal)
  return portal
}

const isField = (element: Element) =>
  element instanceof HTMLInputElement ||
  element instanceof HTMLTextAreaElement ||
  element instanceof HTMLSelectElement ||
  (element instanceof HTMLElement && element.isContentEditable)

/** Whether an event is the Studio's to handle: it is on screen, and the event is not from somewhere else in the app. */
export function studioHears(event: Event): boolean {
  if (!root || !root.isConnected) return false
  // Not laid out (a page minimized or behind another): nothing of the Studio's is in use.
  if (root.getClientRects().length === 0) return false
  const target = event.target
  if (!(target instanceof Element)) return true
  if (root.contains(target) || (portal?.contains(target) ?? false)) return true
  if (event.type === 'contextmenu') return false
  // A key pressed with the focus on nothing in particular is the Studio's; one typed into a field of the app's is not.
  if (target === document.body || target === document.documentElement) return true
  return !isField(target) && !target.closest('[role="dialog"], [role="menu"], [role="listbox"], [contenteditable="true"]')
}

type KeyType = 'keydown' | 'keyup' | 'contextmenu'
type Handler = (event: never) => void
const wrapped = new WeakMap<Handler, Map<string, EventListener>>()

const slot = (type: KeyType, options?: boolean | AddEventListenerOptions) =>
  `${type}:${typeof options === 'boolean' ? options : !!options?.capture}`

/**
 * `window.addEventListener` for the Studio's keyboard and right-click handlers, with the one difference that a
 * handler only hears what studioHears lets through. Same call shape, so a handler is removed as it was added.
 */
export const studioKeys = {
  addEventListener<E extends Event>(type: KeyType, handler: (event: E) => void, options?: boolean | AddEventListenerOptions): void {
    const key = slot(type, options)
    let byKey = wrapped.get(handler as Handler)
    if (!byKey) wrapped.set(handler as Handler, (byKey = new Map()))
    if (byKey.has(key)) return
    const listener: EventListener = (event) => {
      if (studioHears(event)) handler(event as E)
    }
    byKey.set(key, listener)
    window.addEventListener(type, listener, options)
  },
  removeEventListener<E extends Event>(type: KeyType, handler: (event: E) => void, options?: boolean | EventListenerOptions): void {
    const key = slot(type, options)
    const byKey = wrapped.get(handler as Handler)
    const listener = byKey?.get(key)
    if (!listener) return
    byKey!.delete(key)
    window.removeEventListener(type, listener, options)
  },
}

/**
 * The parts of the Studio beyond editing that need something set up on the server (a provider's key, a tool in
 * the worker). The server says which it has when the Studio opens (GET /bootstrap, `capabilities`); a part it
 * does not have draws no button, rather than one that fails when pressed.
 */
export const STUDIO_CAPABILITIES = ['sound', 'motionCheck', 'review', 'productUi', 'cutouts', 'generatedShots', 'voiceover', 'costs', 'codeScenes'] as const
export type StudioCapability = (typeof STUDIO_CAPABILITIES)[number]

let capabilities: ReadonlySet<string> = new Set()

/** What the server said it can do (anything it did not name is off). */
export function setStudioCapabilities(value: unknown): void {
  const on = value && typeof value === 'object' ? Object.entries(value as Record<string, unknown>).filter(([, v]) => v === true).map(([k]) => k) : []
  capabilities = new Set(on)
}
export const studioCan = (capability: StudioCapability): boolean => capabilities.has(capability)

/**
 * How the editor's preview draws code scenes: in their locked frame when the server runs them, otherwise as labelled
 * boxes whose code (and the frame's runtime) is never loaded. Until the server has said, it is the box.
 */
export const previewCodeScenes = (): 'run' | 'placeholder' => (studioCan('codeScenes') ? 'run' : 'placeholder')

/**
 * Keep a menu that opens beside its button inside the Studio: when it would run off the right edge of the Studio
 * (the card clips there), shift it left by that much. Used as the menu list's `ref`, so it runs as the list mounts.
 */
export function fitMenu(list: HTMLElement | null): void {
  if (!list) return
  list.style.transform = ''
  const bounds = (list.closest('.ni-studio-root') ?? document.documentElement).getBoundingClientRect()
  const over = list.getBoundingClientRect().right - (bounds.right - 8)
  if (over > 0) list.style.transform = `translateX(${-Math.round(over)}px)`
}
