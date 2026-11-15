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
 *           reads it) but drawn only as that line. While the conversation's
 *           job on the same agent in the same folder is still open, a send
 *           is refused with a button that opens it: follow-ups belong in its
 *           own chat. A refusal keeps the words in the box and says why.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { UIMessage } from '@ai-sdk/react'
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
import { fetchConversationSessions, fetchSessionPage, postCodeStart } from '@/components/local-agent/session-api'
import type { ComposerEnvironment, ComposerFolders } from './composer-state'
import { CodeJobLine } from './code-job-line'

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
  /** The notice's button (a refused second send: open the job that holds that folder), or null. */
  noticeAction: { label: string; run: () => void } | null
  sending: boolean
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
}

export interface ComposerCodeResult {
  /** The tabs show (the person has a Mac environment). */
  available: boolean
  /** The Code tab is the one in front: a send is a Code send. */
  active: boolean
  /** Null while the tabs don't show. */
  code: ComposerCode | null
  /** Send the words as a Code send. True when they left the box (sent, or in the thread). */
  submit: (text: string) => Promise<boolean>
  thread: CodeThread | null
}

const BUSY_LINE = 'A Chat reply is still running. Send this when it finishes, or stop it.'
const UNSAVED_LINE = 'This chat isn’t saved yet, so nothing was sent. Try again in a moment.'

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
  const [notice, setNoticeState] = useState<{ text: string; open: CodeJob | null } | null>(null)
  const setNotice = useCallback((text: string | null, open: CodeJob | null = null) => setNoticeState(text ? { text, open } : null), [])
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
  const current = choice ?? openingCodeChoice(stored, jobs, defaults)
  const agent = isPickableAgent(agents, current.agent) ? current.agent : defaults.agent
  const folderId = resolveCodeFolder(folderOptions, current.folderId)
  const tab: ComposerTab = available ? current.tab : 'chat'
  const active = tab === 'code'
  const blocker = active ? codeBlocker(chat, mac, folderId) : null

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
  const setTab = useCallback((t: ComposerTab) => update({ tab: t }), [update])
  const pickAgent = useCallback((a: string | null) => update({ agent: a }), [update])
  const pickFolder = useCallback((f: string) => update({ folderId: f }), [update])
  const addFolder = useCallback(() => {
    void addEnvironmentFolder().then(() => {
      void refreshChatEnvironment(keyRef.current, { force: true })
      void refreshEnvironments({ force: true })
    })
  }, [])

  // Open a job's own view (the Agents panel's way), by its turn's ledger row.
  const openRef = useRef(opts.openWorkItem)
  openRef.current = opts.openWorkItem
  const openJob = useCallback((workItemId: string | null) => {
    if (workItemId) openRef.current?.(workItemId)
  }, [])

  // ── The send ──────────────────────────────────────────────────────────────
  const agentLabel = codeAgentLabel(agent, agents)
  const live = { active, blocker, agent, agentLabel, folderId, mac, jobs, chatEnv: chat.environment }
  const liveRef = useRef(live)
  liveRef.current = live
  const optsRef = useRef(opts)
  optsRef.current = opts
  // One send at a time, held from before its first await (state would only
  // say so on the next render: a second Enter in between would send twice).
  const inFlightRef = useRef(false)
  const submit = useCallback(
    async (text: string): Promise<boolean> => {
      const now = liveRef.current
      const { appendMessage, conversationIdNow, chatBusy } = optsRef.current
      const words = text.trim()
      if (!now.active || !words || inFlightRef.current) return false
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
        // ended (an idle job expires on its own), then refuse with Open.
        const target = codeSendTarget(now.jobs, now.agent, now.folderId)
        if (target.kind === 'open') {
          const read = await fetchSessionPage(target.job.sessionId, Number.MAX_SAFE_INTEGER)
          const fresh = read.ok ? codeJobOf(read.value.session) : null
          if (fresh) setJobs((held) => withCodeJob(held, fresh))
          const still = fresh ?? target.job
          if (codeJobOpen(still.status)) {
            setNotice(codeJobOpenLine(still, now.agentLabel), still)
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
        })
        if (!started.ok) {
          setNotice(started.message)
          return false
        }
        const job = codeJobOf(started.value.session)
        if (job) setJobs((held) => withCodeJob(held, job))
        // It went to a job of this chat that was working there already (two
        // sends at once): the message is that job's next turn, in its line.
        const joinedOther = started.value.session.codeRequestId !== requestId
        appendMessage(codeUserMessage(words, joinedOther ? { requestId, sessionId: started.value.session.id } : { requestId }))
        // The person lands in the job's own chat.
        openJob(started.value.session.trackedJobId ?? null)
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
    [openJob, setNotice],
  )

  const layout = useMemo(() => (hasCode ? codeThreadLayout(messages, jobs) : EMPTY_CODE_LAYOUT), [hasCode, messages, jobs])
  const canOpen = !!opts.openWorkItem
  const renderLine = useCallback(
    (line: CodeLine) => {
      const job = jobs.find((j) => j.sessionId === line.sessionId || (!!line.requestId && j.requestId === line.requestId)) ?? null
      return <CodeJobLine line={line} job={job} {...(canOpen ? { onOpen: (id: string) => openJob(id) } : {})} />
    },
    [jobs, canOpen, openJob],
  )
  const thread = useMemo<CodeThread | null>(() => (layout.lines.size ? { layout, renderLine } : null), [layout, renderLine])

  const noticeJob = notice?.open ?? null
  const noticeAction = useMemo(
    () => (noticeJob?.trackedJobId && canOpen ? { label: 'Open it', run: () => openJob(noticeJob.trackedJobId) } : null),
    [noticeJob, canOpen, openJob],
  )
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
            noticeAction,
            sending,
          }
        : null,
    [available, tab, setTab, agents, agent, agentLabel, pickAgent, mac, folderOptions, folderId, pickFolder, folders.canPick, addFolder, blocker, notice, noticeAction, sending],
  )

  return { available, active: available && active, code, submit, thread }
}
