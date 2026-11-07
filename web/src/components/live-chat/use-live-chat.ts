'use client'

/**
 * useLiveChat: the chat with a call's live agent (one-chat plan, Slice 3), for
 * ONE capture conversation. Built like the other compact chats
 * (hooks/use-teammate-chat.ts, hooks/use-run-chat.ts): a module store holding
 * the Chat and its eve transport, so a reply streaming in runs to its end when
 * the card showing it goes away, and the next mount shows it as it stands.
 * Never ChatPanel, never the RecordingProvider: the desktop's HUD window has
 * neither.
 *
 * The conversation is the capture's own (one row per capture, made by
 * POST /api/account/chat-history/live), pinned to the live agent:
 *   - every send carries the conversation id, the agent (`agentId`, the row's
 *     recipe_id; none for the built-in Assistant) and
 *     `systemContext.liveCaptureId`, which makes the chat-agent's spec rebuild
 *     add the live-meeting block (the transcript's tail) to the turn;
 *   - before each send `beforeSend` runs (the host pushes the transcript it
 *     holds to the server), capped at BEFORE_SEND_CAP_MS: a slow or failed one
 *     never holds the send back, the turn reads the last saved transcript;
 *   - the ambient loop keeps writing to the same row (say_to_user, ask_user,
 *     the proposals card) and reading the person's messages in it as
 *     directives, so those rows merge in live (useLiveConversation, every
 *     server-written row) and an answer to its question is the person's
 *     message too (answerQuestion).
 *
 * The transport persists each turn, the person's message with it (EvePersistBody
 * `userMessage`): there is no autosave here, so nothing is marked saved.
 *
 * History: the whole thread, read once per thread. Not a page: the Realtime
 * bridge's resync reads the whole thread on every subscribe anyway and appends
 * what it hasn't seen, so a page would put older rows after newer ones. A
 * call's thread is short.
 */
import { useCallback, useEffect, useReducer, useSyncExternalStore } from 'react'
import { Chat, useChat, type UIMessage } from '@ai-sdk/react'
import { createClient } from '@/lib/supabase/client'
import { EveChatTransport } from '@/lib/chat/eve/eve-chat-transport'
import { isDesktopApp } from '@/lib/platform'
import { useLiveConversation } from '@/app/account/(dashboard)/chat/use-live-conversation'
import { withQuestionAnswered } from './live-chat-model'

/** What the chat talks to: a capture's conversation and its live agent. */
export interface LiveChatTarget {
  captureId: string
  conversationId: string
  /** The live agent (the conversation's recipe_id); null = the built-in Assistant. */
  agentId: string | null
  /** The conversation's workspace (sent as `x-workspace-id`); null = the window's. */
  workspaceId: string | null
}

/** `beforeSend` gets this long, then the send goes anyway (ms). */
export const BEFORE_SEND_CAP_MS = 1200
/** How often a streaming reply re-renders the chat at most (ms), as the main chat's does. */
export const LIVE_CHAT_THROTTLE_MS = 50
/** Idle live chats kept at most (a call has one; the one before can still be finishing). */
export const LIVE_CHATS_KEPT = 2

const WORKSPACE_HEADER = 'x-workspace-id'

/** How an answer to the ambient loop's question goes back. */
export interface LiveAnswer {
  /** The picker's choice: question text → label. */
  answers?: Record<string, string>
  /** Words typed while the question was open: they answer it. */
  typed?: string
  /** Dismissed without an answer: the question closes, nothing is sent. */
  dismissed?: boolean
}

export interface LiveChat {
  messages: UIMessage[]
  status: ReturnType<typeof useChat>['status']
  error: Error | undefined
  /** True until the thread's history has loaded (or failed to). */
  loading: boolean
  /** Send the person's words to the live agent. Resolves whether they went out. */
  send: (text: string) => Promise<boolean>
  /** Answer (or dismiss) the ambient loop's question `toolCallId`. */
  answerQuestion: (toolCallId: string, answer: LiveAnswer) => void
  stop: () => void
}

// ── The store ────────────────────────────────────────────────────────────────

