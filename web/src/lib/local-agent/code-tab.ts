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
 *   a send           starts a job and opens its own view (the one the
 *                    Agents panel opens: its own chat, composer, Stop and
 *                    changes). While the conversation's job on the same agent
 *                    in the same folder is working or waiting on the
 *                    person's answer, a send is refused with a way to open
 *                    it: follow-ups belong in its own chat. Idle after a
 *                    finished turn, both ways on (open it to continue, or
 *                    start a new job, which ends it). Another folder or agent
 *                    starts another job.
 *   the thread       never the job itself: each job is ONE compact line
 *                    (codeThreadLayout: keyed by the session every row names,
 *                    with a short excerpt of the request), where its request, the follow-ups
 *                    sent to it and its finish reports collapse. They stay
 *                    in the stored history, as the person's words and the
 *                    coding agent's fenced report, for the knowledge
 *                    extraction and the chat agent's history.
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
  folderLabel: string
  deviceName: string
  status: LocalAgentStatus
  /** Its current turn's ledger row: what opens its view (the Agents panel's way). */
  trackedJobId: string | null
  /** Its agent's last turn ended on a question (ask): it waits for the person's answer. */
  asking: boolean
  createdAt: string
}

type JobRow = Pick<SessionRow, 'id' | 'codeRequestId' | 'worker' | 'folderId' | 'status' | 'createdAt'> &
  Partial<Pick<SessionRow, 'folderLabel' | 'deviceName' | 'trackedJobId' | 'lastSignal'>>

/** One session as a Code job, or null when it isn't one. */
export function codeJobOf(s: JobRow): CodeJob | null {
  if (typeof s.codeRequestId !== 'string' || !s.codeRequestId) return null
  return {
    sessionId: s.id,
    requestId: s.codeRequestId,
    worker: s.worker ?? null,
    folderId: s.folderId,
    folderLabel: s.folderLabel ?? '',
    deviceName: s.deviceName ?? '',
    status: s.status,
    trackedJobId: s.trackedJobId ?? null,
    asking: s.lastSignal === 'ask',
    createdAt: s.createdAt,
  }
}

/** The conversation's Code jobs (the list's person-started Code ones), oldest first. */
export function codeJobsOf(sessions: readonly JobRow[]): CodeJob[] {
  return sessions
    .map(codeJobOf)
    .filter((j): j is CodeJob => j !== null)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
}

/** One job, added or updated (a send's answer, a fresh read), the list kept oldest first; the same array when nothing changed. */
export function withCodeJob(jobs: readonly CodeJob[], job: CodeJob): CodeJob[] {
  const at = jobs.findIndex((j) => j.sessionId === job.sessionId)
  if (at < 0) return [...jobs, job].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  const held = jobs[at]
  const next = { ...held, ...job, folderLabel: job.folderLabel || held.folderLabel, deviceName: job.deviceName || held.deviceName, trackedJobId: job.trackedJobId ?? held.trackedJobId }
  if ((Object.keys(next) as Array<keyof CodeJob>).every((k) => next[k] === held[k])) return jobs as CodeJob[]
  const out = [...jobs]
  out[at] = next
  return out
}

const ENDED: ReadonlySet<LocalAgentStatus> = new Set(['cancelled', 'failed', 'expired'])
const WORKING: ReadonlySet<LocalAgentStatus> = new Set(['queued', 'starting', 'running'])

/** It can still take a message (it hasn't ended). */
export function codeJobOpen(status: LocalAgentStatus): boolean {
  return !ENDED.has(status)
}

/** It works right now. */
export function codeJobWorking(status: LocalAgentStatus): boolean {
  return WORKING.has(status)
}

/** It is idle after a finished turn: open, not working, not waiting on the person's answer. */
export function codeJobIdle(job: Pick<CodeJob, 'status' | 'asking'>): boolean {
  return job.status === 'waiting' && !job.asking
}

/**
 * Where a send goes: a new job, unless the conversation already has an open
 * one on the same agent in the same folder (its follow-ups go in its own
 * chat, so the send is refused with a way to open it). The newest such job.
 */
export function codeSendTarget(jobs: readonly CodeJob[], agent: string | null, folderId: string | null): { kind: 'open'; job: CodeJob } | { kind: 'start' } {
  for (let i = jobs.length - 1; i >= 0; i--) {
    const j = jobs[i]
    if (j.worker === agent && j.folderId === folderId && codeJobOpen(j.status)) return { kind: 'open', job: j }
  }
  return { kind: 'start' }
}

