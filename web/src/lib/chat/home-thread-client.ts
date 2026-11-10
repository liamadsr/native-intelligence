/**
 * The home thread, client side (A3, docs/plans/always-on-agent.md §2c;
 * server: src/lib/chat/home-thread.ts, migration 330).
 *
 * The home thread is the person's ONE conversation per workspace, which every
 * surface opens. Two ways in for other code:
 *
 *   • {@link fetchHomeThreadId} — the home thread's conversation id in a
 *     workspace (POST /api/account/chat-history/home: got or created, no
 *     usage gate, no token), cached per workspace for the page's life.
 *     `useHomeThread()` (src/hooks/use-home-thread.ts) is the hook form.
 *     A send into it mints as any send does: the ordinary mint with this id,
 *     or POST /api/account/chat/eve-session `{ action: 'mint', home: true }`
 *     when the caller doesn't hold the id (the same thread, got or created).
 *
 *   • {@link openHomeThread} — show it in the main chat: the dashboard's one
 *     chat (MainChatHost) is the home thread, and is put back on it when a
 *     live call holds it; with `text` (and `cardIds`), it then sends it as
 *     the person's message (ChatPanelHandle.sendFromSurface). What "Open in Native Intelligence", the
 *     agent's face (its bubble, its page, Refine on a card of its own: one
 *     face, TeammateChat `home`) and anything else that wants it call.
 *
 * Nothing else in a window runs a Chat on the home thread: the main chat is
 * its one owner, so two views can't drift apart or both send (#681).
 *
 * Client-safe: no server imports.
 */
import { parseRevealDetail } from './home-message'

/** Window event: show the home thread in the main chat. Handled by MainChatHost. */
export const OPEN_HOME_THREAD_EVENT = 'ni:open-home-thread'

export interface OpenHomeThreadDetail {
  /** Moot since one-chat Slice 1 (the chat is always on screen); kept in the detail for its callers. */
  activate?: boolean
  /**
   * Words to send there as the person's own message, once the home thread is
   * open (the composer's send path: a reply still running is waited for).
   */
  text?: string
  /** The cards (attention items) the surface showed with `text`: they ride that turn (systemContext.aboutCardIds). */
  cardIds?: string[]
  /**
   * Open it on a message the agent wrote there (a notice's click,
   * lib/chat/home-message.ts): brought into the chat when it lacks it, then
   * scrolled to. A null id (an older notice) still reads the thread's newest
   * rows in.
   */
  reveal?: { messageId: string | null }
  /**
   * The workspace the words belong to (the teammate's): a window on another
   * workspace refuses them rather than post into its own home thread.
   */
  workspaceId?: string | null
  /** The main chat took the event (called at once, while it is handled): no call means no chat here. */
  take?: () => void
  /** What came of it, once known (handOffToHome's promise). */
  onResult?: (result: HomeHandoffResult) => void
}

/** What handing words to the home thread came to. */
export type HomeHandoffResult = { ok: true } | { ok: false; reason: string }

/** Why a hand-off failed, in words a surface shows (it keeps the text). */
export const HOME_HANDOFF_REASONS = {
  noStrip: 'Native Intelligence’s chat isn’t open in this window, so that wasn’t sent.',
  otherWorkspace: 'That’s in another workspace: switch to it first, then send it again.',
  notOpened: 'Couldn’t open your conversation, so that wasn’t sent. Try again in a moment.',
  notSent: 'Couldn’t send that to your conversation. Try again in a moment.',
} as const

/**
 * Hand words to the home thread and learn whether they went (A3: the agent's
 * bubble, its page, a card's Refine, the desktop bubble). Puts the main chat
 * on the home thread and sends `text` there as the person's message; the
 * promise settles once the chat took it (sent, or waiting above the composer
 * behind a reply still running), or with the reason it didn't: no chat strip
 * in this window, another workspace's words, or the conversation couldn't be
 * opened or sent to. A surface clears its input and says "sent" only on ok.
 */
