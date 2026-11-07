/**
 * `window.__dial8Automation` (README.md), built from the dashboard's own state
 * (automation-bridge.tsx hands it in), so a test can drive it with stand-ins.
 * Loaded only in the desktop app launched with the automation bridge.
 */
import { AUTOMATION_VERSION } from './flag'
import type { Dial8Automation } from './types'

/** What the API reads and does in the dashboard. */
export interface AutomationDeps {
  workspaceId(): string | null
  signedIn(): Promise<boolean>
  /** The main chat now, by its session (docs/plans/one-chat.md: one chat per workspace). */
  chat(): { chatSessionId: string }
  /** The main chat again from nothing, on a new session (main-chat-context resetChat). */
  resetChat(): void
  /** The main chat a workspace has stored on this device, by its session, or null. */
  storedChat(workspaceId: string): { chatSessionId: string } | null
  /** The main chat's composer, or null. */
  composer(): HTMLTextAreaElement | null
}

export const DEFAULT_READY_TIMEOUT_MS = 30_000
/** How long resetUi waits for each part of the reset to land, in all. */
export const RESET_TIMEOUT_MS = 15_000
const POLL_MS = 50

/** A menu or popover over the page (Radix's, the shell's); some stay in the DOM closed. */
const MENU = '[data-radix-popper-content-wrapper], [role="menu"]'

/** A menu open on screen: not a closed one kept in the DOM (inert, hidden, no size). */
function menuOpen(): boolean {
  for (const el of document.querySelectorAll(MENU)) {
    if (el.closest('[inert], [aria-hidden="true"]')) continue
    const box = el.getBoundingClientRect()
    if (box.width > 0 && box.height > 0) return true
  }
  return false
}

export function createAutomationApi(deps: AutomationDeps): Dial8Automation {
  // Two resets at once would race each other's chat reset: one after the other.
  let resetting: Promise<void> = Promise.resolve()
  return {
    version: AUTOMATION_VERSION,
    info: () => ({
      buildId: process.env.NEXT_PUBLIC_GIT_COMMIT_SHA || null,
      route: window.location.pathname,
      workspaceId: deps.workspaceId(),
    }),
    ready: (opts) => ready(deps, opts?.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS),
    resetUi: () => {
      const run = resetting.catch(() => {}).then(() => resetUi(deps))
      resetting = run
      return run
    },
  }
}

/** Signed in, the workspace loaded, and the chat's composer on screen. */
async function ready(deps: AutomationDeps, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  const left = () => deadline - Date.now()
  let waitingFor = 'sign-in'
  try {
    await until(() => deps.signedIn(), left)
    waitingFor = 'the workspace'
    await until(() => !!deps.workspaceId(), left)
    waitingFor = 'the chat composer'
    await until(() => !!deps.composer(), left)
  } catch (error) {
    if (error instanceof Timeout) throw new Error(`ready() timed out after ${timeoutMs} ms waiting for ${waitingFor}`)
    throw error
  }
}

/**
 * Back to a clean, known UI, the server, the session and settings untouched:
 *   - the main chat on a new session, back on the home thread: no card open,
 *     full screen or docked, no draft, and the old panel's card store gone
 *     with it (the home thread's messages stay: it never starts over);
 *   - an open menu closed.
 * Resolves once all of it has landed, the new chat stored on the device
 * included, so a relaunch comes back to the same chat.
 */
async function resetUi(deps: AutomationDeps): Promise<void> {
  const workspaceId = deps.workspaceId()
  if (!workspaceId) throw new Error('resetUi(): no active workspace yet (await ready() first)')
  const deadline = Date.now() + RESET_TIMEOUT_MS
  const left = () => deadline - Date.now()
  let waitingFor = 'the chat to reset'
  try {
    const before = deps.chat().chatSessionId
    deps.resetChat()
    await until(() => deps.chat().chatSessionId !== before, left)
    const chatSessionId = deps.chat().chatSessionId
    waitingFor = 'the new chat to be stored on the device'
    await until(() => deps.storedChat(workspaceId)?.chatSessionId === chatSessionId, left)
    waitingFor = "the new chat's composer"
    await until(() => deps.composer()?.value === '', left)
    waitingFor = 'open menus to close'
    for (let i = 0; i < 3 && menuOpen(); i++) {
      const target = document.activeElement ?? document.body
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))
      await sleep(150)
    }
  } catch (error) {
    if (error instanceof Timeout) throw new Error(`resetUi() timed out waiting for ${waitingFor}`)
    throw error
  }
}

class Timeout extends Error {}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Poll `check` until it holds, or throw Timeout once `left()` runs out. */
async function until(check: () => boolean | Promise<boolean>, left: () => number): Promise<void> {
  for (;;) {
    if (await check()) return
    if (left() <= 0) throw new Timeout()
    await sleep(Math.min(POLL_MS, left()))
  }
}
