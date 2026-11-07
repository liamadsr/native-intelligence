/**
 * The main window's half of a spoken ask during a desktop call (one-chat
 * plan, Slice 3/4; lib/live-agent/live-hud.ts LIVE_HUD_ASK_EVENT). On desktop
 * the call's live agent's chat lives in the HUD window, and its store owns the
 * capture's eve session: a second store in the main window would race it
 * (two eve clients on one session) and the HUD would not see the ask or the
 * reply as they stream. So the ask is handed to the HUD, which sends it from
 * its own chat, and this waits to hear how it went:
 *   - no `accepted` within HUD_ASK_ACCEPT_MS (no HUD window, or one on another
 *     call): false, nothing sent;
 *   - `accepted`, then `done` (the reply is in) or `failed`, within
 *     HUD_ASK_REPLY_MS of the accept: true for `done`, false otherwise.
 * Never throws. Desktop only (the Tauri event API, loaded lazily).
 */
import { safeUnlisten, type UnlistenLike } from '@/lib/tauri-unlisten'
import { AGENT_HUD_WINDOW } from './voice-id-hud'
import { LIVE_HUD_ASK_EVENT, LIVE_HUD_ASKED_EVENT, readLiveHudAsked, type LiveHudAsk } from './live-hud'

/** How long the HUD has to say it took the ask (ms). */
export const HUD_ASK_ACCEPT_MS = 3_000
/** How long a taken ask's reply may run before it's given up on here (ms). */
export const HUD_ASK_REPLY_MS = 180_000

let eventApi: Promise<typeof import('@tauri-apps/api/event')> | null = null
const tauriEvent = () => (eventApi ??= import('@tauri-apps/api/event'))

function newId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `ask-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
}

/** Hand a spoken ask to the HUD's chat; resolves whether its reply came in. */
export function askHudWindow(ask: Omit<LiveHudAsk, 'id'>): Promise<boolean> {
  const id = newId()
  return new Promise<boolean>((resolve) => {
    let settled = false
    let off: UnlistenLike | null = null
    let timer: ReturnType<typeof setTimeout> = setTimeout(() => finish(false), HUD_ASK_ACCEPT_MS)
    function finish(ok: boolean) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (off) safeUnlisten(off)
      resolve(ok)
    }
    void tauriEvent()
      .then(async ({ listen, emitTo }) => {
        const unlisten = await listen(LIVE_HUD_ASKED_EVENT, (e: { payload: unknown }) => {
          const asked = readLiveHudAsked(e.payload)
          if (!asked || asked.id !== id || settled) return
          if (asked.state === 'accepted') {
            clearTimeout(timer)
            timer = setTimeout(() => finish(false), HUD_ASK_REPLY_MS)
            return
          }
          finish(asked.state === 'done')
        })
        off = unlisten
        if (settled) {
          safeUnlisten(unlisten)
          return
        }
        const payload: LiveHudAsk = { ...ask, id }
        await emitTo(AGENT_HUD_WINDOW, LIVE_HUD_ASK_EVENT, payload)
      })
      .catch(() => finish(false))
  })
}
