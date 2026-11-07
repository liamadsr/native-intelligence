'use client'

/**
 * useTeammateChat — a conversation with ONE AI teammate (bots v2, Phase 1;
 * docs/plans/bots-v2.md): that teammate's persona, ceiling and memory, in its
 * own thread, which stays out of the app's chat history.
 *
 * It runs on the main chat's eve runtime (EveChatTransport → the chat-agent),
 * not a bespoke one: the transport mints with `teammateId`, so the token
 * carries the teammate and the spec/tool routes speak and act as it; and it
 * sends the TEAMMATE's workspace as `x-workspace-id` (the transport's
 * `workspaceId` option), so a teammate in another workspace than the window's
 * works.
 *
 * The first mount for a teammate opens the thread —
 * POST /api/account/chat/eve-session { action: 'thread', teammateId }, which
 * checks the caller may talk to the teammate and gets-or-creates their one
 * thread with it — then loads the thread's messages
 * (GET /api/account/chat-history/[id] with the workspace header). A send waits
 * for that, so the first message always lands on the resolved thread.
 *
 * The thread outlives the component (bots v2 review): its Chat, transport and
 * opened state live in a module store keyed by teammate (and its workspace),
 * not in the hook. Closing the bubble or picking another teammate only hides
 * it: a reply streaming in runs to its end and is saved (the transport's
 * persist is a teammate thread's ONLY writer: no panel autosave, and the
 * chat-history PATCH is the main chat's), and the next mount shows it as it
 * stands, without opening or loading again. useChat is handed the Chat
 * (externally managed), so an unmount never stops it. Kept bounded: past
 * TEAMMATE_CHATS_KEPT, the least recently shown threads that are idle (no
 * mount, no turn in flight) are let go; a window that has moved to another
 * workspace lets go of every idle one at the next mount; signing out (the
 * sign-out wipe, or Supabase's SIGNED_OUT / another user) ends them all, and
 * the drafts. A thread whose open failed opens again on the next mount.
 *
 * Drafts (what's typed and not yet sent) are kept per teammate here too
 * (teammateDraft / setTeammateDraft), so a bubble closed by a press outside, or
 * a switch to another teammate and back, gives them back.
 *
 * Returns a useChat-like surface. Mount it inside the dashboard (the
 * <TeammateChat> component renders with the main chat's ChatMessage).
 *
 * An AREA FACE's page (one-agent plan S3; `focusArea`): the chat is not the
 * face's thread but the person's main-chat conversation focused on its area
 * (`chat_conversations.focus_area`, migration 318), the same kind the agent
 * menu's areas start: the MAIN agent, full tools, attended, the area's pack
 * from the first turn. It opens with POST /api/account/chat/eve-session
 * { action: 'focus', focusArea } (the latest such conversation, else a new
 * one), its transport mints as the main chat's does with the focus, and it is
 * an ordinary conversation in the chat history. Kept in the same store, keyed
 * by the area and workspace.
 *
 * THE AGENT'S FACE (one face, docs/plans/always-on-agent.md §2c) is never
 * opened here: its own chat is the person's home thread, which only the chat
 * strip's home tab runs (TeammateChat `home` hands off to it through
 * openHomeThread). No system teammate thread is opened any more either (the
 * route refuses to make one).
 */
import { useCallback, useEffect, useReducer, useSyncExternalStore } from 'react'
import { Chat, useChat, type UIMessage } from '@ai-sdk/react'
import { createClient } from '@/lib/supabase/client'
import { EveChatTransport } from '@/lib/chat/eve/eve-chat-transport'
import { getClientWorkspaceId } from '@/lib/workspace-fetch'
import { onTabStateWipe } from '@/app/account/(dashboard)/main-chat/state-wipe'
import { chatAgentTurnBody, type ComposerTurnExtras } from '@/app/account/(dashboard)/chat/composer-state'
import { isChatImageUpload } from '@/lib/chat/upload-allowlist'
import { focusedAboutLine, type TeammateAboutRef } from '@/lib/chat/teammate-about-ref'
import { useLiveConversation } from '@/app/account/(dashboard)/chat/use-live-conversation'
import { PACKS, type AreaKey } from '@/lib/packs/registry'

