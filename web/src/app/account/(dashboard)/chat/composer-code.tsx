'use client'

/**
 * The main chat composer's Code tab (lib/local-agent/code-tab.ts holds the
 * rules): the person works with a coding agent directly. The hook keeps the
 * conversation's choice (tab, agent, folder), its Code jobs, and the send.
 *
 *   reads   nothing for a person with no Mac environment (no tabs at all).
 *           The chat's environment and the list are useComposerEnvironment's;
 *           a chat on a cloud environment reads the list once, to know about
 *           the person's Macs. A conversation's jobs are read once, and only
 *           when its thread holds a Code row; their states after that come
 *           from the shell's shared ledger rows (code-job-line.tsx). No timer.
 *   a send  the person's own typed send only: a new job (POST
 *           /api/local-agent/sessions), whose own view opens at once (the
 *           Agents panel's way: useOptionalOpenWorkItem), and one compact
 *           line in the thread for it. The request is saved in the
 *           conversation as the person's words (the knowledge extraction
 *           reads it) but drawn only as that line; its row names the job's
 *           session, agent and folder, so the line never waits on a read.
 *           While the conversation's job on the same agent in the same
 *           folder is working or waiting on the person's answer, a send is
 *           refused with Open it: follow-ups belong in its own chat. Idle
 *           after a finished turn, the line offers both: Open it to continue,
 *           or Start a new job (which ends the idle one). A refusal keeps the
 *           words in the box and says why.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import { readModelChoice, writeModelChoice, type ModelChoice } from './code-model-choice'
import { toast } from 'sonner'
import {
  ENVIRONMENTS_FRESH_MS,
  addEnvironmentFolder,
  refreshChatEnvironment,
  refreshEnvironments,
} from '@/lib/local-agent/environment-client'
import {
  EMPTY_CODE_LAYOUT,
  codeAgentLabel,
  codeAgentSections,
  codeBlocker,
  codeFolderOptions,
  codeJobIdle,
  codeJobOf,
  codeJobOpen,
  codeJobOpenLine,
  codeJobsOf,
  codeMacOf,
  codeSendTarget,
  codeThreadLayout,
  defaultCodeAgent,
  hasMacEnvironment,
  isPickableAgent,
  offeredModelChoice,
  openingCodeChoice,
  readCodeTabChoice,
  resolveCodeFolder,
  threadHasCode,
  withCodeJob,
  writeCodeTabChoice,
  type CodeAgentSections,
  type CodeFolderOption,
  type CodeJob,
  type CodeLine,
  type CodeTabChoice,
  type CodeThreadLayout,
  type ComposerTab,
} from '@/lib/local-agent/code-tab'
import { CODE_MESSAGE_METADATA_KEY, codeMessageId, type CodeMessageMeta } from '@/lib/local-agent/code-thread'
import { stampCreatedAt } from '@/lib/chat/message-time'
import { fetchConversationSessions, fetchSessionPage, postCodeStart, postSessionMessage } from '@/components/local-agent/session-api'
import type { ComposerEnvironment, ComposerFolders } from './composer-state'
import { CodeJobLine } from './code-job-line'
import { closeFrontCards } from '@/components/chat-cards/front-card'
import { noteCodeChatsChanged } from '../page-panel/code-chats-store'
import { getCodeView, openCodeChatKey, subscribeCodeView } from './code-chat-live'
import { backToAgent, getCurrentChat, isOnCode, openCodingChat, pressCode, subscribeCurrentChat } from './current-chat-store'
import { draftSent } from './chat-drafts'
import type { LocalAgentStatus } from '@/lib/local-agent/store'
import { canMessageSession } from '@/lib/local-agent/transcript-view'
import { effortsFor, workerLabel } from '@/lib/environments/types'
import type { LocalAgentPolicy } from '@/lib/tauri-bridge'

/** What ChatInput draws for the Code tab (composer-code-controls.tsx). */
export interface ComposerCode {
  tab: ComposerTab
  setTab: (tab: ComposerTab) => void
  agents: CodeAgentSections
  /** A coding agent's id, or null for Native Intelligence's own agent. */
  agent: string | null
  agentLabel: string
  pickAgent: (agent: string | null) => void
  /** The chat's environment is one of the person's Macs: the agent picker shows (a cloud one has no agents to pick yet). */
  hasMac: boolean
  /** The chat's Mac's name (the picker's "Needs connection" line names it), or null. */
  macName: string | null
  folders: CodeFolderOption[]
  folderId: string | null
  pickFolder: (folderId: string) => void
  /** Select folder… is offered (the desktop app with local agents available). */
  canAddFolder: boolean
  addFolder: () => void
  /** Why it doesn't send now, in one plain line (a cloud environment, no folder), or null. */
  blocker: string | null
  /** What the last send came back with (a refusal, an offline Mac), until the next one; null when nothing. */
  notice: string | null
  /** The notice's buttons (a refused second send: open the job that holds that folder; idle: or start a new one); empty when none. */
  noticeActions: ReadonlyArray<{ id: 'open' | 'new'; label: string; run: () => void }>
  sending: boolean
  /**
   * A coding chat is open in the Code view and takes the next send as its
   * message (chat/code-chat-live.ts): who it goes to (the chat's own agent,
   * whoever the picker names for a new chat) and whether it works right now.
   * Null: the next send starts a new chat.
   */
  messaging: { agentLabel: string; working: boolean } | null
  /**
   * The model and effort a NEW chat starts its coding agent on (721), with
   * their pickers: only when the picked agent's Mac says it takes them (its
   * offer's `takesModel`); null otherwise (our own agent, an older app), and
   * the start sends none. Each null is the agent's own default. Remembered
   * per agent on this device (code-model-choice.ts).
   */
  modelChoice: {
    models: ReadonlyArray<{ id: string; label: string }>
    /** The efforts the chosen model takes (with none chosen, the default model's). */
    efforts: readonly string[]
    model: string | null
    effort: string | null
    pickModel: (model: string | null) => void
    pickEffort: (effort: string | null) => void
  } | null
}

