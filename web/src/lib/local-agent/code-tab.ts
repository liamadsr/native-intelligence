/**
 * The chat composer's Code tab, as pure state (chat/composer-code.ts is its
 * hook, chat/composer-code-controls.tsx its controls). Two tabs under the
 * box: Chat (Native Intelligence's own agent, as ever) and Code (the person
 * works with a coding agent directly, no chat model in between). Client-safe.
 *
 *   who may see it   a person with at least one Mac environment; nobody else
 *                    sees any tab (hasMacEnvironment)
 *   the choice       per conversation: the tab, the agent (a coding agent's
 *                    id, or null for Native Intelligence's own agent on the
 *                    Mac) and the folder, kept in localStorage per
 *                    conversation id (read and written in try/catch: a
 *                    private window keeps it for the page only)
 *   opening          the stored choice; else a conversation with a Code job
 *                    opens on Code with its newest job's agent and folder;
 *                    else Chat, with the Mac's saved worker as the agent
 *                    (environment.worker: the default agent for code there)
 *   the agents       Native Intelligence, then what the chat's Mac offers
 *                    ("Your agents": on that Mac as it says now, anywhere else
 *                    as it last told the server), then the coding agents the
 *                    registry knows that it doesn't ("Needs connection")
 *   the folders      the chat's Mac's folders; one that allows edits and is a
 *                    git repository can take a job (it works on its own branch)
 *   a send           to the conversation's newest job while it can take a
 *                    message and runs on the same agent in the same folder;
 *                    else a new job
 *   the thread       each job drawn inline after the person's message that
 *                    started it (codeThreadLayout); the later messages to it
 *                    and its finish summaries are in its own view, so the
 *                    thread draws them nowhere else
 */
import { KNOWN_CODING_AGENTS, NATIVE_WORKER_LABEL, workerLabel, type MacWorkerOffer } from '@/lib/environments/types'
import type { ChatEnvironment, EnvironmentsSnapshot, MacEnvironmentItem, ThisMacSnapshot } from './environment-client'
import type { LocalAgentStatus, SessionRow } from './store'
import { CODE_CLOUD_NEXT_REASON, codeFinishSessionOf, codeMessageMetaOf } from './code-thread'

export type ComposerTab = 'chat' | 'code'

export interface CodeTabChoice {
  tab: ComposerTab
  /** A coding agent's id, or null for Native Intelligence's own agent on the Mac. */
  agent: string | null
  /** The folder (device_folder id) a new job starts in; null: the first that can take one. */
  folderId: string | null
}

// ── Storage ─────────────────────────────────────────────────────────────────

export const CODE_TAB_STORAGE_PREFIX = 'ni.composer.code.'

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function localStorageOrNull(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

/** A stored choice, checked field by field; null when there is none (or it isn't one). */
export function parseCodeTabChoice(raw: string | null): CodeTabChoice | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Record<string, unknown>
    if (!v || typeof v !== 'object') return null
    const tab = v.tab === 'code' ? 'code' : v.tab === 'chat' ? 'chat' : null
    if (!tab) return null
    const agent = typeof v.agent === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(v.agent) ? v.agent : null
    const folderId = typeof v.folderId === 'string' && v.folderId ? v.folderId : null
    return { tab, agent, folderId }
  } catch {
    return null
  }
}

/** The choice stored for this conversation, or null (none, no id yet, or storage that throws). */
export function readCodeTabChoice(conversationId: string | null, storage: StorageLike | null = localStorageOrNull()): CodeTabChoice | null {
  if (!conversationId || !storage) return null
  try {
    return parseCodeTabChoice(storage.getItem(`${CODE_TAB_STORAGE_PREFIX}${conversationId}`))
  } catch {
    return null
  }
}

/** Keep the choice for this conversation. Storage that throws keeps nothing, and says nothing. */
export function writeCodeTabChoice(conversationId: string | null, choice: CodeTabChoice, storage: StorageLike | null = localStorageOrNull()): void {
  if (!conversationId || !storage) return
  try {
    storage.setItem(`${CODE_TAB_STORAGE_PREFIX}${conversationId}`, JSON.stringify(choice))
  } catch {
    // A private window or blocked site data: the choice lasts as long as the page.
  }
}

// ── Who sees it, and where it runs ──────────────────────────────────────────

/** The person has at least one Mac environment: the chat's own, or one in the list. */
export function hasMacEnvironment(chat: Pick<ChatEnvironment, 'environment'>, list: Pick<EnvironmentsSnapshot, 'environments'>): boolean {
  return chat.environment?.kind === 'mac' || list.environments.some((e) => e.kind === 'mac')
}