interface ThreadView {
  loading: boolean
  loadError: Error | undefined
}

interface LiveThread {
  key: string
  /** Read live by sends (the agent can change mid-call). */
  target: LiveChatTarget
  chat: Chat<UIMessage>
  transport: EveChatTransport
  view: ThreadView
  listeners: Set<() => void>
  subscribe: (listener: () => void) => () => void
  getView: () => ThreadView
  loaded: Promise<void> | null
  mounts: number
  sending: number
  lastUsed: number
  disposed: boolean
}

const threads = new Map<string, LiveThread>()
const auth: { token: string | null; userId: string | null; unwatch: (() => void) | null } = {
  token: null,
  userId: null,
  unwatch: null,
}

async function refreshAccessToken(): Promise<string | null> {
  const {
    data: { session },
  } = await createClient().auth.getSession()
  const next = session?.access_token ?? null
  if (next) auth.token = next
  return next
}

/** Once per page: the JWT kept fresh, and signing out (or another user) ends every live chat. */
function watchAuth(): void {
  if (auth.unwatch) return
  const supabase = createClient()
  void supabase.auth.getSession().then(({ data: { session } }) => {
    if (!session?.access_token) return
    auth.token ??= session.access_token
    auth.userId ??= session.user?.id ?? null
  })
  const { data } = supabase.auth.onAuthStateChange((event, session) => {
    const userId = session?.user?.id ?? null
    if (event === 'SIGNED_OUT' || (userId && auth.userId && userId !== auth.userId)) disposeLiveChats()
    if (session?.access_token) auth.token = session.access_token
    if (userId) auth.userId = userId
  })
  auth.unwatch = () => data.subscription.unsubscribe()
}

function setView(thread: LiveThread, next: Partial<ThreadView>): void {
  thread.view = { ...thread.view, ...next }
  for (const listener of [...thread.listeners]) listener()
}

function isBusy(thread: LiveThread): boolean {
  return thread.sending > 0 || thread.chat.status === 'submitted' || thread.chat.status === 'streaming'
}

/** The live chat for `target`'s conversation, made (nothing fetched) the first time it's asked for. */
function threadFor(target: LiveChatTarget): LiveThread {
  const kept = threads.get(target.conversationId)
  if (kept && !kept.disposed) {
    kept.target = target
    kept.lastUsed = Date.now()
    return kept
  }
  const thread = { key: target.conversationId, target } as LiveThread
  thread.view = { loading: true, loadError: undefined }
  thread.listeners = new Set()
  thread.subscribe = (listener) => {
    thread.listeners.add(listener)
    return () => {
      thread.listeners.delete(listener)
    }
  }
  thread.getView = () => thread.view
  thread.loaded = null
  thread.mounts = 0
  thread.sending = 0
  thread.lastUsed = Date.now()
  thread.disposed = false
  thread.transport = new EveChatTransport({
    workspaceId: () => thread.target.workspaceId,
    getAccessToken: () => auth.token,
    refreshAccessToken,
    getConversationId: () => thread.target.conversationId,
    // The capture's conversation is named for the meeting when it's made: the
    // server's first-turn title backfill stands down.
    panelNamesChats: () => true,
  })
  thread.chat = new Chat<UIMessage>({ id: `live-${target.conversationId}`, transport: thread.transport })
  threads.set(thread.key, thread)
  return thread
}

/** Load the thread's history once (merged under anything that already landed live). */
function loadThread(thread: LiveThread): Promise<void> {
  if (thread.loaded) return thread.loaded
  const { conversationId, workspaceId } = thread.target
  thread.loaded = (async () => {
    try {
      const res = await fetch(`/api/account/chat-history/${encodeURIComponent(conversationId)}`, {
        headers: workspaceId ? { [WORKSPACE_HEADER]: workspaceId } : undefined,
      })
      if (!res.ok) throw new Error(`Couldn't load the live chat (${res.status})`)
      const body = (await res.json().catch(() => ({}))) as { messages?: unknown }
      const history = Array.isArray(body.messages) ? (body.messages as UIMessage[]) : []
      if (thread.disposed) return
      const known = new Set(history.map((m) => m.id))
      thread.chat.messages = [...history, ...thread.chat.messages.filter((m) => !known.has(m.id))]
      setView(thread, { loading: false, loadError: undefined })
    } catch (err) {
      if (thread.disposed) return
      // A failed read leaves a chat you can still talk in; the next mount reads again.
      thread.loaded = null
      setView(thread, { loading: false, loadError: err instanceof Error ? err : new Error(String(err)) })
    }
  })()
  return thread.loaded
}

