'use client'

/**
 * useRunChat — a settled work run's follow-up chat (its PARKED eve session,
 * through RunChatTransport and /api/account/agent-runs/[id]/chat), shared by
 * every surface that shows it (bots-v2.md "Items continue their run's chat"):
 * a bot's bubble replying about an item the run produced, the desktop
 * overlay's bubble (relayed from the main window), and the run's own view in a
 * tab (RunChat). One conversation per run, so a reply typed in the bubble is
 * in the tab when it opens, and a question the run asks in one can be
 * answered in the other (the same transport holds its turn open).
 *
 * Like the teammate threads (use-teammate-chat.ts), the conversation outlives
 * the component: its Chat and transport live in a module store keyed by run
 * id. A bubble closing, or paging to another item, only hides it: a reply
 * streaming in runs to its end, and the next mount shows it as it stands. The
 * first mount replays the run's earlier follow-up turns (loadRunChatHistory);
 * a replay the route refused (someone else started the run: 403; not settled:
 * 409 NOT_TERMINAL; no session: 409 NO_SESSION) is `refusal`, and the caller
 * falls back to the teammate's own thread, saying why. A read that failed in
 * passing (the network, 401, 5xx) is no refusal: the composer stays, and the
 * next send or mount asks again. Shown again after nothing showed it, an idle
 * chat reads its history again (turns sent from the run's own page, another
 * device), replacing what's held. `replayDelayMs` (the bubble's): the read
 * waits that long on show, so paging past an item reads nothing; a send reads
 * at once. Kept bounded:
 * past RUN_CHATS_KEPT the least recently shown idle ones are let go. Signing
 * out (the sign-out wipe, Supabase's SIGNED_OUT, another user) ends them all,
 * and the drafts are the teammate store's (keyed `run:<id>`).
 *
 * Returns the same useChat-like surface as useTeammateChat (so TeammateChat's
 * view renders either), plus the run's Chat, transport and replayed pending
 * questions for RunChat's picker. `useRunChat(null)` is inert (null): a host
 * that sometimes talks about a run calls it unconditionally.
 */
import { useCallback, useEffect, useReducer, useSyncExternalStore } from 'react'
import { Chat, useChat, type UIMessage } from '@ai-sdk/react'
import { createClient } from '@/lib/supabase/client'
import { RunChatTransport, loadRunChatHistory } from '@/lib/agent-run/run-chat-transport'
import type { RunChatQuestionPayload } from '@/lib/agent-run/run-chat-events'
import type { RunChatRefusal } from '@/lib/bots/item-run-chat'
import { onTabStateWipe } from '@/app/account/(dashboard)/main-chat/state-wipe'
import { runChatTurnBody, type ComposerTurnExtras } from '@/app/account/(dashboard)/chat/composer-state'
import type { TeammateChat, TeammateSendOptions } from './use-teammate-chat'

/** How many run chats are kept at most once idle (none showing them, no turn in flight). */
export const RUN_CHATS_KEPT = 4
/** The bubble's wait on show before reading an item's run chat (paging past one reads nothing). */
export const RUN_CHAT_BUBBLE_REPLAY_MS = 1_000

interface RunView {
  /** The replay is under way. */
  loading: boolean
  /** The route said no to the replay: this run's chat can't be had. */
  refusal: RunChatRefusal | null
}

interface RunThread {
  runId: string
  chat: Chat<UIMessage>
  transport: RunChatTransport
  view: RunView
  listeners: Set<() => void>
  subscribe: (listener: () => void) => () => void
  getView: () => RunView
  /** Replayed final questions still pending (picker toolCallId → payload): answered by a send with inputResponses. */
  pendingQuestions: Map<string, RunChatQuestionPayload>
  /** Resolves whether the chat can be talked in (the replay wasn't refused). */
  ready: Promise<boolean>
  replayed: boolean
  /** A replay is out now. */
  replaying: boolean
  /** A delayed replay waiting to start (the bubble's). */
  replayTimer: ReturnType<typeof setTimeout> | null
  mounts: number
  sending: number
  lastUsed: number
  disposed: boolean
}

const runs = new Map<string, RunThread>()
const watch: { on: boolean; userId: string | null; stop: (() => void) | null } = { on: false, userId: null, stop: null }

function setView(thread: RunThread, next: Partial<RunView>): void {
  thread.view = { ...thread.view, ...next }
  for (const listener of [...thread.listeners]) listener()
}

function isBusy(thread: RunThread): boolean {
  return thread.sending > 0 || thread.chat.status === 'submitted' || thread.chat.status === 'streaming'
}

/** Once per page: signing out (here, elsewhere, or as someone else) ends every run chat. */
function watchSignOut(): void {
  if (watch.on) return
  watch.on = true
  const unwipe = onTabStateWipe(disposeRunChats)
  let unsubscribe = () => {}
  try {
    const supabase = createClient()
    void supabase.auth
      .getSession()
      .then(({ data: { session } }) => {
        watch.userId ??= session?.user?.id ?? null
      })
      .catch(() => {})
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      const userId = session?.user?.id ?? null
      if (event === 'SIGNED_OUT' || (userId && watch.userId && userId !== watch.userId)) disposeRunChats()
      if (userId) watch.userId = userId
    })
    unsubscribe = () => data.subscription.unsubscribe()
  } catch {
    // No auth client (a test page): the wipe still ends them.
  }
  watch.stop = () => {
    unwipe()
    unsubscribe()
  }
}