/**
 * A message sent while the open chat's agent works (Liam, 11-20: as the main
 * chat, no Steer / Queue choice): held under the box until the turn ends,
 * then sent as the chat's next turn, with Edit and Send now (handed to the
 * agent mid-turn, a steer: a job can't be stopped mid-turn without ending
 * it). Leaving the chat hands it to the server to wait there (queue), so it
 * is never lost. `failed`: its send was refused; it waits for Send now or Edit.
 */
export interface CodeHeldMessage {
  sessionId: string
  text: string
  failed?: string
}

/** What the message list draws for the Code jobs: one compact line each. */
export interface CodeThread {
  layout: CodeThreadLayout
  renderLine: (line: CodeLine) => ReactNode
}

export interface UseComposerCodeOptions {
  /** The main chat's composer. Off: no tabs, nothing read. */
  enabled: boolean
  conversationId: string | null
  environment: ComposerEnvironment
  folders: ComposerFolders
  messages: readonly UIMessage[]
  /** Put the person's message in the thread and save it (a chat with no conversation yet makes one). */
  appendMessage: (message: UIMessage) => void
  /** The conversation's id, waiting for a first save that is out; null when it has none. */
  conversationIdNow: () => Promise<string | null>
  /** A Chat reply is streaming (a Code send waits for it). */
  chatBusy: () => boolean
  /** Open a job's own view by its turn's ledger row (useOptionalOpenWorkItem); null outside the shell. */
  openWorkItem: ((workItemId: string) => void) | null
  /** A send made from the notice's Start a new job: take these words out of the box (when they are still what it holds). */
  clearWords?: (words: string) => void
}

