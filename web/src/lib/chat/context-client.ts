'use client'

/**
 * The main chat's context, on the client: how full the conversation's context
 * is, and compacting it on command (Liam, 10-22: the Claude app's Context
 * panel, "with an option to compact on command"). One small external store,
 * shared by the side panel's Context card (side-panels/context-section.tsx)
 * and the composer's `/compact` (chat/chat-panel.tsx submitTurn), so a
 * compaction asked from either shows in the card.
 *
 *   read     GET /api/account/chat/context (src/lib/chat/context-usage.ts):
 *            when the card's panel opens or its conversation changes (unless
 *            read within CONTEXT_FRESH_MS), after a reply ends (twice: the
 *            agent's usage report lands just after the reply, see
 *            CONTEXT_AFTER_TURN_MS), and after a compaction. Never polled.
 *   compact  POST /api/account/chat/compact (manual-compaction.ts): up to a
 *            minute; its outcome becomes the card's note (and /compact's
 *            toast), until the next message starts. One per conversation at
 *            a time in this tab (`inFlight`, kept across the card switching
 *            conversations); the server refuses one on top of a compaction
 *            already running anywhere ('compacting'). The size is read again
 *            right after, and at CONTEXT_AFTER_TURN_MS (the compaction's
 *            usage row can land just after its answer).
 *
 * One conversation at a time: the main chat's. A read that answers for a
 * conversation the chat has left is dropped.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { ChatContextUsage } from '@/lib/chat/context-usage'

/** A read this recent serves a reopen. */
export const CONTEXT_FRESH_MS = 5_000
/** After a reply ends: when the size is read, then once more (the usage report can land a few seconds late). */
export const CONTEXT_AFTER_TURN_MS = [1_500, 6_000] as const

export interface ContextNote {
  text: string
  tone: 'muted' | 'attention'
}

export interface ChatContextState {
  /** The conversation the state is about, or null for none (a blank chat). */
  conversationId: string | null
  /** The size, or null: none measured yet, or not read yet (`loaded` says which). */
  context: ChatContextUsage | null
  /** A read has answered for this conversation. */
  loaded: boolean
  /** A compaction asked here is running. */
  compacting: boolean
  /** What the last compaction asked here came to, until the conversation changes. */
  note: ContextNote | null
}

const EMPTY: ChatContextState = { conversationId: null, context: null, loaded: false, compacting: false, note: null }

let state: ChatContextState = EMPTY
let readAt = 0
/** The compactions asked in this tab and not yet answered, by conversation: they outlive a switch of the card's conversation. */
const inFlight = new Map<string, Promise<ContextNote>>()
let reading: { conversationId: string; promise: Promise<void> } | null = null
const listeners = new Set<() => void>()

function set(patch: Partial<ChatContextState>): void {
  const next = { ...state, ...patch }
  if ((Object.keys(next) as Array<keyof ChatContextState>).every((k) => next[k] === state[k])) return
  state = next
  for (const listener of listeners) listener()
}

export function getChatContextState(): ChatContextState {
  return state
}