function runFor(runId: string): RunThread {
  const kept = runs.get(runId)
  if (kept && !kept.disposed) {
    kept.lastUsed = Date.now()
    return kept
  }
  const thread = { runId } as RunThread
  thread.transport = new RunChatTransport(runId)
  thread.chat = new Chat<UIMessage>({ id: `run-${runId}`, transport: thread.transport })
  thread.view = { loading: true, refusal: null }
  thread.listeners = new Set()
  thread.subscribe = (listener) => {
    thread.listeners.add(listener)
    return () => {
      thread.listeners.delete(listener)
    }
  }
  thread.getView = () => thread.view
  thread.pendingQuestions = new Map()
  thread.ready = Promise.resolve(false)
  thread.replayed = false
  thread.replaying = false
  thread.replayTimer = null
  thread.mounts = 0
  thread.sending = 0
  thread.lastUsed = Date.now()
  thread.disposed = false
  runs.set(runId, thread)
  return thread
}

function cancelDelayedReplay(thread: RunThread): void {
  if (thread.replayTimer === null) return
  clearTimeout(thread.replayTimer)
  thread.replayTimer = null
}

/**
 * Replay the run's follow-up turns, unless that's done, under way, or a turn
 * is in flight. `again`: an idle chat shown again reads its history afresh
 * and the read replaces what's held (unless a turn started meanwhile).
 */
function replay(thread: RunThread, { again = false }: { again?: boolean } = {}): void {
  cancelDelayedReplay(thread)
  if (thread.disposed || thread.replaying || (thread.replayed && !again) || isBusy(thread)) return
  thread.replayed = true
  thread.replaying = true
  const held = thread.chat.messages.length > 0
  // Shown again with a conversation held: it stays on screen while it's read.
  if (!held) setView(thread, { loading: true, refusal: null })
  thread.ready = loadRunChatHistory(thread.runId).then(
    ({ messages, pendingQuestions, refusal, failed }) => {
      thread.replaying = false
      if (thread.disposed) return false
      if (refusal) {
        // Asked again at the next mount (a run that settles since becomes chattable).
        thread.replayed = false
        setView(thread, { loading: false, refusal })
        return false
      }
      if (failed) {
        // In passing (the network, 401, 5xx): no refusal, the composer stays, the next send or mount asks again.
        thread.replayed = false
        setView(thread, { loading: false, refusal: null })
        return true
      }
      // A turn sent meanwhile (it waited on this) keeps its place after the history;
      // read again while idle, the history is the conversation as it stands.
      if (thread.chat.messages.length === 0 || (again && !isBusy(thread) && thread.sending === 0)) {
        thread.chat.messages = messages
        thread.pendingQuestions = pendingQuestions
      } else if (!held) {
        thread.pendingQuestions = pendingQuestions
      }
      setView(thread, { loading: false, refusal: null })
      return true
    },
    () => {
      thread.replaying = false
      thread.replayed = false
      if (!thread.disposed) setView(thread, { loading: false })
      return true
    },
  )
}

/** A replay after `delayMs` (0: now), unless one is out or waiting; a send replays at once. */
function scheduleReplay(thread: RunThread, delayMs: number, again: boolean): void {
  if (delayMs <= 0) {
    replay(thread, { again })
    return
  }
  if (thread.replayTimer !== null || thread.replaying || (thread.replayed && !again)) return
  // Nothing's being read yet: the box takes a message meanwhile (a send reads at once).
  if (thread.view.loading) setView(thread, { loading: false })
  thread.replayTimer = setTimeout(() => {
    thread.replayTimer = null
    if (thread.mounts > 0) replay(thread, { again })
  }, delayMs)
}

function retain(thread: RunThread, replayDelayMs: number): boolean {
  if (thread.disposed) return false
  watchSignOut()
  // Shown again after nothing showed it, idle: its history is read afresh.
  const again = thread.mounts === 0 && thread.replayed && !isBusy(thread)
  thread.mounts++
  thread.lastUsed = Date.now()
  scheduleReplay(thread, replayDelayMs, again)
  return true
}

function release(thread: RunThread): void {
  thread.mounts = Math.max(0, thread.mounts - 1)
  thread.lastUsed = Date.now()
  if (thread.mounts === 0) cancelDelayedReplay(thread)
  trim()
}

function trim(): void {
  let excess = runs.size - RUN_CHATS_KEPT
  if (excess <= 0) return
  const idle = [...runs.values()].filter((t) => t.mounts === 0 && !isBusy(t)).sort((a, b) => a.lastUsed - b.lastUsed)
  for (const thread of idle) {
    if (excess-- <= 0) break
    dispose(thread)
  }
}