export interface ComposerCodeResult {
  /** The tabs show (the person has a Mac environment). */
  available: boolean
  /** The Code tab is the one in front: a send is a Code send. */
  active: boolean
  /** Null while the tabs don't show. */
  code: ComposerCode | null
  /** Send the words as a Code send. True when they left the box (sent, held, or in the thread). */
  submit: (text: string) => Promise<boolean>
  thread: CodeThread | null
  /** The message held while the open chat works (CodeHeldMessage), or null. */
  held: CodeHeldMessage | null
  /** Send now: the held message goes to the agent mid-turn. */
  sendHeldNow: () => void
  /** Edit: the held message's words, taken back for the box (null with none). */
  takeHeld: () => string | null
}

const BUSY_LINE = 'A Chat reply is still running. Send this when it finishes, or stop it.'
const UNSAVED_LINE = 'This chat isn’t saved yet, so nothing was sent. Try again in a moment.'

/** Its agent works right now (a message to it is held: CodeHeldMessage). */
function isWorkingStatus(status: string | null | undefined): boolean {
  return status === 'queued' || status === 'starting' || status === 'running'
}

function newRequestId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** The person's Code message, as the thread holds it and the save stores it. */
export function codeUserMessage(text: string, meta: CodeMessageMeta, now = Date.now()): UIMessage {
  return {
    id: codeMessageId(meta.requestId),
    role: 'user',
    parts: [{ type: 'text', text }],
    metadata: stampCreatedAt({ [CODE_MESSAGE_METADATA_KEY]: meta }, now),
  }
}


/**
 * Whether the thread holds a Code message, without reading the whole thread
 * on every streamed chunk: once found it stays found for the conversation's
 * thread; while the thread only grows (or its last message streams) only the
 * messages from the last one read are looked at. A thread that changed
 * otherwise (another conversation, a trim) is read again. Off: false.
 */
export function useThreadHasCode(messages: readonly UIMessage[], enabled: boolean): boolean {
  const seen = useRef<{ firstId: string | null; read: number; has: boolean }>({ firstId: null, read: 0, has: false })
  if (!enabled) return false
  const firstId = messages[0]?.id ?? null
  const held = seen.current
  if (held.firstId !== firstId || messages.length < held.read) {
    seen.current = { firstId, read: 0, has: false }
  }
  const at = seen.current
  if (!at.has) {
    // The last one read again: it may have been the one still streaming.
    const from = Math.max(0, at.read - 1)
    at.has = threadHasCode(messages.slice(from))
    at.read = messages.length
  }
  return at.has
}