/** The chat's Mac (the list's copy, the fresher once read), or null when the chat's environment isn't a Mac. */
export function codeMacOf(chat: Pick<ChatEnvironment, 'environment'>, list: Pick<EnvironmentsSnapshot, 'environments'>): MacEnvironmentItem | null {
  const env = chat.environment
  if (!env || env.kind !== 'mac') return null
  const listed = list.environments.find((e) => e.id === env.id)
  return (listed?.kind === 'mac' ? listed : env) as MacEnvironmentItem
}

// ── The agents ──────────────────────────────────────────────────────────────

export interface CodeAgentOption {
  /** A coding agent's id, or null for Native Intelligence's own agent. */
  id: string | null
  label: string
}

export interface CodeAgentSections {
  native: CodeAgentOption
  /** What the Mac offers: may be picked. */
  yours: CodeAgentOption[]
  /** What the registry knows and the Mac doesn't offer: shown, never picked. */
  needsConnection: CodeAgentOption[]
}

/** The agent picker's sections for this Mac, as a page here can know them. */
export function codeAgentSections(mac: MacEnvironmentItem | null, thisMac: ThisMacSnapshot | null | undefined): CodeAgentSections {
  const live = mac && thisMac?.deviceId && thisMac.deviceId === mac.deviceId ? thisMac.workers : null
  const offers: readonly MacWorkerOffer[] = live ?? mac?.offeredWorkers ?? []
  const offered = new Set(offers.map((w) => w.id))
  return {
    native: { id: null, label: NATIVE_WORKER_LABEL },
    yours: offers.map((w) => ({ id: w.id, label: w.label || workerLabel(w.id) })),
    needsConnection: KNOWN_CODING_AGENTS.filter((w) => !offered.has(w.id)).map((w) => ({ id: w.id, label: w.label })),
  }
}

/** It may be picked now: our own agent, or one the Mac offers. */
export function isPickableAgent(sections: CodeAgentSections, id: string | null): boolean {
  return id === null || sections.yours.some((o) => o.id === id)
}

/** The Mac's saved worker while it offers it, else Native Intelligence's own agent. */
export function defaultCodeAgent(mac: MacEnvironmentItem | null, sections: CodeAgentSections): string | null {
  const saved = mac?.worker ?? null
  return saved && isPickableAgent(sections, saved) ? saved : null
}

/** An agent's name, as the picker shows it. */
export function codeAgentLabel(id: string | null, sections: CodeAgentSections): string {
  if (id === null) return sections.native.label
  return sections.yours.find((o) => o.id === id)?.label ?? workerLabel(id)
}

// ── The folders ─────────────────────────────────────────────────────────────

export interface CodeFolderOption {
  id: string
  label: string
  /** It allows edits and is a git repository: a job can start there. */
  usable: boolean
  /** Why it can't, in a few words (null when it can). */
  note: string | null
}

export function codeFolderOptions(mac: MacEnvironmentItem | null): CodeFolderOption[] {
  return (mac?.folders ?? []).map((f) => {
    const note = f.mode !== 'edit' ? 'Read-only: allow edits on your Mac' : !f.isGit ? 'Not a git repository' : null
    return { id: f.id, label: f.label, usable: note === null, note }
  })
}

/** The folder a send uses: the chosen one while it can take a job, else the first that can; null when none can. */
export function resolveCodeFolder(options: readonly CodeFolderOption[], chosen: string | null): string | null {
  const usable = options.filter((o) => o.usable)
  return usable.find((o) => o.id === chosen)?.id ?? usable[0]?.id ?? null
}

/**
 * Why the Code tab doesn't send now, in one plain line, or null when it can:
 * a cloud environment (comes next), no environment, or no folder that can
 * take a job on the chat's Mac.
 */
export function codeBlocker(chat: Pick<ChatEnvironment, 'environment' | 'loaded'>, mac: MacEnvironmentItem | null, folderId: string | null): string | null {
  if (!chat.loaded) return null
  if (chat.environment?.kind === 'cloud') return CODE_CLOUD_NEXT_REASON
  if (!mac) return 'Pick one of your Macs to code on.'
  if (!folderId) return `Add a folder on ${mac.name || 'your Mac'} that is a git repository and allows edits, to code there.`
  return null
}

// ── The conversation's jobs ─────────────────────────────────────────────────

export interface CodeJob {
  sessionId: string
  /** The request id of the send that started it (its key's). */
  requestId: string
  worker: string | null
  folderId: string
  status: LocalAgentStatus
  createdAt: string
}

