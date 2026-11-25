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
 * The one writer. Everything that used to move the Code view by itself (the
 * composer's tab, a Recent row, the coding chats' list, a job's line) asks
 * here, so the composer, the panels and the middle can never disagree about
 * which chat is on screen.
 *
 * What it still stands on, until the plan's later phases fold them in:
 *   - the coding chat it holds is code-view-store.ts's `selected` (the
 *     conversation's reader publishes that chat's `live` there);
 *   - side-panel-store.ts's `codeView` and `codeChat` are its mirror, never
 *     written by anyone else.
 *
 * A plain module. Flat cost: one boolean, one cached object, its listeners.
 */
import { setCodeView } from '../side-panels/side-panel-store'
import { getCodeView, selectCodeChat, subscribeCodeView } from './code-view-store'

export type CurrentChat = { kind: 'agent' } | { kind: 'code'; sessionId: string } | { kind: 'code-new' }

export type CurrentChatKind = CurrentChat['kind']

const AGENT: CurrentChat = { kind: 'agent' }
const CODE_NEW: CurrentChat = { kind: 'code-new' }

/** The current chat from its two parts: on the coding side or not, and the coding chat held. Pure. */
export function currentChatOf(onCode: boolean, selected: string | null): CurrentChat {
  if (!onCode) return AGENT
  return selected ? { kind: 'code', sessionId: selected } : CODE_NEW
}

/** The person is on the coding side (a coding chat, or a new one). */
let onCode = false
const listeners = new Set<() => void>()
let cache: { onCode: boolean; selected: string | null; chat: CurrentChat } = { onCode: false, selected: null, chat: AGENT }

function emit(): void {
  for (const listener of [...listeners]) listener()
}

function setOnCode(next: boolean): void {
  if (onCode === next) return
  onCode = next
  // The panels' mirror (side-panel-store.ts): they read the current chat through it for now.
  setCodeView(next)
  emit()
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

/** Hears every change of the current chat: its kind, and which coding chat. */
export function subscribeCurrentChat(listener: () => void): () => void {
  listeners.add(listener)
  const offCodeView = subscribeCodeView(listener)
  return () => {
    listeners.delete(listener)
    offCodeView()
  }
}

/** Where an open came from ('recents', 'composer', 'list', 'notification'…): for the ways in to say, and the tests to read. */
export interface CurrentChatFrom {
  from?: string
}

/** Make a coding chat the current chat, from anywhere. The one way in. */
export function openCodingChat(sessionId: string, _opts: CurrentChatFrom = {}): void {
  if (!sessionId) return
  selectCodeChat(sessionId)
  setOnCode(true)
}

/** A new coding chat: nothing selected, the next send starts one. */
export function newCodingChat(_opts: CurrentChatFrom = {}): void {
  selectCodeChat(null)
  setOnCode(true)
}

/**
 * The composer's Code side pressed: the coding chat the person was last on
 * comes back (none: a new one).
 */
export function showCoding(_opts: CurrentChatFrom = {}): void {
  setOnCode(true)
}

/** Back to the person's agent. The coding chat they were on is kept for the way back. */
export function backToAgent(_opts: CurrentChatFrom = {}): void {
  setOnCode(false)
}

/** One call for a caller that holds the chat it wants. */
export function setCurrentChat(next: CurrentChat, opts: CurrentChatFrom = {}): void {
  if (next.kind === 'agent') backToAgent(opts)
  else if (next.kind === 'code') openCodingChat(next.sessionId, opts)
  else newCodingChat(opts)
}

export function __resetCurrentChatForTests(): void {
  onCode = false
  cache = { onCode: false, selected: null, chat: AGENT }
  listeners.clear()
  setCodeView(false)
}
