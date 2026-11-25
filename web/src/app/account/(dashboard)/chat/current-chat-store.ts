/**
 * Home's current chat (docs/plans/one-home.md; Liam, 11-25: "I want to unify
 * everything so you only have one homepage view"): the one thing that decides
 * what the middle, the composer and the right panel show.
 *
 *   agent     the person's own agent's chat: the default, and where "back to
 *             my agent" lands.
 *   code      a coding chat (a local agent's session), by its id.
 *   code-new  a new coding chat: nothing sent yet, the next send starts it.
 *
 * The one writer. Everything that moves the current chat (the composer's
 * toggle, a row in Recent, a job's line, a notification…) asks here, so the
 * composer, the panels and the middle can never disagree about which chat is
 * on screen.
 *
 *   Per workspace   a coding chat belongs to its workspace: in another one
 *                   the current chat is that workspace's own, or the agent
 *                   (syncCurrentChatWorkspace).
 *   A reload        comes back on the chat this window was on (kept in
 *                   sessionStorage per workspace; one-home-decisions.ts
 *                   RELOAD_RESTORES). A new window opens on the agent.
 *   The agent       while the person is on another chat: whether a reply of
 *                   its finished unseen (the pinned row's dot).
 *
 * What it still stands on, until the plan's last phase folds them in:
 *   - the coding chat it holds is code-view-store.ts's `selected` (the
 *     conversation's reader publishes that chat's `live` there);
 *   - side-panel-store.ts's `codeView` and `codeChat` are its mirror, never
 *     written by anyone else.
 *
 * A plain module. Flat cost: a few values, one cached object, its listeners.
 */
import { closeFrontCards } from '@/components/chat-cards/front-card'
import { getClientWorkspaceId } from '@/lib/workspace-fetch'
import { setCodeView } from '../side-panels/side-panel-store'
import { getCodeView, selectCodeChat, subscribeCodeView } from './code-view-store'
import { CODE_PRESS_STARTS_NEW, RELOAD_RESTORES } from './one-home-decisions'

export type CurrentChat = { kind: 'agent' } | { kind: 'code'; sessionId: string } | { kind: 'code-new' }

export type CurrentChatKind = CurrentChat['kind']

const AGENT: CurrentChat = { kind: 'agent' }
const CODE_NEW: CurrentChat = { kind: 'code-new' }

/** The current chat from its two parts: on the coding side or not, and the coding chat held. Pure. */
export function currentChatOf(onCode: boolean, selected: string | null): CurrentChat {
  if (!onCode) return AGENT
  return selected ? { kind: 'code', sessionId: selected } : CODE_NEW
}

/** A chat's one key: what its row, its draft and its memory go by. */
export function chatKey(chat: CurrentChat): string {
  return chat.kind === 'code' ? `code:${chat.sessionId}` : chat.kind
}

/** The person is on the coding side (a coding chat, or a new one). */
let onCode = false
/** A reply of the agent's finished while the person was on another chat. */
let agentUnseen = false
const listeners = new Set<() => void>()
let cache: { onCode: boolean; selected: string | null; chat: CurrentChat } = { onCode: false, selected: null, chat: AGENT }

function emit(): void {
  for (const listener of [...listeners]) listener()
}

// ── This window's memory (a reload) ─────────────────────────────────────────

/** Kept for the window's session, per workspace: `<prefix><workspace id>` → a session id, or `new`. Absent: the agent. */
export const CURRENT_CHAT_KEY_PREFIX = 'ni:current-chat:'
const NEW = 'new'

function memoryKey(): string | null {
  const workspaceId = getClientWorkspaceId()
  return workspaceId ? `${CURRENT_CHAT_KEY_PREFIX}${workspaceId}` : null
}

function remember(chat: CurrentChat): void {
  if (RELOAD_RESTORES !== 'window') return
  try {
    const key = typeof window === 'undefined' ? null : memoryKey()
    if (!key) return
    if (chat.kind === 'agent') window.sessionStorage.removeItem(key)
    else window.sessionStorage.setItem(key, chat.kind === 'code' ? chat.sessionId : NEW)
  } catch {
    // Storage blocked or full: a reload opens on the agent.
  }
}

function remembered(): CurrentChat {
  if (RELOAD_RESTORES !== 'window') return AGENT
  try {
    const key = typeof window === 'undefined' ? null : memoryKey()
    const value = key ? window.sessionStorage.getItem(key) : null
    if (value === NEW) return CODE_NEW
    return value && /^[\w-]{1,64}$/.test(value) ? { kind: 'code', sessionId: value } : AGENT
  } catch {
    return AGENT
  }
}

// ── The one writer ──────────────────────────────────────────────────────────

/** Where a move came from ('recents', 'composer', 'notification'…), and what it leaves alone. */
export interface CurrentChatFrom {
  from?: string
  /** Leave a full-screen card in front where it is (a restore: nothing the person pressed). */
  keepCards?: boolean
}

