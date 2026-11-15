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
 *           when its thread holds a Code message. No timer: each job's view
 *           (code-job-block.tsx) follows its own job, and tells this hook its
 *           status
 *   a send  the person's own typed send only: to the conversation's newest
 *           job while it can take a message and runs on the same agent in the
 *           same folder (POST …/sessions/[id]/messages), else a new job (POST
 *           /api/local-agent/sessions). The person's message goes into the
 *           thread once the server took it, and is saved there as theirs. A
 *           refusal keeps the words in the box and says why, under it.
 *   Stop    while the newest job works, the composer's Stop stops it.
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
  codeJobWorking,
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
  type CodeTabChoice,
  type CodeThreadLayout,
  type ComposerTab,
} from '@/lib/local-agent/code-tab'
import { CODE_MESSAGE_METADATA_KEY, codeMessageId, type CodeMessageMeta } from '@/lib/local-agent/code-thread'
import { stampCreatedAt } from '@/lib/chat/message-time'
import {
  fetchConversationSessions,
  postCodeStart,
  postSessionMessage,
  postSessionStop,
  type PanelSession,
} from '@/components/local-agent/session-api'
import type { ComposerEnvironment, ComposerFolders } from './composer-state'
import { CodeJobBlock } from './code-job-block'

/** What ChatInput draws for the Code tab (composer-code-controls.tsx). */
export interface ComposerCode {
  tab: ComposerTab
  setTab: (tab: ComposerTab) => void
  agents: CodeAgentSections
  /** A coding agent's id, or null for Native Intelligence's own agent. */
  agent: string | null
  agentLabel: string
  pickAgent: (agent: string | null) => void
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
  sending: boolean
  /** The newest job works now: the composer's send slot is its Stop. */
  working: boolean
  stop: () => void
}

/** What the message list draws for the Code jobs. */
export interface CodeThread {
  layout: CodeThreadLayout
  renderJob: (sessionId: string) => ReactNode
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
const UNSAVED_LINE = 'This chat couldn’t be saved, so nothing was sent. Try again.'

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

function jobOf(s: PanelSession): CodeJob | null {
  if (!s.codeRequestId) return null
  return { sessionId: s.id, requestId: s.codeRequestId, worker: s.worker ?? null, folderId: s.folderId, status: s.status, createdAt: s.createdAt }
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
  const [notice, setNotice] = useState<string | null>(null)
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
  }, [conversationId])
  const stored = useMemo(() => (available ? readCodeTabChoice(conversationId) : null), [available, conversationId])

  // Its jobs, read once per conversation, and only when its thread holds a Code message.
  const hasCode = useMemo(() => available && threadHasCode(messages), [available, messages])
  const readFor = useRef<string | null>(null)
  useEffect(() => {
    if (!hasCode || !conversationId || readFor.current === conversationId) return
    readFor.current = conversationId
    let live = true
    void fetchConversationSessions(conversationId).then((res) => {
      if (!live || !res.ok || keyRef.current !== conversationId) return
      const read = codeJobsOf(res.value)
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
  const latest = jobs.at(-1) ?? null
  const working = active && !!latest && codeJobWorking(latest.status)

  const currentRef = useRef(current)
  currentRef.current = current
  const update = useCallback(
    (patch: Partial<CodeTabChoice>) => {
      const next = { ...currentRef.current, ...patch }
      setChoice(next)
      writeCodeTabChoice(keyRef.current, next)
      setNotice(null)
    },
    [],
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

  // A job's view read its session again: its status, for the send and Stop.
  const reportSession = useCallback((s: PanelSession) => {
    const job = jobOf(s)
    if (job) setJobs((held) => withCodeJob(held, job))
  }, [])

  const latestRef = useRef(latest)
  latestRef.current = latest
  const stop = useCallback(() => {
    const job = latestRef.current
    if (!job) return
    void postSessionStop(job.sessionId).then((res) => {
      if (!res.ok) setNotice(res.message)
      else if (res.value) reportSession(res.value)
    })
  }, [reportSession])

  // ── The send ──────────────────────────────────────────────────────────────
  const live = { active, blocker, agent, folderId, sending, mac, latest, chatEnv: chat.environment }
  const liveRef = useRef(live)
  liveRef.current = live
  const optsRef = useRef(opts)
  optsRef.current = opts
  const submit = useCallback(
    async (text: string): Promise<boolean> => {
      const now = liveRef.current
      const { appendMessage, conversationIdNow, chatBusy } = optsRef.current
      const words = text.trim()
      if (!now.active || !words || now.sending) return false
      if (now.blocker) {
        setNotice(now.blocker)
        return false
      }
      if (chatBusy()) {
        setNotice(BUSY_LINE)
        return false
      }
      setSending(true)
      setNotice(null)
      const requestId = newRequestId()
      try {
        const target = codeSendTarget(now.latest, now.agent, now.folderId)
        if (target.kind === 'message') {
          const sent = await postSessionMessage(target.sessionId, words, 'queue', requestId)
          if (sent.ok) {
            appendMessage(codeUserMessage(words, { requestId, sessionId: target.sessionId }))
            return true
          }
          // It ended meanwhile: the words start a new job instead. Anything else: say so.
          if (sent.status !== 409) {
            setNotice(sent.message)
            return false
          }
        }
        let conversation = await conversationIdNow()
        let inThread = false
        // A chat with no conversation yet: the message makes one (the save's own create).
        if (!conversation) {
          appendMessage(codeUserMessage(words, { requestId }))
          inThread = true
          conversation = await conversationIdNow()
        }
        if (!conversation) {
          setNotice(UNSAVED_LINE)
          return inThread
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
          return inThread
        }
        const job = jobOf(started.value.session)
        if (job) setJobs((held) => withCodeJob(held, job))
        // It went to a job of this chat that was working there already: the message is that job's next turn.
        const joinedOther = started.value.session.codeRequestId !== requestId
        if (!inThread) appendMessage(codeUserMessage(words, joinedOther ? { requestId, sessionId: started.value.session.id } : { requestId }))
        if (!started.value.deviceOnline) {
          setNotice(`${now.mac?.name || 'Your Mac'} is offline: this waits up to 6 hours for it to come online, then expires.`)
        }
        // The choice it was sent with is this conversation's from now on.
        writeCodeTabChoice(conversation, { ...currentRef.current, agent: now.agent, folderId: now.folderId })
        return true
      } finally {
        setSending(false)
      }
    },
    [],
  )

  const layout = useMemo(() => (jobs.length ? codeThreadLayout(messages, jobs) : EMPTY_CODE_LAYOUT), [messages, jobs])
  const renderJob = useCallback((sessionId: string) => <CodeJobBlock sessionId={sessionId} onSession={reportSession} />, [reportSession])
  const thread = useMemo<CodeThread | null>(() => (layout.blockAfter.size ? { layout, renderJob } : null), [layout, renderJob])

  const agentLabel = codeAgentLabel(agent, agents)
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
            macName: mac?.name ?? null,
            folders: folderOptions,
            folderId,
            pickFolder,
            canAddFolder: folders.canPick,
            addFolder,
            blocker,
            notice,
            sending,
            working,
            stop,
          }
        : null,
    [available, tab, setTab, agents, agent, agentLabel, pickAgent, mac, folderOptions, folderId, pickFolder, folders.canPick, addFolder, blocker, notice, sending, working, stop],
  )

  return { available, active: available && active, code, submit, thread }
}