export interface UseTeammateChatOptions {
  /** The AI teammate (`ai_team_member` id) to talk to. */
  teammateId: string
  /**
   * The teammate's workspace, when the caller already knows it (the roster
   * rows carry it). Optional: the thread call answers with it either way, and
   * that answer wins.
   */
  workspaceId?: string | null
  /**
   * An area face's page (one-agent S3): the person's main-chat conversation
   * focused on this area instead of the face's thread. Null or absent: the
   * thread.
   */
  focusArea?: AreaKey | null
}

export type TeammateChatStatus = ReturnType<typeof useChat>['status']

export interface TeammateChat {
  /** The thread's messages: its history, then this session's turns as they stream. */
  messages: UIMessage[]
  /**
   * Send a message to the teammate. Waits for the thread to open; empty text
   * is a no-op. Resolves whether it went out (false: empty, or the thread
   * couldn't open), so the caller can give the text back. `opts.about` (bots
   * v3 1d): the item this message is about (one of the person's own runs or
   * cards, ids only); the mint checks it and the turn gets the item attached.
   */
  sendMessage: (text: string, opts?: TeammateSendOptions) => Promise<boolean>
  /** useChat's status: 'submitted' | 'streaming' | 'ready' | 'error'. */
  status: TeammateChatStatus
  /** Stop the reply streaming in. */
  stop: () => void
  /** The last failure: opening the thread, loading its history, or a turn. */
  error: Error | undefined
  /** The thread's conversation id (null until it opens). */
  conversationId: string | null
  /** The teammate's workspace (null until known). */
  workspaceId: string | null
  /** The teammate's name, from the thread call (null until it opens). */
  teammateName: string | null
  /** True while the thread opens and its history loads. */
  loading: boolean
  /** What an empty log says instead of its default (the agent's hand-off, TeammateChat `home`). */
  note?: string
  /** A button under the note (the agent's hand-off: open the home thread in the chat). */
  noteAction?: { label: string; run: () => void }
}

/** How a message to the teammate goes out. */
export interface TeammateSendOptions {
  /** The item the message is about (bots v3 1d); null or absent: nothing. */
  about?: TeammateAboutRef | null
  /**
   * What the full composer adds (bots v4, ConversationComposer): text files,
   * @-mentions, a skill. A teammate's thread sends them as the main chat does (chatAgentTurnBody):
   * the mint checks the skill, the spec builds the mentions' and uploads'
   * context. Never a photo: the transport would hand eve its signed link,
   * which the thread's long-lived history keeps past the link's hour (the
   * composer dims photos here; an image part is dropped before the send too).
   */
  turn?: ComposerTurnExtras | null
}

/** What the thread call answers (POST /api/account/chat/eve-session { action: 'thread' }). */
export interface TeammateThreadInfo {
  conversationId: string
  workspaceId: string
  eveSessionId: string | null
  teammate: { id: string; name: string }
}

const WORKSPACE_HEADER = 'x-workspace-id'

/**
 * Open the caller's thread with a teammate. Throws with the route's message
 * on a refusal (404 for a teammate the caller can't see).
 */
export async function openTeammateThread(
  teammateId: string,
  opts: { accessToken?: string | null; workspaceId?: string | null } = {},
): Promise<TeammateThreadInfo> {
  const res = await fetch('/api/account/chat/eve-session', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(opts.accessToken ? { Authorization: `Bearer ${opts.accessToken}` } : {}),
      ...(opts.workspaceId ? { [WORKSPACE_HEADER]: opts.workspaceId } : {}),
    },
    body: JSON.stringify({ action: 'thread', teammateId }),
  })
  const body = (await res.json().catch(() => ({}))) as Partial<TeammateThreadInfo> & { error?: unknown }
  if (!res.ok || typeof body.conversationId !== 'string' || typeof body.workspaceId !== 'string') {
    throw new Error(typeof body.error === 'string' ? body.error : `Couldn't open the conversation (${res.status})`)
  }
  return {
    conversationId: body.conversationId,
    workspaceId: body.workspaceId,
    eveSessionId: typeof body.eveSessionId === 'string' ? body.eveSessionId : null,
    teammate: {
      id: body.teammate?.id ?? teammateId,
      name: body.teammate?.name ?? 'Teammate',
    },
  }
}

/**
 * A thread's saved messages, read in the thread's own workspace (the history
 * route scopes by the resolved workspace, so the header matters for a
 * teammate in another one). Throws on a failed read.
 */
