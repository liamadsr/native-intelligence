/**
 * The Code view's coding chat (Liam, 11-16: the coding chat lives in the
 * dashboard as the agent's does: its list on the left, its conversation in
 * the middle, its details on the right): which chat is selected, and that
 * chat as its conversation holds it live.
 *
 *   selected  the coding chat on screen in the Code view (a local agent's
 *             session id), or null: a new one starts with the next send.
 *             The list selects it (page-panel/code-chats.tsx), a send that
 *             starts one selects it (composer-code.tsx), "New chat" clears it.
 *   live      that chat as the conversation in the middle reads it
 *             (code-chat-stage.tsx: the one reader), for the composer (its
 *             send) and the right panel (its status, branch, Stop): no
 *             second read of the same session.
 *
 * One kind of chat whoever does the work (Liam, 11-16: "treat all coding
 * agents the same whether it's NI, claude code, or codex"): nothing here
 * knows the agent.
 *
 * A plain module, so the composer, the list, the stage and the panel never
 * import each other. Flat cost: one object and its listeners. The selected
 * chat is remembered per device and workspace (SELECTED_KEY), so a reload
 * opens the Code view on the chat it showed.
 */
import type { LocalAgentPolicy } from '@/lib/tauri-bridge'
import type { PanelSession } from '@/components/local-agent/session-api'
import { setCodeChatSelected } from '../side-panels/side-panel-store'
import { getClientWorkspaceId } from '@/lib/workspace-fetch'

type Sent = { ok: true } | { ok: false; message: string }

/** The selected chat, live: what its conversation's reader holds. */
export interface CodeChatLive {
  session: PanelSession
  stopping: boolean
  send: (text: string, policy: LocalAgentPolicy, requestId: string) => Promise<Sent>
  stop: () => Promise<Sent>
}

export interface CodeViewState {
  selected: string | null
  /** The selected chat as read, or null until its first read (and with none selected). */
  live: CodeChatLive | null
  /** The selected chat could not be read (it is gone, or not this person's): why, in a line. Null otherwise. */
  error: string | null
  /** Counts the tries at reading the selected chat: picking a chat that could not be read reads it again. */
  attempt: number
}

/** Remembered per device: the selected coding chat, by workspace (`<prefix><workspace id>` → session id). */
export const SELECTED_KEY_PREFIX = 'ni:code-view:selected:'

function selectedKey(): string | null {
  const workspaceId = getClientWorkspaceId()
  return workspaceId ? `${SELECTED_KEY_PREFIX}${workspaceId}` : null
}

function readSelected(): string | null {
  try {
    const key = typeof window === 'undefined' ? null : selectedKey()
    const value = key ? window.localStorage.getItem(key) : null
    return value && /^[\w-]{1,64}$/.test(value) ? value : null
  } catch {
    return null
  }
}

function writeSelected(sessionId: string | null): void {
  try {
    const key = selectedKey()
    if (!key) return
    if (sessionId) window.localStorage.setItem(key, sessionId)
    else window.localStorage.removeItem(key)
  } catch {
    // Storage blocked or full: it holds in memory for this session.
  }
}

let state: CodeViewState = { selected: null, live: null, error: null, attempt: 0 }
const listeners = new Set<() => void>()

function set(next: CodeViewState): void {
  state = next
  for (const listener of [...listeners]) listener()
}

export function subscribeCodeView(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Stable between changes (useSyncExternalStore). */
export function getCodeView(): CodeViewState {
  return state
}

/** The workspace the selection belongs to (undefined: not placed yet, this load). */
let syncedFor: string | null | undefined

/**
 * Place the selection in the window's workspace (the Code view's middle asks
 * on every mount and workspace change: code-chat-stage.tsx). Kept here, not
 * in a component: the chat panel remounts on a workspace switch, so nothing
 * of its own would see the switch. In another workspace than last time the
 * selection goes (its chats are not this one's; it stays remembered there),
 * and this workspace's remembered chat comes back. Never over a chat picked
 * meanwhile in the same workspace.
 */
export function syncCodeViewWorkspace(): void {
  const workspaceId = getClientWorkspaceId() ?? null
  if (syncedFor === workspaceId) return
  const moved = syncedFor !== undefined
  syncedFor = workspaceId
  if (moved && state.selected) {
    setCodeChatSelected(false)
    set({ selected: null, live: null, error: null, attempt: 0 })
  }
  if (state.selected) return
  const remembered = readSelected()
  if (!remembered) return
  setCodeChatSelected(true)
  set({ selected: remembered, live: null, error: null, attempt: 0 })
}

/** Select a coding chat by its session, or none (null: the next send starts a new one). */
export function selectCodeChat(sessionId: string | null): void {
  if (state.selected === sessionId) {
    // The chat on screen could not be read: picking it again is another try.
    if (sessionId && state.error) {
      writeSelected(sessionId)
      set({ selected: sessionId, live: null, error: null, attempt: state.attempt + 1 })
    }
    return
  }
  writeSelected(sessionId)
  setCodeChatSelected(sessionId !== null)
  set({ selected: sessionId, live: null, error: null, attempt: 0 })
}

/** The conversation's reader says what it holds for `sessionId` (null: nothing yet, or it went). Another chat's is dropped. */
export function setCodeChatLive(sessionId: string, live: CodeChatLive | null): void {
  if (state.selected !== sessionId) return
  const was = state.live
  if (was === live) return
  if (was && live && was.session === live.session && was.stopping === live.stopping && was.send === live.send && was.stop === live.stop) return
  set({ ...state, live, error: live ? null : state.error })
}

/**
 * The selected chat could not be read: the right panel says so instead of
 * waiting (code-chat-sections.tsx) and the composer starts a new chat. `gone`
 * (the chat no longer exists): it is no longer the chat a reload comes back
 * to. A read that only failed (the server out of reach) keeps it remembered.
 */
export function setCodeChatError(sessionId: string, message: string, gone: boolean): void {
  if (state.selected !== sessionId || state.error === message) return
  if (gone) writeSelected(null)
  set({ ...state, live: null, error: message })
}

/**
 * The open chat a send would go to, as one string that changes only when what
 * the composer shows of it does (its id, status and agent): the chat panel
 * reads this, not the whole store, so a streaming chat's every update does not
 * re-render it. Null: no chat is open to message.
 */
export function openCodeChatKey(): string | null {
  const { selected, live } = state
  if (!selected || !live || live.session.id !== selected) return null
  return `${selected}\n${live.session.status}\n${live.session.worker ?? ''}`
}

export function __resetCodeViewForTests(): void {
  state = { selected: null, live: null, error: null, attempt: 0 }
  syncedFor = undefined
  listeners.clear()
}