function dispose(thread: RunThread, { stop = false }: { stop?: boolean } = {}): void {
  if (thread.disposed) return
  thread.disposed = true
  cancelDelayedReplay(thread)
  if (runs.get(thread.runId) === thread) runs.delete(thread.runId)
  if (stop) void thread.chat.stop()
}

/**
 * Send to the run's chat once its replay has settled. `turn`: what the full
 * composer added (bots v4, ConversationComposer), sent as the run-chat
 * route's body (runChatTurnBody: the skill, the uploads' storage facts, the
 * mentions); its files also ride the optimistic message, so it shows their
 * chips at once (a reload shows them from the run's history).
 */
async function sendToThread(thread: RunThread, text: string, turn?: ComposerTurnExtras | null): Promise<boolean> {
  const trimmed = text.trim()
  if (!trimmed) return false
  replay(thread)
  thread.sending++
  try {
    const open = await thread.ready
    if (!open || thread.disposed || thread.view.refusal) return false
    const files = turn?.files ?? []
    await thread.chat.sendMessage(
      { text: trimmed, ...(files.length > 0 ? { files } : {}) },
      turn ? { body: runChatTurnBody(turn) } : undefined,
    )
    return true
  } finally {
    thread.sending--
    trim()
  }
}

/**
 * Send `text` to run `runId`'s chat, whether or not anything shows it (the
 * desktop relay's typed `say` about an item, asked before its talk mounted).
 * Resolves whether it went out (false: empty, or the route refuses the run).
 */
export function sendToRunChat(runId: string, text: string): Promise<boolean> {
  watchSignOut()
  return sendToThread(runFor(runId), text)
}

/** What the route refused run `runId`'s chat with, as far as it's known here (null: not refused, or not asked yet). */
export function runChatRefusalOf(runId: string): RunChatRefusal | null {
  const thread = runs.get(runId)
  return thread && !thread.disposed ? thread.view.refusal : null
}

/** End every run chat (a turn in flight is stopped): signing out. */
export function disposeRunChats(): void {
  for (const thread of [...runs.values()]) dispose(thread, { stop: true })
}

/** Tests only: forget every run chat and the sign-out watch. */
export function __resetRunChatsForTests(): void {
  for (const thread of [...runs.values()]) dispose(thread)
  runs.clear()
  watch.stop?.()
  watch.on = false
  watch.userId = null
  watch.stop = null
}

// ── The hook ─────────────────────────────────────────────────────────────────

export interface RunChatHandle extends TeammateChat {
  runId: string
  /** The route refused this run's chat: talk to the teammate instead (runChatRefusalLine says why). */
  refusal: RunChatRefusal | null
  /** The run's Chat (externally managed) and transport, for RunChat's question picker. */
  chatObject: Chat<UIMessage>
  transport: RunChatTransport
  /** Replayed final questions still pending, by picker toolCallId. */
  pendingQuestions: Map<string, RunChatQuestionPayload>
  setMessages: ReturnType<typeof useChat>['setMessages']
  sendWith: ReturnType<typeof useChat>['sendMessage']
}

const NO_VIEW: RunView = Object.freeze({ loading: false, refusal: null }) as RunView
const noSubscribe = () => () => {}
const noView = () => NO_VIEW
let inert: Chat<UIMessage> | null = null
/** A Chat nothing is ever sent to, for `useRunChat(null)` (hooks are called either way). */
function inertChat(): Chat<UIMessage> {
  inert ??= new Chat<UIMessage>({
    id: 'run-none',
    transport: {
      sendMessages: async () => new ReadableStream({ start: (c) => c.close() }),
      reconnectToStream: async () => null,
    },
  })
  return inert
}

export function useRunChat(runId: string | null, { replayDelayMs = 0 }: { replayDelayMs?: number } = {}): RunChatHandle | null {
  const [, renderAgain] = useReducer((n: number) => n + 1, 0)
  const thread = runId ? runFor(runId) : null
  useEffect(() => {
    if (!thread) return
    if (!retain(thread, replayDelayMs)) {
      renderAgain()
      return
    }
    return () => release(thread)
    // The delay is read as it's shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread])
  const view = useSyncExternalStore(thread?.subscribe ?? noSubscribe, thread?.getView ?? noView, thread?.getView ?? noView)
  // Externally managed: useChat never stops it on unmount.
  const chat = useChat({ chat: thread?.chat ?? inertChat() })
  // The teammate send's options: a run's chat reads the composer's turn (an item's `about` is the teammate thread's).
  const sendMessage = useCallback(
    (text: string, opts?: TeammateSendOptions) => (thread ? sendToThread(thread, text, opts?.turn) : Promise.resolve(false)),
    [thread],
  )
  if (!thread || !runId) return null
  return {
    runId,
    messages: chat.messages,
    sendMessage,
    status: chat.status,
    stop: chat.stop,
    error: chat.error,
    conversationId: null,
    workspaceId: null,
    teammateName: null,
    loading: view.loading,
    refusal: view.refusal,
    chatObject: thread.chat,
    transport: thread.transport,
    pendingQuestions: thread.pendingQuestions,
    setMessages: chat.setMessages,
    sendWith: chat.sendMessage,
  }
}