/** The conversation's Code jobs (the list's person-started Code ones), oldest first. */
export function codeJobsOf(sessions: readonly Pick<SessionRow, 'id' | 'codeRequestId' | 'worker' | 'folderId' | 'status' | 'createdAt'>[]): CodeJob[] {
  return sessions
    .filter((s): s is typeof s & { codeRequestId: string } => typeof s.codeRequestId === 'string' && !!s.codeRequestId)
    .map((s) => ({ sessionId: s.id, requestId: s.codeRequestId, worker: s.worker ?? null, folderId: s.folderId, status: s.status, createdAt: s.createdAt }))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
}

/** One job, added or updated (a send's answer, a live status), the list kept oldest first. */
export function withCodeJob(jobs: readonly CodeJob[], job: CodeJob): CodeJob[] {
  const at = jobs.findIndex((j) => j.sessionId === job.sessionId)
  if (at < 0) return codeJobsOf([...jobs, job].map(jobAsRow))
  const held = jobs[at]
  if (held.status === job.status && held.worker === job.worker && held.folderId === job.folderId) return jobs as CodeJob[]
  const next = [...jobs]
  next[at] = { ...held, status: job.status, worker: job.worker, folderId: job.folderId }
  return next
}

const jobAsRow = (j: CodeJob) => ({ id: j.sessionId, codeRequestId: j.requestId, worker: j.worker, folderId: j.folderId, status: j.status, createdAt: j.createdAt })

const ENDED: ReadonlySet<LocalAgentStatus> = new Set(['cancelled', 'failed', 'expired'])
const WORKING: ReadonlySet<LocalAgentStatus> = new Set(['queued', 'starting', 'running'])

/** It can still take a message (it hasn't ended). */
export function codeJobOpen(status: LocalAgentStatus): boolean {
  return !ENDED.has(status)
}

/** It works right now: the composer's Stop stops it. */
export function codeJobWorking(status: LocalAgentStatus): boolean {
  return WORKING.has(status)
}

/** Where a send goes: the newest job as its next message, or a new job. */
export function codeSendTarget(latest: CodeJob | null, agent: string | null, folderId: string | null): { kind: 'message'; sessionId: string } | { kind: 'start' } {
  if (latest && codeJobOpen(latest.status) && latest.worker === agent && latest.folderId === folderId) return { kind: 'message', sessionId: latest.sessionId }
  return { kind: 'start' }
}

/**
 * The choice a conversation opens on: its stored one; else, with a Code job,
 * Code with the newest job's agent and folder; else Chat with the defaults.
 */
export function openingCodeChoice(stored: CodeTabChoice | null, jobs: readonly CodeJob[], defaults: { agent: string | null; folderId: string | null }): CodeTabChoice {
  if (stored) return stored
  const latest = jobs.at(-1)
  if (latest) return { tab: 'code', agent: latest.worker, folderId: latest.folderId }
  return { tab: 'chat', agent: defaults.agent, folderId: defaults.folderId }
}

/** The thread holds a Code message: its jobs are worth reading. */
export function threadHasCode(messages: readonly unknown[]): boolean {
  return messages.some((m) => codeMessageMetaOf(m) !== null)
}

export interface CodeThreadLayout {
  /** The message each job is drawn after (the person's message that started it): message id → job. */
  blockAfter: ReadonlyMap<string, string>
  /** Messages its job's own view shows already (a later message to it, its finish summaries). */
  hidden: ReadonlySet<string>
}

export const EMPTY_CODE_LAYOUT: CodeThreadLayout = { blockAfter: new Map(), hidden: new Set() }

/**
 * Where each job goes in the thread. A job is drawn after the person's
 * message whose request id started it; a later message sent to a drawn job,
 * and that job's finish summaries, are hidden (the job's view shows both). A
 * message whose job isn't known (its list not read yet, or gone) draws as
 * any message does.
 */
export function codeThreadLayout(messages: readonly unknown[], jobs: readonly CodeJob[]): CodeThreadLayout {
  if (jobs.length === 0) return EMPTY_CODE_LAYOUT
  const byRequest = new Map(jobs.map((j) => [j.requestId, j.sessionId]))
  const blockAfter = new Map<string, string>()
  const drawn = new Set<string>()
  const hidden = new Set<string>()
  for (const m of messages) {
    const id = (m as { id?: unknown } | null)?.id
    if (typeof id !== 'string') continue
    const meta = codeMessageMetaOf(m)
    if (meta) {
      const started = byRequest.get(meta.requestId)
      if (started && !drawn.has(started)) {
        blockAfter.set(id, started)
        drawn.add(started)
      } else if (meta.sessionId && drawn.has(meta.sessionId)) {
        hidden.add(id)
      }
      continue
    }
    const finished = codeFinishSessionOf(m)
    if (finished && drawn.has(finished)) hidden.add(id)
  }
  return blockAfter.size === 0 ? EMPTY_CODE_LAYOUT : { blockAfter, hidden }
}