export async function loadTeammateHistory(conversationId: string, workspaceId: string): Promise<UIMessage[]> {
  const res = await fetch(`/api/account/chat-history/${encodeURIComponent(conversationId)}`, {
    headers: { [WORKSPACE_HEADER]: workspaceId },
  })
  if (!res.ok) throw new Error(`Couldn't load the conversation (${res.status})`)
  const body = (await res.json().catch(() => ({}))) as { messages?: unknown }
  return Array.isArray(body.messages) ? (body.messages as UIMessage[]) : []
}

// ── The threads (module store) ───────────────────────────────────────────────

/**
 * How many teammate threads are kept at most once idle (no bubble showing
 * them, no turn in flight): the least recently shown beyond this are let go,
 * and open (and load) again the next time.
 */
export const TEAMMATE_CHATS_KEPT = 4

/** What a mount renders from a thread: replaced, never mutated, on each change. */
interface ThreadView {
  conversationId: string | null
  workspaceId: string | null
  name: string | null
  loading: boolean
  openError: Error | undefined
}

/** One teammate thread: its Chat and transport, and where its opening stands. */
interface TeammateThread {
  key: string
  teammateId: string
  knownWorkspaceId: string | null
  chat: Chat<UIMessage>
  transport: EveChatTransport
  /** Read live by the transport (it keeps the getters it was built with). */
  conversationId: string | null
  workspaceId: string | null
  view: ThreadView
  listeners: Set<() => void>
  subscribe: (listener: () => void) => () => void
  getView: () => ThreadView
  /** Resolves whether the thread opened (history failing still leaves it open). */
  ready: Promise<boolean>
  opening: boolean
  /** Mounted hooks showing it. */
  mounts: number
  /** Sends waiting on the thread or on their turn. */
  sending: number
  /** An area face's page: the focused main-chat conversation, not the thread (one-agent S3). */
  focusArea: AreaKey | null
  lastUsed: number
  disposed: boolean
}

const threads = new Map<string, TeammateThread>()
const drafts = new Map<string, string>()
/** The user's Supabase JWT, kept fresh the way the main chat panel does; one watch for every thread. */
const auth: { token: string | null; userId: string | null; watching: boolean; unwatch: (() => void) | null } = {
  token: null,
  userId: null,
  watching: false,
  unwatch: null,
}
/** The window's workspace at the last mount (undefined: no mount yet). */
let windowWorkspace: string | null | undefined

function threadKey(teammateId: string, workspaceId: string | null, focusArea: AreaKey | null = null): string {
  return focusArea ? `focus:${focusArea}@${workspaceId ?? ''}` : `${teammateId}@${workspaceId ?? ''}`
}

/** What the focus call answers (POST /api/account/chat/eve-session { action: 'focus' }). */
export interface FocusedConversationInfo {
  conversationId: string
  workspaceId: string
  eveSessionId: string | null
}

/**
 * Open the caller's latest main-chat conversation focused on `area` in
 * `workspaceId` (else a new one). Throws with the route's message on a refusal.
 */
export async function openFocusedConversation(
  area: AreaKey,
  opts: { accessToken?: string | null; workspaceId?: string | null } = {},
): Promise<FocusedConversationInfo> {
  const res = await fetch('/api/account/chat/eve-session', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(opts.accessToken ? { Authorization: `Bearer ${opts.accessToken}` } : {}),
      ...(opts.workspaceId ? { [WORKSPACE_HEADER]: opts.workspaceId } : {}),
    },
    body: JSON.stringify({ action: 'focus', focusArea: area }),
  })
  const body = (await res.json().catch(() => ({}))) as Partial<FocusedConversationInfo> & { error?: unknown }
  if (!res.ok || typeof body.conversationId !== 'string' || typeof body.workspaceId !== 'string') {
    throw new Error(typeof body.error === 'string' ? body.error : `Couldn't open the conversation (${res.status})`)
  }
  return { conversationId: body.conversationId, workspaceId: body.workspaceId, eveSessionId: typeof body.eveSessionId === 'string' ? body.eveSessionId : null }
}

function setView(thread: TeammateThread, next: Partial<ThreadView>): void {
  thread.view = { ...thread.view, ...next }
  for (const listener of [...thread.listeners]) listener()
}

function isBusy(thread: TeammateThread): boolean {
  return thread.sending > 0 || thread.chat.status === 'submitted' || thread.chat.status === 'streaming'
}