function retainThread(thread: LiveThread): boolean {
  if (thread.disposed) return false
  watchAuth()
  thread.mounts++
  thread.lastUsed = Date.now()
  void loadThread(thread)
  return true
}

function releaseThread(thread: LiveThread): void {
  thread.mounts = Math.max(0, thread.mounts - 1)
  thread.lastUsed = Date.now()
  trimThreads()
}

function trimThreads(): void {
  let excess = threads.size - LIVE_CHATS_KEPT
  if (excess <= 0) return
  const idle = [...threads.values()].filter((t) => t.mounts === 0 && !isBusy(t)).sort((a, b) => a.lastUsed - b.lastUsed)
  for (const thread of idle) {
    if (excess-- <= 0) break
    disposeThread(thread)
  }
}

function disposeThread(thread: LiveThread, { stop = false }: { stop?: boolean } = {}): void {
  if (thread.disposed) return
  thread.disposed = true
  if (threads.get(thread.key) === thread) threads.delete(thread.key)
  if (stop) void thread.chat.stop()
  void thread.transport.disposeAll()
}

/** End every live chat (a reply in flight is stopped): signing out. */
export function disposeLiveChats(): void {
  for (const thread of [...threads.values()]) disposeThread(thread, { stop: true })
}

/** Tests only: forget every live chat and the auth watch. */
export function __resetLiveChatsForTests(): void {
  for (const thread of [...threads.values()]) disposeThread(thread)
  threads.clear()
  auth.unwatch?.()
  auth.unwatch = null
  auth.token = null
  auth.userId = null
}

/** What every live send carries: the conversation, the live agent, and the live capture. */
export function liveTurnBody(target: LiveChatTarget): Record<string, unknown> {
  return {
    conversationId: target.conversationId,
    systemContext: {
      liveCaptureId: target.captureId,
      // The desktop's own tools (the Mac's local agent) are offered only to it.
      ...(isDesktopApp() ? { isDesktopClient: true } : {}),
    },
    ...(target.agentId ? { agentId: target.agentId } : {}),
  }
}