export function handOffToHome(detail: { text: string; cardIds?: string[]; workspaceId?: string | null; activate?: boolean }): Promise<HomeHandoffResult> {
  if (typeof window === 'undefined') return Promise.resolve({ ok: false, reason: HOME_HANDOFF_REASONS.noStrip })
  return new Promise((resolve) => {
    let taken = false
    let settled = false
    const onResult = (result: HomeHandoffResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    window.dispatchEvent(
      new CustomEvent<OpenHomeThreadDetail>(OPEN_HOME_THREAD_EVENT, {
        detail: { ...detail, take: () => (taken = true), onResult },
      }),
    )
    if (!taken) onResult({ ok: false, reason: HOME_HANDOFF_REASONS.noStrip })
  })
}

/** The longest `text` a surface may send this way, and the most cards. */
export const OPEN_HOME_TEXT_MAX = 8_000
export const OPEN_HOME_CARDS_MAX = 20

/** Show the home thread in the main chat (see the module note). No-op off the dashboard. */
export function openHomeThread(detail: OpenHomeThreadDetail = {}): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<OpenHomeThreadDetail>(OPEN_HOME_THREAD_EVENT, { detail }))
}

/** A detail from the event, checked (anything else reads as the defaults: shown, nothing sent). */
export function parseOpenHomeThreadDetail(value: unknown): {
  activate: boolean
  text: string | null
  cardIds: string[]
  workspaceId: string | null
  reveal: { messageId: string | null } | null
  take: (() => void) | null
  onResult: ((result: HomeHandoffResult) => void) | null
} {
  const v = value && typeof value === 'object' ? (value as { activate?: unknown; text?: unknown; cardIds?: unknown; workspaceId?: unknown; reveal?: unknown; take?: unknown; onResult?: unknown }) : {}
  const text = typeof v.text === 'string' && v.text.trim() ? v.text.trim().slice(0, OPEN_HOME_TEXT_MAX) : null
  const cardIds = Array.isArray(v.cardIds)
    ? [...new Set(v.cardIds.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 64))].slice(0, OPEN_HOME_CARDS_MAX)
    : []
  return {
    activate: v.activate !== false,
    text,
    cardIds: text ? cardIds : [],
    workspaceId: typeof v.workspaceId === 'string' && v.workspaceId ? v.workspaceId : null,
    reveal: parseRevealDetail(v.reveal),
    take: typeof v.take === 'function' ? (v.take as () => void) : null,
    onResult: typeof v.onResult === 'function' ? (v.onResult as (result: HomeHandoffResult) => void) : null,
  }
}

const known = new Map<string, string>()
const inflight = new Map<string, Promise<string | null>>()

/** The home thread's id in `workspaceId` when this page already knows it, else null. */
export function peekHomeThreadId(workspaceId: string | null | undefined): string | null {
  return workspaceId ? (known.get(workspaceId) ?? null) : null
}

/**
 * The home thread's conversation id in `workspaceId` (got or created on the
 * server), or null when it couldn't be read. One request per workspace per
 * page: later calls share the answer. A failure isn't cached, so the next
 * call asks again.
 *
 * The request carries the workspace as `x-workspace-id` (the app's fetch
 * patch adds the current one too), so a call made just as the workspace
 * switches never answers for another.
 */
export function fetchHomeThreadId(workspaceId: string | null | undefined): Promise<string | null> {
  if (!workspaceId) return Promise.resolve(null)
  const hit = known.get(workspaceId)
  if (hit) return Promise.resolve(hit)
  const running = inflight.get(workspaceId)
  if (running) return running
  const request = (async () => {
    try {
      const res = await fetch('/api/account/chat-history/home', {
        method: 'POST',
        headers: { 'x-workspace-id': workspaceId },
      })
      if (!res.ok) return null
      const body = (await res.json()) as { conversationId?: unknown; workspaceId?: unknown }
      // Another workspace's answer (the header refused, the cookie's used) is no answer.
      if (body.workspaceId !== undefined && body.workspaceId !== workspaceId) return null
      const id = typeof body.conversationId === 'string' && body.conversationId ? body.conversationId : null
      if (id) known.set(workspaceId, id)
      return id
    } catch {
      return null
    } finally {
      inflight.delete(workspaceId)
    }
  })()
  inflight.set(workspaceId, request)
  return request
}

const listeners = new Set<(workspaceId: string) => void>()

/**
 * Forget the cached id for `workspaceId` (its conversation is gone: deleted
 * elsewhere, or not this person's here), so the next ask reads it afresh.
 * useHomeThread re-reads it at once.
 */
export function forgetHomeThreadId(workspaceId: string | null | undefined): void {
  if (!workspaceId || !known.has(workspaceId)) return
  known.delete(workspaceId)
  for (const listener of listeners) listener(workspaceId)
}

/** Told when a workspace's cached id is forgotten. Returns the unsubscribe. */
export function onHomeThreadForgotten(listener: (workspaceId: string) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Test-only: forget every cached id. */
export function resetHomeThreadCacheForTests(): void {
  known.clear()
  inflight.clear()
}