async function refreshAccessToken(): Promise<string | null> {
  const {
    data: { session },
  } = await createClient().auth.getSession()
  const next = session?.access_token ?? null
  if (next) auth.token = next
  return next
}

/** Once per page: the JWT, and signing out (here, in another tab, or as someone else) ends every thread. */
function watchAuth(): void {
  if (auth.watching) return
  auth.watching = true
  const supabase = createClient()
  void supabase.auth.getSession().then(({ data: { session } }) => {
    if (!session?.access_token) return
    auth.token ??= session.access_token
    auth.userId ??= session.user?.id ?? null
  })
  const { data } = supabase.auth.onAuthStateChange((event, session) => {
    const userId = session?.user?.id ?? null
    if (event === 'SIGNED_OUT' || (userId && auth.userId && userId !== auth.userId)) disposeTeammateChats()
    if (session?.access_token) auth.token = session.access_token
    if (userId) auth.userId = userId
  })
  const unwipe = onTabStateWipe(disposeTeammateChats)
  auth.unwatch = () => {
    data.subscription.unsubscribe()
    unwipe()
  }
}

/** Its thread, made (Chat and transport, nothing fetched) the first time it's asked for. */
function threadFor(teammateId: string, knownWorkspaceId: string | null, focusArea: AreaKey | null = null): TeammateThread {
  const key = threadKey(teammateId, knownWorkspaceId, focusArea)
  const kept = threads.get(key)
  if (kept && !kept.disposed) {
    kept.lastUsed = Date.now()
    return kept
  }
  const thread = { key, teammateId, knownWorkspaceId, focusArea } as TeammateThread
  thread.conversationId = null
  thread.workspaceId = knownWorkspaceId
  thread.view = { conversationId: null, workspaceId: null, name: null, loading: true, openError: undefined }
  thread.listeners = new Set()
  thread.subscribe = (listener) => {
    thread.listeners.add(listener)
    return () => {
      thread.listeners.delete(listener)
    }
  }
  thread.getView = () => thread.view
  thread.ready = Promise.resolve(false)
  thread.opening = false
  thread.mounts = 0
  thread.sending = 0
  thread.lastUsed = Date.now()
  thread.disposed = false
  thread.transport = focusArea
    ? new EveChatTransport({
        // The main agent's own conversation, focused (one-agent S3): no
        // teammate on the mint, the area instead. It is listed in the chat
        // history, so the server's first-turn title backfill names it.
        getFocusArea: () => focusArea,
        workspaceId: () => thread.workspaceId,
        getAccessToken: () => auth.token,
        refreshAccessToken,
        getConversationId: () => thread.conversationId,
      })
    : new EveChatTransport({
        teammateId,
        workspaceId: () => thread.workspaceId,
        getAccessToken: () => auth.token,
        refreshAccessToken,
        getConversationId: () => thread.conversationId,
        // The thread is titled with the teammate's name at creation and never
        // shown in history: the server's first-turn title backfill stands down.
        panelNamesChats: () => true,
      })
  thread.chat = new Chat<UIMessage>({ id: focusArea ? `focus-${focusArea}` : `teammate-${teammateId}`, transport: thread.transport })
  threads.set(key, thread)
  return thread
}

/** Open the thread and load its history, unless it's open or opening. */
function openThread(thread: TeammateThread): void {
  if (thread.disposed || thread.opening || thread.conversationId) return
  thread.opening = true
  setView(thread, { loading: true, openError: undefined })
  const ready = (async () => {
    const opened = thread.focusArea
      ? await openFocusedConversation(thread.focusArea, { accessToken: auth.token, workspaceId: thread.knownWorkspaceId }).then((c) => ({
          ...c,
          teammate: { id: thread.teammateId, name: PACKS[thread.focusArea!].name },
        }))
      : await openTeammateThread(thread.teammateId, {
          accessToken: auth.token,
          workspaceId: thread.knownWorkspaceId,
        })
    if (thread.disposed) return false
    thread.conversationId = opened.conversationId
    thread.workspaceId = opened.workspaceId
    setView(thread, { conversationId: opened.conversationId, workspaceId: opened.workspaceId, name: opened.teammate.name })
    const history = await loadTeammateHistory(opened.conversationId, opened.workspaceId)
    if (!thread.disposed) thread.chat.messages = history
    return true
  })()
  thread.ready = ready.then(
    (ok) => ok,
    (err: unknown) => {
      if (!thread.disposed) setView(thread, { openError: err instanceof Error ? err : new Error(String(err)) })
      // History failing still leaves an open thread you can talk in.
      return thread.conversationId !== null
    },
  )
  void thread.ready.finally(() => {
    thread.opening = false
    if (!thread.disposed) setView(thread, { loading: false })
  })
}