/** `beforeSend`, given at most BEFORE_SEND_CAP_MS; a failure or a timeout never stops the send. */
export async function runBeforeSend(beforeSend: (() => Promise<void>) | undefined): Promise<void> {
  if (!beforeSend) return
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    await Promise.race([
      Promise.resolve()
        .then(beforeSend)
        .catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, BEFORE_SEND_CAP_MS)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Resolves once no reply is running (a send never goes over one). */
function whenIdle(thread: LiveThread): Promise<void> {
  const busy = () => thread.chat.status === 'submitted' || thread.chat.status === 'streaming'
  if (!busy()) return Promise.resolve()
  return new Promise((resolve) => {
    const off = thread.chat['~registerStatusCallback'](() => {
      if (busy() && !thread.disposed) return
      off()
      resolve()
    })
  })
}

async function sendToThread(thread: LiveThread, text: string, beforeSend?: () => Promise<void>): Promise<boolean> {
  const trimmed = text.trim()
  if (!trimmed || thread.disposed) return false
  thread.sending++
  try {
    await whenIdle(thread)
    await runBeforeSend(beforeSend)
    if (thread.disposed) return false
    await thread.chat.sendMessage({ text: trimmed }, { body: liveTurnBody(thread.target) })
    return true
  } finally {
    thread.sending--
    trimThreads()
  }
}

/**
 * Send the person's words to `target`'s live agent from outside the chat card
 * (a spoken ask during a call: chat/route-voice-ask.ts), through the same
 * store: the HUD's chat, mounted or not, shows them and the reply. Resolves
 * once the reply is in, with whether the words went out. Like the card's own
 * send, it waits behind a reply still running and runs `beforeSend` first.
 */
export async function sendToLiveChat(target: LiveChatTarget, text: string, beforeSend?: () => Promise<void>): Promise<boolean> {
  const thread = threadFor(target)
  if (thread.disposed) return false
  watchAuth()
  // The first use of the store in this window: the token is read before the send needs it.
  if (!auth.token) await refreshAccessToken().catch(() => null)
  // Its history under what's said now, as a card mounting later would read it.
  void loadThread(thread)
  return sendToThread(thread, text, beforeSend).catch(() => false)
}

/**
 * Answer the ambient loop's question (it asked with a row it wrote, not from
 * an open turn, so there's no turn to resume):
 *   1. the question closes here at once (its part answered in the chat);
 *   2. the answer is written to its row (PATCH …/messages/answer), so a reload
 *      shows it answered and the loop may ask again;
 *   3. a real answer (a choice, or typed words) goes as the person's message,
 *      which the loop reads as a directive. A dismissal sends nothing.
 * Typed words are flagged `typed` in the row's output, so they never read as
 * a dismissal.
 */
function answerInThread(thread: LiveThread, toolCallId: string, answer: LiveAnswer, beforeSend?: () => Promise<void>): void {
  const typed = answer.typed?.trim() ?? ''
  const chosen = Object.values(answer.answers ?? {}).filter(Boolean)
  const output: Record<string, unknown> = typed
    ? { response: typed, typed: true }
    : chosen.length > 0 && !answer.dismissed
      ? { answers: answer.answers }
      : { response: '(dismissed)' }
  thread.chat.messages = withQuestionAnswered(thread.chat.messages, toolCallId, output)
  void fetch(`/api/account/chat-history/${encodeURIComponent(thread.target.conversationId)}/messages/answer`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(thread.target.workspaceId ? { [WORKSPACE_HEADER]: thread.target.workspaceId } : {}),
    },
    body: JSON.stringify({ tool_call_id: toolCallId, output }),
  }).catch(() => {})
  const words = typed || (answer.dismissed ? '' : chosen.join(', '))
  if (words) void sendToThread(thread, words, beforeSend)
}

// ── The hook ─────────────────────────────────────────────────────────────────

/** No autosave here: the transport persists each turn, so nothing is marked saved. */
function noteNothingSaved(): void {}

export function useLiveChat(target: LiveChatTarget, opts: { beforeSend?: () => Promise<void> } = {}): LiveChat {
  const [, renderAgain] = useReducer((n: number) => n + 1, 0)
  const thread = threadFor(target)
  useEffect(() => {
    if (!retainThread(thread)) {
      renderAgain()
      return
    }
    return () => releaseThread(thread)
  }, [thread])
  const view = useSyncExternalStore(thread.subscribe, thread.getView, thread.getView)
  // Externally managed: useChat never stops it on unmount. Throttled like the
  // main chat's (chat-panel.tsx): a streamed reply re-renders the chat (and
  // rebuilds its rows) at most every LIVE_CHAT_THROTTLE_MS, not per chunk.
  const chat = useChat({ chat: thread.chat, experimental_throttle: LIVE_CHAT_THROTTLE_MS })

  // Every server-written row (say_to_user, ask_user, the proposals card, a
  // turn persisted from another window), merged in by id as it lands.
  useLiveConversation({
    conversationId: target.conversationId,
    status: chat.status,
    setMessages: chat.setMessages,
    markSaved: noteNothingSaved,
    scope: 'all',
    workspaceId: target.workspaceId,
  })

  const { beforeSend } = opts
  const send = useCallback((text: string) => sendToThread(thread, text, beforeSend), [thread, beforeSend])
  const answerQuestion = useCallback(
    (toolCallId: string, answer: LiveAnswer) => answerInThread(thread, toolCallId, answer, beforeSend),
    [thread, beforeSend],
  )

  return {
    messages: chat.messages,
    status: chat.status,
    error: chat.error ?? view.loadError,
    loading: view.loading,
    send,
    answerQuestion,
    stop: chat.stop,
  }
}