export function useComposerCode(opts: UseComposerCodeOptions): ComposerCodeResult {
  const { enabled, conversationId, environment, folders, messages } = opts
  const { chat, list, thisMac } = environment
  const available = enabled && hasMacEnvironment(chat, list)

  // A chat on a cloud environment: whether the person has a Mac is in the list (read once).
  const onCloud = enabled && chat.loaded && chat.environment?.kind === 'cloud'
  useEffect(() => {
    if (onCloud && !list.loaded) void refreshEnvironments({ maxAgeMs: ENVIRONMENTS_FRESH_MS })
  }, [onCloud, list.loaded])

  // ── The conversation's choice and jobs ────────────────────────────────────
  const [choice, setChoice] = useState<CodeTabChoice | null>(null)
  const [jobs, setJobs] = useState<CodeJob[]>([])
  /** The notice: its line, the job it can open, and (idle after a finished turn) the words a new job would start with. */
  const [notice, setNoticeState] = useState<{ text: string; open: CodeJob | null; words: string | null } | null>(null)
  const setNotice = useCallback(
    (text: string | null, open: CodeJob | null = null, words: string | null = null) => setNoticeState(text ? { text, open, words } : null),
    [],
  )
  const [sending, setSending] = useState(false)
  const keyRef = useRef(conversationId)
  // Another conversation: its own choice and jobs. A new chat's first save
  // giving it an id keeps what was chosen there, now under that id.
  useEffect(() => {
    const prev = keyRef.current
    keyRef.current = conversationId
    if (prev === conversationId) return
    if (prev === null && conversationId) {
      setChoice((c) => {
        if (c) writeCodeTabChoice(conversationId, c)
        return c
      })
      return
    }
    setChoice(null)
    setJobs([])
    setNotice(null)
  }, [conversationId, setNotice])
  const stored = useMemo(() => (available ? readCodeTabChoice(conversationId) : null), [available, conversationId])

  // Its jobs, read once per conversation, and only when its thread holds a
  // Code row (wherever the composer is on: a Code row is never a bubble).
  const hasCode = useThreadHasCode(messages, enabled)
  const readFor = useRef<string | null>(null)
  useEffect(() => {
    if (!hasCode || !conversationId || readFor.current === conversationId) return
    readFor.current = conversationId
    let live = true
    void fetchConversationSessions(conversationId).then((res) => {
      if (!live || !res.ok || keyRef.current !== conversationId) return
      const read = codeJobsOf(res.value as Parameters<typeof codeJobsOf>[0])
      setJobs((held) => read.reduce(withCodeJob, held))
    })
    return () => {
      live = false
    }
  }, [hasCode, conversationId])

  // ── What the choice comes to here ─────────────────────────────────────────
  const mac = useMemo(() => codeMacOf(chat, list), [chat, list])
  const agents = useMemo(() => codeAgentSections(mac, thisMac), [mac, thisMac])
  const folderOptions = useMemo(() => codeFolderOptions(mac), [mac])
  const defaults = useMemo(() => ({ agent: defaultCodeAgent(mac, agents), folderId: resolveCodeFolder(folderOptions, null) }), [mac, agents, folderOptions])
  // The toggle is Home's current chat (current-chat-store.ts): the agent's, or the coding side. Never a conversation's own mode:
  // the conversation keeps the agent and the folder its coding chats start with, and its `tab` only says where the box was.
  const onCode = useSyncExternalStore(subscribeCurrentChat, isOnCode, () => false)
  const tab: ComposerTab = available && onCode ? 'code' : 'chat'
  // With no Mac there is no toggle (nothing to start a chat with), yet a coding chat that exists still opens
  // (a notification, a link): the box is that chat's while it is on screen, never the agent's under it.
  const openWithoutToggle = enabled && !available && onCode
  const chosen = choice ?? openingCodeChoice(stored, jobs, defaults)
  const current = chosen.tab === tab ? chosen : { ...chosen, tab }
  const agent = isPickableAgent(agents, current.agent) ? current.agent : defaults.agent
  // Its model and effort (721): only what its Mac's app offers for it, remembered per agent on this device.
  const choiceOffer = agent ? (agents.yours.find((o) => o.id === agent)?.choice ?? null) : null
  const [wantedChoice, setWantedChoice] = useState<{ agent: string | null; choice: ModelChoice | null }>({ agent: null, choice: null })
  // After mount, and when the agent changes: the server render and the first client one agree (the defaults).
  useEffect(() => setWantedChoice({ agent, choice: readModelChoice(agent) }), [agent])
  const wanted = wantedChoice.agent === agent ? wantedChoice.choice : null
  const chosenModel = useMemo(() => (choiceOffer ? offeredModelChoice(choiceOffer, wanted) : null), [choiceOffer, wanted])
  const folderId = resolveCodeFolder(folderOptions, current.folderId)
  const active = tab === 'code' || openWithoutToggle
  // What a NEW chat needs (a Mac, a folder). A coding chat open in the Code view takes a message without it.
  // Read as one string of what shows here (the chat's id, status, agent): the chat panel
  // never re-renders on a working chat's other updates (code-chat-live.ts openCodeChatKey).
  const openKey = useSyncExternalStore(subscribeCodeView, openCodeChatKey, () => null)
  const [openId, openStatus, openWorker] = openKey ? openKey.split('\n') : [null, null, null]
  const messagesOpenChat = active && !!openId && canMessageSession(openStatus as LocalAgentStatus)
  const blocker = active && !messagesOpenChat ? codeBlocker(chat, mac, folderId) : null
  const openChatWorking = messagesOpenChat && isWorkingStatus(openStatus)
  // One name for every agent (Liam, 11-16: "treat all coding agents the same"): the chat's own, ours or the person's.
  const openChatAgent = messagesOpenChat ? (openWorker ? workerLabel(openWorker) : 'Native Intelligence') : null
  const messaging = useMemo<ComposerCode['messaging']>(
    () => (openChatAgent ? { agentLabel: openChatAgent, working: openChatWorking } : null),
    [openChatAgent, openChatWorking],
  )

  // ── A message sent while the open chat works (CodeHeldMessage) ────────────
  const [held, setHeldState] = useState<CodeHeldMessage | null>(null)
  const heldRef = useRef(held)
  const setHeld = useCallback((next: CodeHeldMessage | null) => {
    heldRef.current = next
    setHeldState(next)
  }, [])
  /** The held message goes: to the chat on screen through its reader (its thread shows it), else straight to its session. */
  const deliverHeld = useCallback(
    async (policy: LocalAgentPolicy): Promise<void> => {
      const message = heldRef.current
      if (!message) return
      setHeld(null)
      const view = getCodeView()
      const requestId = newRequestId()
      const sent =
        view.live && view.live.session.id === message.sessionId
          ? await view.live.send(message.text, policy, requestId)
          : await postSessionMessage(message.sessionId, message.text, policy, requestId)
      if (sent.ok) {
        noteCodeChatsChanged()
        return
      }
      // Refused: it waits for Send now or Edit, never retried on its own; a newer one keeps its place.
      if (!heldRef.current) setHeld({ ...message, failed: sent.message })
    },
    [setHeld],
  )
  const deliverHeldRef = useRef(deliverHeld)
  deliverHeldRef.current = deliverHeld
  // Its turn ended (the chat on screen no longer works): it goes, as the chat's next turn.
  // The chat left (another picked, none, the agent's tab): handed to the server to wait for the turn's end there.
  useEffect(() => {
    if (!held || held.failed) return
    if (openId !== held.sessionId || !openChatWorking) void deliverHeldRef.current('queue')
  }, [held, openId, openChatWorking])
  // The composer goes (another page, a reload's unmount): the same, never lost.
  useEffect(
    () => () => {
      const message = heldRef.current
      if (message && !message.failed) void postSessionMessage(message.sessionId, message.text, 'queue', newRequestId())
    },
    [],
  )
  const sendHeldNow = useCallback(() => void deliverHeldRef.current('steer'), [])
  const takeHeld = useCallback((): string | null => {
    const message = heldRef.current
    if (!message) return null
    setHeld(null)
    return message.text
  }, [setHeld])

  const currentRef = useRef(current)
  currentRef.current = current
  const update = useCallback(
    (patch: Partial<CodeTabChoice>) => {
      const next = { ...currentRef.current, ...patch }
      setChoice(next)
      writeCodeTabChoice(keyRef.current, next)
      setNotice(null)
    },
    [setNotice],
  )
  const availableRef = useRef(available)
  availableRef.current = available
  const setTab = useCallback((t: ComposerTab) => {
    setNotice(null)
    if (t === 'code') {
      // A new coding chat, in place (Liam, 11-25: "it just changes your main agent to the coding agent, and you see it as a new chat").
      pressCode({ from: 'composer' })
      return
    }
    // Back on the agent: its chat in front again, whatever page was open over it (Liam, 11-16).
    closeFrontCards()
    backToAgent({ from: 'composer' })
  }, [setNotice])
  const pickAgent = useCallback((a: string | null) => update({ agent: a }), [update])
  const pickChoice = useCallback(
    (next: Partial<ModelChoice>) => {
      if (!choiceOffer || !agent) return
      const was = chosenModel ?? { model: null, effort: null }
      // A model that doesn't take the effort chosen drops it (offeredModelChoice): never a pair the Mac refuses.
      const choice = offeredModelChoice(choiceOffer, { ...was, ...next })
      writeModelChoice(agent, choice)
      setWantedChoice({ agent, choice })
    },
    [choiceOffer, agent, chosenModel],
  )
  const modelChoice = useMemo<ComposerCode['modelChoice']>(
    () =>
      choiceOffer && chosenModel
        ? {
            models: choiceOffer.models.map((m) => ({ id: m.id, label: m.label })),
            efforts: effortsFor(choiceOffer, chosenModel.model),
            model: chosenModel.model,
            effort: chosenModel.effort,
            pickModel: (model) => pickChoice({ model }),
            pickEffort: (effort) => pickChoice({ effort }),
          }
        : null,
    [choiceOffer, chosenModel, pickChoice],
  )
  const pickFolder = useCallback((f: string) => update({ folderId: f }), [update])
  const addFolder = useCallback(() => {
    void addEnvironmentFolder().then(() => {
      void refreshChatEnvironment(keyRef.current, { force: true })
      void refreshEnvironments({ force: true })
    })
  }, [])

  // Open a job's own view (the Agents panel's way), by its turn's ledger row;
  // with none to hand (the list not read yet, or it doesn't hold the job),
  // by the job's session: one read of it names its current turn's row.
  const openRef = useRef(opts.openWorkItem)
  openRef.current = opts.openWorkItem
  const openJob = useCallback((workItemId: string | null, sessionId: string | null = null) => {
    // In the dashboard (Liam, 11-16): the job's chat is the Code view's, its
    // conversation in the middle, whoever does the work. Its own page only
    // where its session isn't known.
    // Only where the Code view is (a Mac environment): without one the job's own page opens, as before.
    if (sessionId && availableRef.current) {
      // The current chat's one way in: the tab follows it (above).
      openCodingChat(sessionId, { from: 'composer' })
      return
    }
    if (workItemId) {
      openRef.current?.(workItemId)
      return
    }
    if (!sessionId || !openRef.current) return
    void fetchSessionPage(sessionId, Number.MAX_SAFE_INTEGER).then((read) => {
      if (!read.ok) return
      const job = codeJobOf(read.value.session)
      if (job) setJobs((held) => withCodeJob(held, job))
      const row = read.value.session.trackedJobId
      if (row) openRef.current?.(row)
    })
  }, [])

  // ── The send ──────────────────────────────────────────────────────────────
  const agentLabel = codeAgentLabel(agent, agents)
  const folderLabel = folderOptions.find((o) => o.id === folderId)?.label ?? null
  const live = { active, blocker, agent, agentLabel, folderId, folderLabel, mac, jobs, chatEnv: chat.environment, chosenModel }
  const liveRef = useRef(live)
  liveRef.current = live
  const optsRef = useRef(opts)
  optsRef.current = opts
  // One send at a time, held from before its first await (state would only
  // say so on the next render: a second Enter in between would send twice).
  const inFlightRef = useRef(false)
  /** One send: a new job (`newJob`: the idle one in that folder is ended first, the server's way). */
  const send = useCallback(
    async (words: string, newJob: boolean): Promise<boolean> => {
      const now = liveRef.current
      const { appendMessage, conversationIdNow, chatBusy } = optsRef.current
      if (!now.active || !words || inFlightRef.current) return false
      // A coding chat is open in the Code view and can take a message: the
      // words are its next turn (they land while it works, or start its next
      // one). Before what only a new chat needs (a folder picked, the agent's
      // own reply finished): this chat has its folder, and is not the
      // agent's chat. An ended chat, or none selected: a new chat, below.
      const view = getCodeView()
      // The chat on screen is still being read: the words are held, never sent off as a new chat.
      if (!newJob && view.selected && !view.live && !view.error) {
        setNotice('This chat is still loading. Send again in a moment.')
        return false
      }
      if (!newJob && view.selected && view.live && view.live.session.id === view.selected && canMessageSession(view.live.session.status)) {
        // Its agent works: held under the box until the turn ends (Send now hands it over mid-turn).
        // A second message joins the first, on its own lines.
        if (isWorkingStatus(view.live.session.status)) {
          const sessionId = view.live.session.id
          const was = heldRef.current
          setHeld(was && was.sessionId === sessionId ? { sessionId, text: `${was.text}\n\n${words}` } : { sessionId, text: words })
          setNotice(null)
          return true
        }
        inFlightRef.current = true
        setSending(true)
        setNotice(null)
        try {
          // Idle: it starts the chat's next turn.
          const sent = await view.live.send(words, 'steer', newRequestId())
          if (!sent.ok) {
            setNotice(sent.message)
            return false
          }
          noteCodeChatsChanged()
          return true
        } finally {
          inFlightRef.current = false
          setSending(false)
        }
      }
      // No toggle here (no Mac): the chat on screen can't take a message (it ended), and a new one can't start.
      // Said out loud, since the line under the box is the toggle's: the words stay in the box.
      if (!availableRef.current) {
        toast(view.selected ? 'This coding chat has ended. Go back to your agent to keep chatting.' : 'A coding chat needs the Mac app. Go back to your agent to keep chatting.')
        return false
      }
      if (now.blocker) {
        setNotice(now.blocker)
        return false
      }
      if (chatBusy()) {
        setNotice(BUSY_LINE)
        return false
      }
      inFlightRef.current = true
      setSending(true)
      setNotice(null)
      const requestId = newRequestId()
      try {
        // The conversation's job on this agent in this folder is still open:
        // follow-ups go in its own chat. Read it once to be sure it hasn't
        // ended (an idle job expires on its own), then refuse with Open it,
        // or, idle after a finished turn, offer a new job too. A read that
        // fails refuses on what was known: the words stay in the box.
        const target = codeSendTarget(now.jobs, now.agent, now.folderId)
        if (target.kind === 'open' && !newJob) {
          const read = await fetchSessionPage(target.job.sessionId, Number.MAX_SAFE_INTEGER)
          const fresh = read.ok ? codeJobOf(read.value.session) : null
          if (fresh) setJobs((held) => withCodeJob(held, fresh))
          const still = fresh ?? target.job
          if (codeJobOpen(still.status)) {
            setNotice(codeJobOpenLine(still, now.agentLabel), still, codeJobIdle(still) ? words : null)
            return false
          }
        }
        // Nothing is saved before the job is accepted: a refused start leaves
        // no message of theirs behind for the Chat agent to read as a request.
        const conversation = await conversationIdNow()
        if (!conversation) {
          setNotice(UNSAVED_LINE)
          return false
        }
        const started = await postCodeStart({
          conversationId: conversation,
          folderId: now.folderId!,
          request: words,
          worker: now.agent,
          requestId,
          ...(now.chatEnv ? { environmentId: now.chatEnv.id } : {}),
          ...(newJob ? { newJob: true } : {}),
          // Only when its Mac's app takes them (721): never a choice it would ignore.
          ...(now.chosenModel ? { model: now.chosenModel.model, effort: now.chosenModel.effort } : {}),
        })
        if (!started.ok) {
          setNotice(started.message)
          return false
        }
        const session = started.value.session
        const job = codeJobOf(session)
        // The Code view's list hears of it (page-panel/code-chats.tsx): the new chat shows at its top.
        noteCodeChatsChanged()
        if (job) setJobs((held) => withCodeJob(held, job))
        // The row names its job from the start (the line never waits on a
        // read, and a job's rows never split into two lines). It went to a
        // job of this chat that was working there already (two sends at
        // once): the message is that job's next turn, in its line.
        const joinedOther = session.codeRequestId !== requestId
        const folder = session.folderLabel || now.folderLabel || undefined
        appendMessage(
          codeUserMessage(
            words,
            joinedOther
              ? { requestId, sessionId: session.id }
              : { requestId, sessionId: session.id, start: true, worker: now.agent, ...(folder ? { folder } : {}) },
          ),
        )
        // The new chat's words went with the send: they are no draft of its when it becomes this chat (chat-drafts.ts).
        draftSent(getCurrentChat())
        // The person lands in the job's own chat.
        openJob(session.trackedJobId ?? null, session.id)
        if (!started.value.deviceOnline) {
          setNotice(`${now.mac?.name || 'Your Mac'} is offline: this waits up to 6 hours for it to come online, then expires.`)
        }
        // The choice it was sent with is this conversation's from now on.
        writeCodeTabChoice(conversation, { ...currentRef.current, agent: now.agent, folderId: now.folderId })
        return true
      } finally {
        inFlightRef.current = false
        setSending(false)
      }
    },
    [openJob, setNotice, setHeld],
  )
  const submit = useCallback((text: string) => send(text.trim(), false), [send])
  const startNew = useCallback(
    (words: string) => {
      void send(words, true).then((sent) => {
        if (sent) optsRef.current.clearWords?.(words)
      })
    },
    [send],
  )

  const layout = useMemo(() => (hasCode ? codeThreadLayout(messages, jobs) : EMPTY_CODE_LAYOUT), [hasCode, messages, jobs])
  const canOpen = !!opts.openWorkItem
  const onOpenLine = useCallback((workItemId: string | null, sessionId: string | null) => openJob(workItemId, sessionId), [openJob])
  const renderLine = useCallback(
    (line: CodeLine) => {
      const job = jobs.find((j) => j.sessionId === line.sessionId || (!!line.requestId && j.requestId === line.requestId)) ?? null
      return <CodeJobLine line={line} job={job} {...(canOpen ? { onOpen: onOpenLine } : {})} />
    },
    [jobs, canOpen, onOpenLine],
  )
  const thread = useMemo<CodeThread | null>(() => (layout.lines.size ? { layout, renderLine } : null), [layout, renderLine])

  const noticeJob = notice?.open ?? null
  const noticeWords = notice?.words ?? null
  const noticeActions = useMemo<ComposerCode['noticeActions']>(() => {
    const out: Array<ComposerCode['noticeActions'][number]> = []
    if (noticeJob && canOpen) out.push({ id: 'open', label: noticeWords ? 'Open it to continue' : 'Open it', run: () => openJob(noticeJob.trackedJobId, noticeJob.sessionId) })
    if (noticeJob && noticeWords) out.push({ id: 'new', label: 'Start a new job', run: () => startNew(noticeWords) })
    return out
  }, [noticeJob, noticeWords, canOpen, openJob, startNew])
  const code = useMemo<ComposerCode | null>(
    () =>
      available
        ? {
            tab,
            setTab,
            agents,
            agent,
            agentLabel,
            pickAgent,
            hasMac: !!mac,
            macName: mac?.name ?? null,
            folders: folderOptions,
            folderId,
            pickFolder,
            canAddFolder: folders.canPick,
            addFolder,
            blocker,
            notice: notice?.text ?? null,
            noticeActions,
            sending,
            messaging,
            modelChoice,
          }
        : null,
    [available, tab, setTab, agents, agent, agentLabel, pickAgent, mac, folderOptions, folderId, pickFolder, folders.canPick, addFolder, blocker, notice, noticeActions, sending, messaging, modelChoice],
  )

  return { available, active, code, submit, thread, held, sendHeldNow, takeHeld }
}