/**
 * A mount takes the thread: false when it was let go between the render and
 * now (the mount renders again for a fresh one). Opens it if it isn't, or
 * again if its open failed with nothing said in it since.
 */
function retainThread(thread: TeammateThread): boolean {
  if (thread.disposed) return false
  watchAuth()
  thread.mounts++
  thread.lastUsed = Date.now()
  // The window moved to another workspace since the last mount: the threads
  // kept idle from before are let go (one streaming runs on).
  const now = getClientWorkspaceId()
  if (windowWorkspace !== undefined && now !== windowWorkspace) {
    for (const other of [...threads.values()]) if (other !== thread && other.mounts === 0 && !isBusy(other)) disposeThread(other)
  }
  windowWorkspace = now
  const failed = !!thread.view.openError && !thread.opening && !isBusy(thread) && thread.chat.messages.length === 0
  if (failed) thread.conversationId = null
  openThread(thread)
  return true
}

function releaseThread(thread: TeammateThread): void {
  thread.mounts = Math.max(0, thread.mounts - 1)
  thread.lastUsed = Date.now()
  trimThreads()
}

/** Past TEAMMATE_CHATS_KEPT, let go of the least recently shown idle threads. */
function trimThreads(): void {
  let excess = threads.size - TEAMMATE_CHATS_KEPT
  if (excess <= 0) return
  const idle = [...threads.values()].filter((t) => t.mounts === 0 && !isBusy(t)).sort((a, b) => a.lastUsed - b.lastUsed)
  for (const thread of idle) {
    if (excess-- <= 0) break
    disposeThread(thread)
  }
}

function disposeThread(thread: TeammateThread, { stop = false }: { stop?: boolean } = {}): void {
  if (thread.disposed) return
  thread.disposed = true
  if (threads.get(thread.key) === thread) threads.delete(thread.key)
  if (stop) void thread.chat.stop()
  void thread.transport.disposeAll()
}

/**
 * A turn's files without its images (text files only: their chips in the
 * bubble, and their storage facts for read_chat_file). The composer refuses
 * photos in a teammate's thread; this keeps an image off the send anyway,
 * since the transport would hand eve its signed link, which the thread's
 * long-lived history keeps past the link's hour.
 */
export function teammateTurnWithoutImages(turn: ComposerTurnExtras | null): ComposerTurnExtras | null {
  if (!turn) return null
  return {
    ...turn,
    files: turn.files.filter((f) => !isChatImageUpload({ name: f.filename ?? '', type: f.mediaType })),
    chatFiles: turn.chatFiles.filter((f) => !isChatImageUpload({ name: f.fileName, type: f.mimeType })),
  }
}

/** Send to the thread once it's open; resolves whether it went out. */
async function sendToThread(thread: TeammateThread, text: string, opts?: TeammateSendOptions): Promise<boolean> {
  const trimmed = text.trim()
  if (!trimmed) return false
  thread.sending++
  try {
    // A send before its mount's effect opened it (a child's effect runs
    // first: a message queued for a talk as it mounts): open it now.
    if (!thread.disposed && !thread.opening && !thread.conversationId && !thread.view.openError) {
      watchAuth()
      openThread(thread)
    }
    const open = await thread.ready
    if (!open || !thread.conversationId || thread.disposed) return false
    if (thread.view.openError) setView(thread, { openError: undefined })
    // What it's about rides the send (the transport mints with it, per send),
    // and so does what the full composer added (its body is the main chat's).
    // A focused conversation is the main agent's, whose token takes no item:
    // there the item's ids ride the text instead (focusedAboutLine), so the
    // main agent reads, revises or settles THAT item.
    const mainAgent = !!thread.focusArea
    const about = mainAgent ? null : (opts?.about ?? null)
    const aboutLine = mainAgent ? focusedAboutLine(opts?.about) : ''
    const turn = teammateTurnWithoutImages(opts?.turn ?? null)
    const body = {
      ...(about ? { teammateAbout: about } : {}),
      ...(turn ? chatAgentTurnBody(turn) : {}),
    }
    const files = turn?.files ?? []
    await thread.chat.sendMessage(
      { text: aboutLine ? `${trimmed}\n\n${aboutLine}` : trimmed, ...(files.length > 0 ? { files } : {}) },
      Object.keys(body).length > 0 ? { body } : undefined,
    )
    return true
  } finally {
    thread.sending--
    trimThreads()
  }
}