export function subscribeChatContext(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Point the store at the main chat's conversation; a new one starts empty. */
export function setContextConversation(conversationId: string | null): void {
  if (state.conversationId === conversationId) return
  readAt = 0
  state = { ...EMPTY, conversationId, compacting: conversationId !== null && inFlight.has(conversationId) }
  for (const listener of listeners) listener()
}

/** A new message makes the last compaction's note old news: it goes. */
export function clearContextNote(): void {
  if (state.note) set({ note: null })
}

/** Read the conversation's size (one read at a time; a fresh one serves unless `force`). Never throws. */
export function readChatContext(conversationId: string, { force = false } = {}): Promise<void> {
  if (state.conversationId !== conversationId) setContextConversation(conversationId)
  if (reading?.conversationId === conversationId) {
    // A forced read wants what is true now: the one in flight may have left before it.
    return force ? reading.promise.then(() => readChatContext(conversationId, { force })) : reading.promise
  }
  if (!force && state.loaded && Date.now() - readAt < CONTEXT_FRESH_MS) return Promise.resolve()
  // In place before the read starts, so a read that settles at once still clears it.
  const ticket = { conversationId, promise: Promise.resolve() }
  reading = ticket
  ticket.promise = (async () => {
    try {
      const res = await fetch(`/api/account/chat/context?conversationId=${encodeURIComponent(conversationId)}`)
      if (!res.ok) return
      const body = (await res.json().catch(() => null)) as { context?: ChatContextUsage | null } | null
      if (state.conversationId !== conversationId || !body) return
      readAt = Date.now()
      set({ context: body.context ?? null, loaded: true })
    } catch {
      /* offline or the route down: the card keeps what it had */
    } finally {
      if (reading === ticket) reading = null
    }
  })()
  return ticket.promise
}

/** The composer's `/compact`, typed on its own (any case, any spaces round it). */
export function isCompactCommand(text: string): boolean {
  return /^\/compact$/i.test(text.trim())
}

/** What a compaction's answer says to the person. */
export function compactionNote(status: number, body: { outcome?: unknown; error?: unknown } | null): ContextNote {
  if (status === 409) return { text: 'A reply is still running. Compact once it finishes.', tone: 'attention' }
  if (status === 429) {
    return { text: typeof body?.error === 'string' ? body.error : "You've reached your usage limit.", tone: 'attention' }
  }
  switch (status >= 200 && status < 300 ? body?.outcome : null) {
    case 'compacted':
      return { text: 'Compacted. The next message starts from a summary.', tone: 'muted' }
    case 'requested':
    case 'queued_behind_turn':
      return { text: 'Compacting. It finishes in the background.', tone: 'muted' }
    case 'compacting':
      return { text: 'Already compacting. It finishes in the background.', tone: 'muted' }
    case 'already_compacted':
      return { text: 'Already compacted: nothing new since.', tone: 'muted' }
    case 'kept_history':
      return { text: "Couldn't summarize, so the conversation was kept as it was.", tone: 'attention' }
    case 'no_recent_step':
    case 'no_events':
    case 'no_session':
    case 'session_inactive':
      return { text: 'Nothing to compact yet.', tone: 'muted' }
    default:
      return { text: "Couldn't compact. Try again in a moment.", tone: 'attention' }
  }
}

/** What a second ask says while one is on its way. */
const ALREADY_ASKED: ContextNote = { text: 'Already compacting.', tone: 'muted' }

/**
 * Compact a conversation now; resolves with what it came to (also the card's
 * note, when the card shows that conversation). One per conversation at a
 * time. Another conversation's (`/compact` in a bot's thread) never moves the
 * card. Never throws.
 */
export function compactChatContext(conversationId: string): Promise<ContextNote> {
  if (inFlight.has(conversationId)) return Promise.resolve(ALREADY_ASKED)
  const shown = () => state.conversationId === conversationId
  if (shown()) set({ compacting: true, note: null })
  const request = (async (): Promise<ContextNote> => {
    try {
      const res = await fetch('/api/account/chat/compact', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId }),
      })
      return compactionNote(res.status, (await res.json().catch(() => null)) as { outcome?: unknown; error?: unknown } | null)
    } catch {
      return compactionNote(0, null)
    }
  })()
  inFlight.set(conversationId, request)
  return request.then(async (note) => {
    inFlight.delete(conversationId)
    if (!shown()) return note
    set({ compacting: false, note })
    // Its usage row can land just after the answer: read now, and again as after a reply.
    for (const ms of CONTEXT_AFTER_TURN_MS) setTimeout(() => void (shown() && readChatContext(conversationId, { force: true })), ms)
    await readChatContext(conversationId, { force: true })
    return note
  })
}

/**
 * The main chat's context for a card. Reads when `active` (its panel open)
 * and the conversation changes, and after a reply ends (`busy` going false)
 * while active. A blank chat (no conversation) reads nothing.
 */
export function useChatContext({ conversationId, active, busy }: { conversationId: string | null; active: boolean; busy: boolean }): ChatContextState {
  const snapshot = useSyncExternalStore(subscribeChatContext, getChatContextState, () => EMPTY)

  useEffect(() => {
    setContextConversation(conversationId)
    if (active && conversationId) void readChatContext(conversationId)
  }, [conversationId, active])

  // A reply started: the last compaction's note is old news. One ended: its
  // size lands with the agent's usage report, just after.
  const wasBusy = useRef(busy)
  useEffect(() => {
    const ended = wasBusy.current && !busy
    if (!wasBusy.current && busy) clearContextNote()
    wasBusy.current = busy
    if (!ended || !active || !conversationId) return
    const timers = CONTEXT_AFTER_TURN_MS.map((ms) => setTimeout(() => void readChatContext(conversationId, { force: true }), ms))
    return () => timers.forEach(clearTimeout)
  }, [busy, active, conversationId])

  return snapshot.conversationId === conversationId ? snapshot : { ...EMPTY, conversationId }
}

/** Test seam. */
export function resetChatContext(): void {
  state = EMPTY
  readAt = 0
  reading = null
  inFlight.clear()
}