/**
 * The sentence a send to a still-open job shows. Working or asking: the send
 * is refused, with Open it. Idle after a finished turn: two ways on, in one
 * line (Open it to continue, or Start a new job, which ends that one).
 */
export function codeJobOpenLine(job: Pick<CodeJob, 'status' | 'folderLabel' | 'asking'>, agentLabel: string): string {
  const folder = job.folderLabel || 'that folder'
  if (codeJobWorking(job.status)) return `${agentLabel} is already working in ${folder}: open it to continue.`
  if (job.status === 'waiting' && job.asking) return `${agentLabel} is waiting for your answer in ${folder}: open it to answer.`
  if (codeJobIdle(job)) return `${agentLabel} finished in ${folder}, and that job is still open.`
  return `${agentLabel}'s job in ${folder} is still open: open it to continue there.`
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

/** The message is one of a Code job's stored rows: the person's request or follow-up, or the agent's finish report. */
export function isCodeRow(message: unknown): boolean {
  return codeMessageMetaOf(message) !== null || codeFinishSessionOf(message) !== null
}

/** The thread holds a Code row: its jobs are worth reading. */
export function threadHasCode(messages: readonly unknown[]): boolean {
  return messages.some(isCodeRow)
}

/** A job's one line in the thread: its session (the request's row names it), else the request that started it. */
export interface CodeLine {
  /** `session:<id>` or `request:<id>`: one line per job. */
  key: string
  sessionId: string | null
  requestId: string | null
  /** A short one-line excerpt of the request's words, when the line's row is the request; else null. */
  request: string | null
  /** The agent and folder the request row names (undefined / null when it names none: an older row, a follow-up). */
  worker?: string | null
  folder: string | null
}

export const CODE_EXCERPT_MAX = 80

/** The request's words as one short line: whitespace folded, cut at a word near the limit with an ellipsis. */
export function codeRequestExcerpt(text: string, max = CODE_EXCERPT_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

export interface CodeThreadLayout {
  /** The row each job's one line takes the place of: message id → the line. */
  lines: ReadonlyMap<string, CodeLine>
  /** Its other stored rows (follow-ups, finish reports): drawn nowhere in the thread. */
  hidden: ReadonlySet<string>
}

export const EMPTY_CODE_LAYOUT: CodeThreadLayout = { lines: new Map(), hidden: new Set() }

function textOf(message: unknown): string {
  const parts = (message as { parts?: unknown } | null)?.parts
  return (Array.isArray(parts) ? parts : [])
    .map((p) => (p && typeof p === 'object' && (p as { type?: unknown }).type === 'text' ? (p as { text?: unknown }).text : null))
    .filter((t): t is string => typeof t === 'string')
    .join(' ')
    .trim()
}

/**
 * The thread's Code rows as one line per job, never as bubbles: the first
 * of a job's rows (its request, normally) takes the line; the rest (the
 * follow-ups sent to it, its finish reports) are hidden. Every row names its
 * session (the request's row from the moment its start was accepted, a
 * follow-up and a finish report always), so a job's rows share one key
 * whether or not its jobs list has been read; only a row that names none
 * (written before rows carried it) is tied through `jobs` by its request id,
 * else keyed by its request: still a line, never a bubble to the chat agent.
 */
export function codeThreadLayout(messages: readonly unknown[], jobs: readonly CodeJob[]): CodeThreadLayout {
  const byRequest = new Map(jobs.map((j) => [j.requestId, j.sessionId]))
  const lines = new Map<string, CodeLine>()
  const drawn = new Set<string>()
  const hidden = new Set<string>()
  for (const m of messages) {
    const id = (m as { id?: unknown } | null)?.id
    if (typeof id !== 'string') continue
    const meta = codeMessageMetaOf(m)
    const finished = meta ? null : codeFinishSessionOf(m)
    if (!meta && !finished) continue
    const sessionId = meta ? (meta.sessionId ?? byRequest.get(meta.requestId) ?? null) : finished
    const key = sessionId ? `session:${sessionId}` : `request:${meta!.requestId}`
    if (drawn.has(key)) {
      hidden.add(id)
      continue
    }
    drawn.add(key)
    const isRequest = !!meta && (meta.start === true || !meta.sessionId)
    const words = isRequest ? textOf(m) : ''
    lines.set(id, {
      key,
      sessionId,
      requestId: meta?.requestId ?? null,
      request: words ? codeRequestExcerpt(words) : null,
      ...(meta && 'worker' in meta ? { worker: meta.worker ?? null } : {}),
      folder: meta?.folder ?? null,
    })
  }
  return lines.size === 0 ? EMPTY_CODE_LAYOUT : { lines, hidden }
}