/**
 * Send `text` to `teammateId`'s own thread, whether or not anything shows it
 * right now (bots-v4.md Phase 3: a card's "Refine in chat" from the bubble or
 * the bot's page, posted for the chat beside it to show). The same thread a
 * TeammateChat with that teammate and `workspaceId` holds, opened first when
 * it isn't. `opts.about`: the item it's about (a card), as TeammateChat sends
 * it. Resolves whether it went out.
 */
export function sendToTeammate(
  teammateId: string,
  workspaceId: string | null,
  text: string,
  opts?: TeammateSendOptions & { focusArea?: AreaKey | null },
): Promise<boolean> {
  watchAuth()
  const thread = threadFor(teammateId, workspaceId, opts?.focusArea ?? null)
  thread.lastUsed = Date.now()
  openThread(thread)
  return sendToThread(thread, text, opts)
}

/**
 * End every teammate thread (a turn in flight is stopped) and forget the
 * drafts: signing out. Each one opens afresh on its next mount.
 */
export function disposeTeammateChats(): void {
  for (const thread of [...threads.values()]) disposeThread(thread, { stop: true })
  drafts.clear()
}

/** What's typed to this teammate and not sent yet ('' for nothing). */
export function teammateDraft(teammateId: string): string {
  return drafts.get(teammateId) ?? ''
}

/** Keep what's typed to this teammate ('' forgets it: sent, or cleared). */
export function setTeammateDraft(teammateId: string, text: string): void {
  if (text) drafts.set(teammateId, text)
  else drafts.delete(teammateId)
}

/** Tests only: forget every thread, draft and the auth watch. */
export function __resetTeammateChatsForTests(): void {
  for (const thread of [...threads.values()]) disposeThread(thread)
  threads.clear()
  drafts.clear()
  auth.unwatch?.()
  auth.token = null
  auth.userId = null
  auth.watching = false
  auth.unwatch = null
  windowWorkspace = undefined
}

// ── The hook ─────────────────────────────────────────────────────────────────

/** A teammate thread has no autosave to keep relayed rows from: nothing to mark. */
function noteNothingSaved(): void {}

export function useTeammateChat({ teammateId, workspaceId: knownWorkspaceId = null, focusArea = null }: UseTeammateChatOptions): TeammateChat {
  const [, renderAgain] = useReducer((n: number) => n + 1, 0)
  const thread = threadFor(teammateId, knownWorkspaceId, focusArea)
  useEffect(() => {
    if (!retainThread(thread)) {
      renderAgain()
      return
    }
    return () => releaseThread(thread)
  }, [thread])
  const view = useSyncExternalStore(thread.subscribe, thread.getView, thread.getView)
  // Externally managed: useChat never stops it on unmount.
  const chat = useChat({ chat: thread.chat })

  // What the main chat's assistant relays into this thread (bots v4 Phase A4:
  // the person's message, "From your main chat", and the bot's reply) is
  // written by the server, so it shows here as it lands. Only those rows: the
  // thread's own turns are the transport's (its persist is their only writer,
  // so there is nothing to mark saved).
  useLiveConversation({
    conversationId: view.conversationId,
    status: chat.status,
    setMessages: chat.setMessages,
    markSaved: noteNothingSaved,
    scope: 'relays',
    workspaceId: view.workspaceId ?? knownWorkspaceId ?? null,
  })

  const sendMessage = useCallback((text: string, opts?: TeammateSendOptions) => sendToThread(thread, text, opts), [thread])

  return {
    messages: chat.messages,
    sendMessage,
    status: chat.status,
    stop: chat.stop,
    error: chat.error ?? view.openError,
    conversationId: view.conversationId,
    workspaceId: view.workspaceId ?? knownWorkspaceId ?? null,
    teammateName: view.name,
    loading: view.loading,
  }
}
