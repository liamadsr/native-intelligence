'use client'

/**
 * The Mac exit on the desktop (docs/plans/cloud-browser.md, C4): this Mac
 * carries the agent's cloud browser's traffic while the browser runs, so sites
 * see the person's own connection. Only the desktop's main window drives it
 * (one exit per Mac, however many windows): at its start, and whenever the
 * person's browser comes up (`browser-up`), it asks the server for an exit
 * ticket and hands it to the app, which checks the token itself (it serves the
 * account it is signed into, and never asks) and holds the tunnel
 * (dial8-desktop browser_exit.rs). At `browser-down` it lets go. No switch:
 * the agent uses the person's network whenever this Mac is online. The
 * computer card shows this Mac's state.
 */
import { getThisWebviewLabel, isDesktopAppForExit, sessionAccessToken, tauriBridge, type BrowserExitStatus } from './browser-exit-bridge'
import { setMacStatus } from './computer-client'

let watching: Promise<boolean> | null = null
/** Fresh tokens fetched because one was refused or ran out: a few, then wait for the next `browser-up`. */
const REFRESHES = { max: 3, windowMs: 10 * 60_000 }
let refreshes: number[] = []

/** Whether this window drives the Mac exit: the desktop's main window, on a desktop that has it. */
function drivesExit(): Promise<boolean> {
  watching ??= (async () => {
    if (!isDesktopAppForExit()) return false
    if ((await getThisWebviewLabel().catch(() => null)) !== 'main') return false
    const status = await tauriBridge.browserExit.status()
    if (!status) return false
    setMacStatus(status)
    tauriBridge.browserExit.onStatus((next: BrowserExitStatus) => {
      setMacStatus(next)
      // The token ran out (or was refused) while the browser may still run: a fresh one, if so, a few times.
      if (!next.needsToken) return
      const now = Date.now()
      refreshes = refreshes.filter(at => now - at < REFRESHES.windowMs)
      if (refreshes.length >= REFRESHES.max) return
      refreshes.push(now)
      void browserUp()
    })
    return true
  })()
  return watching
}

/** The person's browser is up (or this window just opened): connect this Mac's exit to it. */
export async function browserUp(): Promise<void> {
  if (!(await drivesExit())) return
  let ticket: { state?: string; url?: string; token?: string }
  try {
    const device = await tauriBridge.localAgent.device().catch(() => null)
    const deviceId = device && device.ok ? device.value.deviceId : undefined
    const response = await fetch('/api/account/browser/exit', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(deviceId ? { deviceId } : {}) })
    if (!response.ok) return
    ticket = await response.json()
  } catch { return }
  if (ticket.state !== 'running' || !ticket.url || !ticket.token) return
  // The app takes the ticket only for the account it holds the session of: hand it this window's first, so a
  // start that races the app's own sign-in sync (deep-link-handler.tsx) isn't refused, and left that way.
  const session = await sessionAccessToken().catch(() => null)
  if (session) await tauriBridge.setAuthToken(session).catch(() => {})
  await tauriBridge.browserExit.start(ticket.url, ticket.token).catch((error: Error) => console.warn('[browser-exit]', error.message))
}

/** The person's browser stopped: this Mac lets go. */
export async function browserDown(): Promise<void> {
  if (await drivesExit()) await tauriBridge.browserExit.stop()
}

/** Test-only. */
export function __resetBrowserExitForTests() { watching = null; refreshes = [] }