function apply(next: CurrentChat, opts: CurrentChatFrom, save = true): void {
  const was = getCurrentChat()
  // A coding chat draws where the thread stands: a full-screen card would cover it.
  if (next.kind !== 'agent' && !opts.keepCards) closeFrontCards()
  if (next.kind !== 'agent') selectCodeChat(next.kind === 'code' ? next.sessionId : null)
  const nextOnCode = next.kind !== 'agent'
  if (next.kind === 'agent' && agentUnseen) agentUnseen = false
  if (onCode !== nextOnCode) {
    onCode = nextOnCode
    // The panels' mirror (side-panel-store.ts): they read the current chat through it for now.
    setCodeView(nextOnCode)
  }
  if (save) remember(next)
  if (chatKey(was) !== chatKey(getCurrentChat()) || next.kind === 'agent') emit()
}

/** Stable between changes (useSyncExternalStore). */
export function getCurrentChat(): CurrentChat {
  const selected = getCodeView().selected
  if (cache.onCode !== onCode || cache.selected !== selected) cache = { onCode, selected, chat: currentChatOf(onCode, selected) }
  return cache.chat
}

export function currentChatKind(): CurrentChatKind {
  return getCurrentChat().kind
}

/** The current chat is not the agent's (a coding chat, or a new one). */
export function isOnCode(): boolean {
  return onCode
}

/** Hears every change of the current chat: its kind, which coding chat, the agent's unseen reply. */
export function subscribeCurrentChat(listener: () => void): () => void {
  listeners.add(listener)
  const offCodeView = subscribeCodeView(listener)
  return () => {
    listeners.delete(listener)
    offCodeView()
  }
}

/** Make a coding chat the current chat, from anywhere. The one way in. */
export function openCodingChat(sessionId: string, opts: CurrentChatFrom = {}): void {
  if (!sessionId) return
  apply({ kind: 'code', sessionId }, opts)
}

/** A new coding chat: nothing selected, the next send starts one. */
export function newCodingChat(opts: CurrentChatFrom = {}): void {
  apply(CODE_NEW, opts)
}

/**
 * The composer's Code side pressed: a new coding chat (one-home-decisions.ts
 * CODE_PRESS_STARTS_NEW; the other choice: the coding chat the person was
 * last on comes back).
 */
export function pressCode(opts: CurrentChatFrom = {}): void {
  const held = getCodeView().selected
  if (CODE_PRESS_STARTS_NEW || !held) newCodingChat(opts)
  else openCodingChat(held, opts)
}

/** Back to the person's agent. */
export function backToAgent(opts: CurrentChatFrom = {}): void {
  apply(AGENT, opts)
}

/** One call for a caller that holds the chat it wants. */
export function setCurrentChat(next: CurrentChat, opts: CurrentChatFrom = {}): void {
  apply(next.kind === 'code' && !next.sessionId ? AGENT : next, opts)
}

/**
 * The coding chat on screen is gone (deleted, or not this person's): it is
 * no longer the chat a reload comes back to. The chat stays on screen, saying
 * so (code-view-store.ts setCodeChatError).
 */
export function forgetCodingChat(sessionId: string): void {
  const chat = remembered()
  if (chat.kind === 'code' && chat.sessionId === sessionId) remember(AGENT)
}

// ── Per workspace ───────────────────────────────────────────────────────────

/** The workspace the current chat belongs to (undefined: not placed yet, this load). */
let syncedFor: string | null | undefined

/**
 * Place the current chat in the window's workspace (the middle asks on every
 * mount and workspace change: code-chat-stage.tsx). Kept here, not in a
 * component: the chat panel remounts on a workspace switch, so nothing of its
 * own would see the switch. In another workspace than last time, that
 * workspace's own chat comes back (its coding chats are not this one's), or
 * the agent. On the first placing of a load: the chat this window was on.
 * Never over a chat picked meanwhile in the same workspace.
 */
export function syncCurrentChatWorkspace(): void {
  const workspaceId = getClientWorkspaceId() ?? null
  if (syncedFor === workspaceId) return
  const moved = syncedFor !== undefined
  syncedFor = workspaceId
  // Something already moved it in this workspace's first moments (a link): it stands.
  if (!moved && onCode) return
  // A restore, not a press: a card in front stays, and the memory is as it was.
  apply(remembered(), { from: 'workspace', keepCards: true }, false)
  if (!onCode) selectCodeChat(null)
}

// ── The agent, while the person is elsewhere ────────────────────────────────

/** A reply of the agent's finished (the chat says so: chat-feed.tsx): unseen while another chat is current. */
export function noteAgentReplied(): void {
  if (!onCode || agentUnseen) return
  agentUnseen = true
  emit()
}

/** A reply of the agent's finished while the person was on another chat, and they have not been back. */
export function agentHasUnseenReply(): boolean {
  return agentUnseen
}

export function __resetCurrentChatForTests(): void {
  onCode = false
  agentUnseen = false
  syncedFor = undefined
  cache = { onCode: false, selected: null, chat: AGENT }
  listeners.clear()
  setCodeView(false)
}
