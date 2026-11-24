// How the Studio page hands a take's script and checklist to the floating control (a separate window of the desktop
// app): the control asks (`studio-prompter://hello` with its take's session) and the page answers with the content
// (`studio-prompter://content`). Window to window inside the app, nothing else: no Rust side, never off this
// computer. A copy also sits in this origin's localStorage for the control to read on its own if the page can't
// answer (it was written before the take started), keyed by the take's session and removed when the take ends.
import type { ChecklistItem } from './checklist'
import type { ScriptLine } from './follow'

export const HELLO_EVENT = 'studio-prompter://hello'
export const CONTENT_EVENT = 'studio-prompter://content'

/** Whether the words come live: `on`; not without Local transcription (`no-local`); an older desktop (`old-app`); a
 *  browser recording, which has no on-device words (`browser`). */
export type Following = 'on' | 'no-local' | 'old-app' | 'browser'
export type PrompterHandoff = { sessionId: string; lines: ScriptLine[]; items: ChecklistItem[]; following: Following }

const KEY_PREFIX = 'ni:studio:prompter-take:'
export const handoffKey = (sessionId: string) => `${KEY_PREFIX}${sessionId}`

const FOLLOWING: Following[] = ['on', 'no-local', 'old-app', 'browser']
export function isHandoff(raw: unknown): raw is PrompterHandoff {
  if (!raw || typeof raw !== 'object') return false
  const h = raw as Record<string, unknown>
  return typeof h.sessionId === 'string' && FOLLOWING.includes(h.following as Following)
    && Array.isArray(h.lines) && h.lines.every((l) => !!l && typeof (l as ScriptLine).text === 'string')
    && Array.isArray(h.items) && h.items.every((i) => !!i && typeof (i as ChecklistItem).id === 'string' && typeof (i as ChecklistItem).text === 'string')
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { readonly length: number; key(index: number): string | null }
const store = (): Store | null => { try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null } }

export function writeHandoff(handoff: PrompterHandoff, s: Store | null = store()): void {
  try { s?.setItem(handoffKey(handoff.sessionId), JSON.stringify(handoff)) } catch { /* the event still carries it */ }
}

export function readHandoff(sessionId: string, s: Store | null = store()): PrompterHandoff | null {
  try {
    const raw = s?.getItem(handoffKey(sessionId))
    const value: unknown = raw ? JSON.parse(raw) : null
    return isHandoff(value) && value.sessionId === sessionId ? value : null
  } catch { return null }
}

/** Remove a take's copy (its take ended or was cancelled); with no session, every copy left behind. */
export function dropHandoff(sessionId: string | null, s: Store | null = store()): void {
  try {
    if (!s) return
    if (sessionId) { s.removeItem(handoffKey(sessionId)); return }
    const keys: string[] = []
    for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k?.startsWith(KEY_PREFIX)) keys.push(k) }
    for (const k of keys) s.removeItem(k)
  } catch { /* nothing to keep clean */ }
}

type Events = {
  emit: (event: string, payload: unknown) => Promise<void>
  listen: (event: string, cb: (e: { payload: unknown }) => void) => Promise<() => void>
}
const tauriEvents = async (): Promise<Events | null> => {
  try { return await import('@tauri-apps/api/event') as unknown as Events } catch { return null }
}

/** Listen for `event`; the returned function stops (safe before the listener is set up). */
function on(event: string, cb: (payload: unknown) => void, events: Promise<Events | null>): () => void {
  let stop: (() => void) | null = null, stopped = false
  void events.then(async (e) => {
    if (!e || stopped) return
    try {
      const off = await e.listen(event, ({ payload }) => cb(payload))
      if (stopped) off(); else stop = off
    } catch { /* not in the desktop app */ }
  })
  return () => { stopped = true; stop?.() }
}

/** The Studio page's side: answer each hello for `sessionId` with `current()`. */
export function answerHellos(sessionId: string, current: () => PrompterHandoff | null, events: Promise<Events | null> = tauriEvents()): () => void {
  return on(HELLO_EVENT, (payload) => {
    if ((payload as { sessionId?: unknown } | null)?.sessionId !== sessionId) return
    const handoff = current()
    if (handoff) void events.then((e) => e?.emit(CONTENT_EVENT, handoff).catch(() => {}))
  }, events)
}

/** The page's side: send the content now (when it changes during the take). */
export async function sendContent(handoff: PrompterHandoff, events: Promise<Events | null> = tauriEvents()): Promise<void> {
  try { await (await events)?.emit(CONTENT_EVENT, handoff) } catch { /* the control asks again */ }
}

/** The control's side: ask (again) for its take's content; answers reach `askForContent`'s listener. */
export function sayHello(sessionId: string, events: Promise<Events | null> = tauriEvents()): void {
  void events.then((e) => e?.emit(HELLO_EVENT, { sessionId }).catch(() => {}))
}

/** The control's side: ask for its take's content, and take each answer. */
export function askForContent(sessionId: string, cb: (handoff: PrompterHandoff) => void, events: Promise<Events | null> = tauriEvents()): () => void {
  const off = on(CONTENT_EVENT, (payload) => { if (isHandoff(payload) && payload.sessionId === sessionId) cb(payload) }, events)
  sayHello(sessionId, events)
  return off
}
