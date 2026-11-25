/**
 * The current coding chat, live (docs/plans/one-home.md; it was the Code
 * view's own store, code-chat-live.ts, before Home had one current chat):
 * the chat its conversation's reader holds, for the composer and the panel.
 *
 *   selected  the coding chat Home's current chat names (a local agent's
 *             session id), or null. Home's current chat is its one writer
 *             (current-chat-store.ts, the only caller of selectCodeChat):
 *             which chat is on screen, across a reload and per workspace, is
 *             decided there.
 *   live      that chat as the conversation in the middle reads it
 *             (code-chat-stage.tsx: the one reader), for the composer (its
 *             send) and the right panel (its status, branch, Stop): no
 *             second read of the same session.
 *
 * One kind of chat whoever does the work (Liam, 11-16: "treat all coding
 * agents the same whether it's NI, claude code, or codex"): nothing here
 * knows the agent.
 *
 * A plain module, so the composer, the stage and the panel never import each
 * other. Flat cost: one object and its listeners.
 */
import type { LocalAgentPolicy } from '@/lib/tauri-bridge'
import type { PanelSession } from '@/components/local-agent/session-api'

type Sent = { ok: true } | { ok: false; message: string }

/** The selected chat, live: what its conversation's reader holds. */
export interface CodeChatLive {
  session: PanelSession
  stopping: boolean
  send: (text: string, policy: LocalAgentPolicy, requestId: string) => Promise<Sent>
  stop: () => Promise<Sent>
  /** A question is open on the Mac (the person answers it there): no pull request offer meanwhile. */
  promptOpen: boolean
  /** Its branch as last committed holds no change: nothing to open a pull request for. */
  noChanges: boolean
  /** How many files its branch changed, as its last branch card said; null when unknown. */
  filesChanged: number | null
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

/** Select a coding chat by its session, or none (null: the next send starts a new one). */
export function selectCodeChat(sessionId: string | null): void {
  if (state.selected === sessionId) {
    // The chat on screen could not be read: picking it again is another try.
    if (sessionId && state.error) {
      set({ selected: sessionId, live: null, error: null, attempt: state.attempt + 1 })
    }
    return
  }
  set({ selected: sessionId, live: null, error: null, attempt: 0 })
}

/** The conversation's reader says what it holds for `sessionId` (null: nothing yet, or it went). Another chat's is dropped. */
export function setCodeChatLive(sessionId: string, live: CodeChatLive | null): void {
  if (state.selected !== sessionId) return
  const was = state.live
  if (was === live) return
  if (
    was &&
    live &&
    was.session === live.session &&
    was.stopping === live.stopping &&
    was.send === live.send &&
    was.stop === live.stop &&
    was.promptOpen === live.promptOpen &&
    was.noChanges === live.noChanges &&
    was.filesChanged === live.filesChanged
  )
    return
  set({ ...state, live, error: live ? null : state.error })
}

/**
 * The selected chat could not be read: the right panel says so instead of
 * waiting (code-chat-sections.tsx) and the composer starts a new chat. A chat
 * that is gone is also forgotten as the one a reload comes back to
 * (current-chat-store.ts forgetCodingChat; the middle says which).
 */
export function setCodeChatError(sessionId: string, message: string): void {
  if (state.selected !== sessionId || state.error === message) return
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
  listeners.clear()
}
