import { createHash } from 'node:crypto'
import * as Sentry from '@sentry/nextjs'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/admin'
import { isMissingColumnError } from '@/lib/mcp-client/public-row'
import { GMAIL_NEEDS_PERMISSION, isGmailPermissionRefusal, providerErrorCode as errorCode } from './gmail-permission'
import { GMAIL_API, GRAPH_API } from './provider-drafts'
import { mailboxesForThread, type LiveMailbox } from './thread-mailbox'

/**
 * The agent's inbox triage (GEN-1166): archive a thread or put it back in the
 * inbox, mark it read or unread, star it, label it, mute it, on the thread's
 * OWN mailbox (./thread-mailbox.ts), live at Gmail or Graph.
 *
 * Every change is reversible: each thread's state is read first, only what
 * actually changes is applied, and the undo is the inverse of that (an
 * already-read thread marked read changes nothing and undoes nothing). The
 * undo is state-based too, so running it twice, or after a change that only
 * partly landed, changes only what is still to put back. Thread-level, as the
 * providers' own UIs are:
 *   archive   Gmail drops INBOX from the thread; Outlook moves the
 *             conversation's Inbox messages to Archive (sent replies stay in
 *             Sent, as Gmail's do). Back to the inbox is the whole thread's
 *             move, as Gmail's Move to Inbox: Gmail labels every message
 *             INBOX, Outlook moves the conversation's Archive messages (one
 *             filed in another folder is left there).
 *   read      every unread message read; unread marks the newest received
 *             message unread (what "Mark as unread" does in Gmail).
 *   star      the newest message starred (Outlook: flagged); unstar clears
 *             every one.
 *   labels    Gmail labels by name (a missing one is created on add, and
 *             stays in the label list after an undo); Outlook categories on
 *             every message.
 *   mute      neither provider lets an app mute, so Native Intelligence keeps the list
 *             (email_thread_mute, migration 441): the thread is archived now,
 *             and the arrival triage archives it again when a new message
 *             lands (rearchiveMutedArrivals). Unmute leaves it where it is.
 * Never Trash or Spam: nothing here deletes.
 *
 * Graph takes a few requests at once per mailbox, so an Outlook mailbox's
 * threads are changed one at a time, its folders read once per call; a
 * throttled request (429) is retried once after Retry-After. A Graph move
 * gives a message a new id: the index row's newest-message id follows it, so
 * the arrival triage doesn't take the moved message for new mail.
 */

export interface ThreadChange {
  /** true: out of the inbox; false: back into it. */
  archive?: boolean
  read?: boolean
  star?: boolean
  addLabels?: string[]
  removeLabels?: string[]
  mute?: boolean
}

export type ThreadTriageStatus = 'changed' | 'unchanged' | 'not_found' | 'failed'

export interface ThreadTriageOutcome {
  threadId: string
  status: ThreadTriageStatus
  /** The mailbox the thread is in. */
  account?: string | null
  /** What changed (no-ops left out). On a failure, what was asked of the mailbox. */
  applied?: ThreadChange
  /** The change that puts it back. On a failure, set only when part of it landed. */
  undo?: ThreadChange
  /** Gmail labels made for an add. */
  createdLabels?: string[]
  /** Labels to remove that the mailbox has no label for. */
  unknownLabels?: string[]
  /** A failure because the thread is in Trash or Spam (it is gone, not a retry). */
  trashed?: true
  /** Left alone: the thread is starred or flagged and the call keeps starred mail (ChangeOptions.skipStarred). */
  kept?: 'starred'
  /**
   * The thread isn't in the inbox at all, and the index now says so (Liam,
   * 11-24: Incoming's Done said "That email could not be archived" and the
   * email came back): 'gone', the mailbox holds none of it any more (deleted
   * there), so its index rows are removed; 'trash' / 'spam', all of it is
   * there, so its rows say that folder. Set only when the change archives or
   * mutes. The status stays what happened at the mailbox (not_found, or
   * unchanged for a plain archive of a trashed thread): a caller that wanted
   * the thread out of the inbox (Incoming's Done) takes it as done.
   */
  outOfInbox?: 'gone' | 'trash' | 'spam'
  /** On a failure, why, as a code (the error says it in plain words). */
  reason?: TriageFailReason
  /** The mailbox's provider, when known (the failure report). */
  provider?: 'google' | 'microsoft'
  /** The provider's HTTP status behind a failure, when it gave one. */
  httpStatus?: number
  /** The provider's own error code behind it (ACCESS_TOKEN_SCOPE_INSUFFICIENT, ErrorItemNotFound…), never its message. */
  code?: string
  error?: string
}

/**
 * Why a change failed:
 *   reconnect   no mailbox could be reached (its sign-in won't refresh), or the provider said 401;
 *   permission  the provider refused for want of permission (403: an older connection without the modify scope);
 *   busy        throttled (429), even after the retry;
 *   provider    the provider's own error (5xx);
 *   refused     another refusal (4xx);
 *   no_folder   an Outlook mailbox with no Archive (or Inbox) folder;
 *   trash       the thread is in Trash or Spam;
 *   unreadable  every mailbox tried refused the thread's id (400): not a thread that is gone;
 *   unknown     anything else.
 */
export type TriageFailReason = 'reconnect' | 'permission' | 'busy' | 'provider' | 'refused' | 'no_folder' | 'trash' | 'unreadable' | 'unknown'

/** A provider call that answered with an error: its provider, what it was doing, and its HTTP status. */
export class ProviderError extends Error {
  constructor(
    readonly provider: 'google' | 'microsoft',
    readonly op: string,
    readonly status: number,
    /** The provider's own error code (Google's error.status or reason, Graph's error.code), never its message. */
    readonly code: string | null = null,
  ) {
    super(`${provider === 'google' ? 'Gmail' : 'Outlook'} ${op} error: ${status}${code ? ` (${code})` : ''}`)
    this.name = 'ProviderError'
  }
}

const providerName = (provider: 'google' | 'microsoft' | null | undefined) => (provider === 'google' ? 'Gmail' : provider === 'microsoft' ? 'Outlook' : 'Your mailbox')

/** A failure in plain words, and its code. */
export function failureOf(err: unknown, provider: 'google' | 'microsoft'): { error: string; reason: TriageFailReason; httpStatus?: number; code?: string } {
  const name = providerName(provider)
  if (err instanceof ProviderError) {
    const httpStatus = err.status
    if (httpStatus === 401) return { error: `${name} needs reconnecting in Settings › Connectors.`, reason: 'reconnect', httpStatus, ...(err.code ? { code: err.code } : {}) }
    if (err.provider === 'google' && isGmailPermissionRefusal(httpStatus, err.code)) {
      // A connection made before gmail.modify was asked for (./gmail-permission.ts).
      return { error: GMAIL_NEEDS_PERMISSION, reason: 'permission', httpStatus, ...(err.code ? { code: err.code } : {}) }
    }
    if (httpStatus === 403) return { error: `${name} refused the change: it doesn’t allow Native Intelligence to change this mail. Reconnect ${name} in Settings › Connectors.`, reason: 'permission', httpStatus, ...(err.code ? { code: err.code } : {}) }
    if (httpStatus === 429) return { error: `${name} is busy right now. Try again in a minute.`, reason: 'busy', httpStatus, ...(err.code ? { code: err.code } : {}) }
    if (httpStatus >= 500) return { error: `${name} had a problem (error ${httpStatus}). Try again in a minute.`, reason: 'provider', httpStatus, ...(err.code ? { code: err.code } : {}) }
    return { error: `${name} refused the change (error ${httpStatus}).`, reason: 'refused', httpStatus, ...(err.code ? { code: err.code } : {}) }
  }
  const message = err instanceof Error ? err.message : ''
  if (/has no (Archive|Inbox) folder/.test(message)) return { error: `${message}.`, reason: 'no_folder' }
  return { error: message || `${name} refused the change.`, reason: 'unknown' }
}

/** How a whole call treats its threads. */
export interface ChangeOptions {
  /**
   * Leave a thread that is starred (Gmail: any of its messages) or flagged
   * (Outlook: any message) as it is, read live from the mailbox: the index's
   * star is the newest message's alone, and Outlook's is its importance. The
   * morning tidy (./auto-archive.ts) never archives what the person marked.
   */
  skipStarred?: boolean
}

/** Label names the flags own: archive, read and star, never labels. Trash and Spam are never touched. */
export const RESERVED_LABEL_NAMES: ReadonlySet<string> = new Set(['inbox', 'unread', 'starred', 'trash', 'spam', 'draft', 'sent', 'chat'])

/** Threads changed at once (each is a few provider calls); an Outlook mailbox's go one at a time. */
const CONCURRENCY = 3
/** The longest a throttled request waits before its one retry. */
const RETRY_MAX_MS = 5_000
const RETRY_DEFAULT_MS = 500

// ---------------------------------------------------------------------------
// Thread state and the change it takes
// ---------------------------------------------------------------------------

interface ThreadState {
  inInbox: boolean
  /** Out of the inbox where moving back can reach it (Gmail: any thread not in the inbox; Outlook: a message in Archive). */
  archived: boolean
  unread: boolean
  starred: boolean
  /** The thread's labels, by lowercased name. */
  labels: ReadonlySet<string>
  muted: boolean
}

/** The part of `change` that changes this thread, and its inverse. Pure. */
export function effectiveChange(state: ThreadState, change: ThreadChange): { applied: ThreadChange; undo: ThreadChange } {
  const applied: ThreadChange = {}
  const undo: ThreadChange = {}
  // Mute archives (a muted thread is out of the inbox).
  const archive = change.mute === true ? true : change.archive
  if (archive === true && state.inInbox) {
    applied.archive = true
    undo.archive = false
  } else if (archive === false && !state.inInbox && state.archived) {
    applied.archive = false
    undo.archive = true
  }
  if (change.mute !== undefined && change.mute !== state.muted) {
    applied.mute = change.mute
    undo.mute = !change.mute
  }
  if (change.read !== undefined && change.read === state.unread) {
    applied.read = change.read
    undo.read = !change.read
  }
  if (change.star !== undefined && change.star !== state.starred) {
    applied.star = change.star
    undo.star = !change.star
  }
  const removing = new Set((change.removeLabels ?? []).map((l) => l.toLowerCase()))
  const add = uniqueNames(change.addLabels).filter((l) => !state.labels.has(l.toLowerCase()) && !removing.has(l.toLowerCase()))
  const remove = uniqueNames(change.removeLabels).filter((l) => state.labels.has(l.toLowerCase()))
  if (add.length) {
    applied.addLabels = add
    undo.removeLabels = add
  }
  if (remove.length) {
    applied.removeLabels = remove
    undo.addLabels = remove
  }
  return { applied, undo }
}

function uniqueNames(names: readonly string[] | undefined): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of names ?? []) {
    const name = raw.trim()
    if (!name || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    out.push(name)
  }
  return out
}

function isEmptyChange(change: ThreadChange): boolean {
  return Object.keys(change).length === 0
}

/** A provider request, retried once after Retry-After (capped) when throttled. */
async function providerFetch(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init)
  if (res.status !== 429) return res
  const seconds = Number(res.headers.get('Retry-After'))
  const wait = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, RETRY_MAX_MS) : RETRY_DEFAULT_MS
  await new Promise((resolve) => setTimeout(resolve, wait))
  return fetch(url, init)
}

/** Called after each mailbox write that went through: a later failure then still returns its undo. */
type OnWrite = () => void

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------

interface GmailMessageMeta {
  id: string
  labelIds?: string[]
  internalDate?: string
}

interface GmailLabel {
  id: string
  name: string
}

/**
 * Why a mailbox has none of a thread: 'gone', it was read and holds nothing of
 * it (Gmail 404, Graph no message); 'unreadable', it refused the id (400: an
 * id from another mailbox, or one it doesn't take).
 */
type Absent = { absent: 'gone' | 'unreadable' }
const GONE: Absent = { absent: 'gone' }
const UNREADABLE: Absent = { absent: 'unreadable' }

/** The thread's messages, oldest first, or why this mailbox has none of it. */
async function gmailThreadMessages(token: string, threadId: string): Promise<GmailMessageMeta[] | Absent> {
  const res = await providerFetch(`${GMAIL_API}/threads/${encodeURIComponent(threadId)}?format=minimal`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status === 404) return GONE
  if (res.status === 400) return UNREADABLE
  if (!res.ok) throw new ProviderError('google', 'thread read', res.status, await errorCode(res))
  const data = (await res.json()) as { messages?: GmailMessageMeta[] }
  const messages = (data.messages ?? []).filter((m) => typeof m?.id === 'string')
  return messages.length ? messages : GONE
}

async function gmailLabelList(token: string): Promise<GmailLabel[]> {
  const res = await providerFetch(`${GMAIL_API}/labels`, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new ProviderError('google', 'labels read', res.status, await errorCode(res))
  const data = (await res.json()) as { labels?: GmailLabel[] }
  return (data.labels ?? []).filter((l) => typeof l?.id === 'string' && typeof l?.name === 'string')
}

async function createGmailLabel(token: string, name: string): Promise<GmailLabel | null> {
  const res = await providerFetch(`${GMAIL_API}/labels`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }),
  })
  // 409: it exists after all (made a moment ago): the caller reads the list again.
  if (res.status === 409) return null
  if (!res.ok) throw new ProviderError('google', 'label create', res.status, await errorCode(res))
  const label = (await res.json()) as GmailLabel
  return typeof label?.id === 'string' ? label : null
}

async function gmailModify(token: string, path: string, add: string[], remove: string[], onWrite?: OnWrite): Promise<void> {
  if (!add.length && !remove.length) return
  const res = await providerFetch(`${GMAIL_API}/${path}/modify`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(add.length ? { addLabelIds: add } : {}), ...(remove.length ? { removeLabelIds: remove } : {}) }),
  })
  if (!res.ok) throw new ProviderError('google', 'modify', res.status, await errorCode(res))
  onWrite?.()
}

/** The newest message that isn't a draft (and, for `received`, isn't the person's own sent one). */
function newestGmail(messages: GmailMessageMeta[], received: boolean): GmailMessageMeta | undefined {
  const time = (m: GmailMessageMeta) => Number(m.internalDate ?? 0) || 0
  const ordered = [...messages].sort((a, b) => time(b) - time(a))
  const notDraft = ordered.filter((m) => !(m.labelIds ?? []).includes('DRAFT'))
  return (received ? notDraft.find((m) => !(m.labelIds ?? []).includes('SENT')) : undefined) ?? notDraft[0] ?? ordered[0]
}

/** One call's Gmail label work: the list read once per mailbox, a missing label made once. */
class GmailLabels {
  private lists = new Map<string, Promise<GmailLabel[]>>()
  private made = new Map<string, Promise<GmailLabel | null>>()
  readonly created = new Map<string, string[]>()

  list(key: string, token: string): Promise<GmailLabel[]> {
    let list = this.lists.get(key)
    if (!list) {
      list = gmailLabelList(token)
      this.lists.set(key, list)
      list.catch(() => this.lists.delete(key))
    }
    return list
  }

  async find(key: string, token: string, name: string): Promise<GmailLabel | undefined> {
    const wanted = name.toLowerCase()
    return (await this.list(key, token)).find((l) => l.name.toLowerCase() === wanted || l.id.toLowerCase() === wanted)
  }

  /** The label named `name`, made when the mailbox has none (once per call). */
  async ensure(key: string, token: string, name: string): Promise<{ label: GmailLabel; created: boolean }> {
    const found = await this.find(key, token, name)
    if (found) return { label: found, created: false }
    const madeKey = `${key}\n${name.toLowerCase()}`
    let made = this.made.get(madeKey)
    let mine = false
    if (!made) {
      made = createGmailLabel(token, name)
      this.made.set(madeKey, made)
      mine = true
    }
    const label = await made
    if (label) {
      if (mine) this.created.set(key, [...(this.created.get(key) ?? []), label.name])
      return { label, created: mine }
    }
    // Made elsewhere in the meantime: read the list again.
    this.lists.delete(key)
    const again = await this.find(key, token, name)
    if (!again) throw new Error(`Gmail label "${name}" could not be made`)
    return { label: again, created: false }
  }
}

async function gmailThreadState(
  messages: GmailMessageMeta[],
  labelNames: (ids: ReadonlySet<string>) => Promise<ReadonlySet<string>>,
): Promise<Omit<ThreadState, 'muted'>> {
  const ids = new Set(messages.flatMap((m) => m.labelIds ?? []))
  return {
    inInbox: ids.has('INBOX'),
    // A Gmail thread out of the inbox is archived: INBOX puts it back.
    archived: !ids.has('INBOX'),
    unread: ids.has('UNREAD'),
    starred: ids.has('STARRED'),
    labels: await labelNames(ids),
  }
}

async function applyGmail(
  token: string,
  threadId: string,
  messages: GmailMessageMeta[],
  applied: ThreadChange,
  labelId: (name: string, create: boolean) => Promise<string>,
  onWrite: OnWrite,
): Promise<void> {
  const add: string[] = []
  const remove: string[] = []
  if (applied.archive === true) remove.push('INBOX')
  if (applied.archive === false) add.push('INBOX')
  if (applied.read === true) remove.push('UNREAD')
  if (applied.star === false) remove.push('STARRED')
  for (const name of applied.addLabels ?? []) add.push(await labelId(name, true))
  for (const name of applied.removeLabels ?? []) remove.push(await labelId(name, false))
  await gmailModify(token, `threads/${encodeURIComponent(threadId)}`, add, remove, onWrite)
  // Unread and star go on the newest message, as Gmail's own buttons put them.
  const messageAdd = [...(applied.read === false ? ['UNREAD'] : []), ...(applied.star === true ? ['STARRED'] : [])]
  if (messageAdd.length) {
    const unreadTarget = applied.read === false ? newestGmail(messages, true) : undefined
    const starTarget = applied.star === true ? newestGmail(messages, false) : undefined
    if (unreadTarget && starTarget && unreadTarget.id === starTarget.id) {
      await gmailModify(token, `messages/${encodeURIComponent(unreadTarget.id)}`, messageAdd, [], onWrite)
    } else {
      if (unreadTarget) await gmailModify(token, `messages/${encodeURIComponent(unreadTarget.id)}`, ['UNREAD'], [], onWrite)
      if (starTarget) await gmailModify(token, `messages/${encodeURIComponent(starTarget.id)}`, ['STARRED'], [], onWrite)
    }
  }
}

// ---------------------------------------------------------------------------
// Outlook (Graph)
// ---------------------------------------------------------------------------

interface GraphMessageMeta {
  id: string
  isRead?: boolean
  isDraft?: boolean
  parentFolderId?: string
  flag?: { flagStatus?: string }
  categories?: string[]
  receivedDateTime?: string
}

interface OutlookFolders {
  inbox: string | null
  archive: string | null
  deleted: string | null
  sent: string | null
}

async function outlookFolderId(token: string, wellKnown: string): Promise<string | null> {
  const res = await providerFetch(`${GRAPH_API}/mailFolders/${wellKnown}?$select=id`, { headers: { Authorization: `Bearer ${token}` } })
  if (res.status === 404) return null
  if (!res.ok) throw new ProviderError('microsoft', 'folder read', res.status, await errorCode(res))
  const id = ((await res.json()) as { id?: unknown }).id
  return typeof id === 'string' && id ? id : null
}

/** The mailbox's well-known folders, read one after another (Graph takes a few requests at once per mailbox). */
async function outlookFolders(token: string): Promise<OutlookFolders> {
  const inbox = await outlookFolderId(token, 'inbox')
  const archive = await outlookFolderId(token, 'archive')
  const deleted = await outlookFolderId(token, 'deleteditems')
  const sent = await outlookFolderId(token, 'sentitems')
  return { inbox, archive, deleted, sent }
}

/**
 * The conversation's messages outside Deleted Items, newest first (as
 * indexOutlookThread orders them), or null when this mailbox has none of it.
 */
async function outlookConversation(token: string, conversationId: string, folders: OutlookFolders): Promise<GraphMessageMeta[] | null> {
  const read = await readOutlookConversation(token, conversationId, folders)
  return Array.isArray(read) ? read : null
}

/**
 * The conversation's messages outside Deleted Items, newest first; 'trash'
 * when every one of them is in Deleted Items; or why this mailbox has none.
 */
async function readOutlookConversation(token: string, conversationId: string, folders: OutlookFolders): Promise<GraphMessageMeta[] | 'trash' | Absent> {
  const params = new URLSearchParams({
    // OData string literal: single quotes are escaped by doubling.
    $filter: `conversationId eq '${conversationId.replace(/'/g, "''")}'`,
    $select: 'id,isRead,isDraft,parentFolderId,flag,categories,receivedDateTime',
    $top: '100',
  })
  const messages: GraphMessageMeta[] = []
  let url: string | null = `${GRAPH_API}/messages?${params}`
  while (url) {
    const res: Response = await providerFetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (res.status === 400) return UNREADABLE
    if (res.status === 404) return GONE
    if (!res.ok) throw new ProviderError('microsoft', 'thread read', res.status, await errorCode(res))
    const data = (await res.json()) as { value?: GraphMessageMeta[]; '@odata.nextLink'?: string }
    messages.push(...(data.value ?? []).filter((m) => typeof m?.id === 'string'))
    url = data['@odata.nextLink'] ?? null
  }
  const live = messages
    .filter((m) => !folders.deleted || m.parentFolderId !== folders.deleted)
    .sort((a, b) => (b.receivedDateTime ?? '').localeCompare(a.receivedDateTime ?? ''))
  if (live.length) return live
  return messages.length ? 'trash' : GONE
}

function outlookThreadState(messages: GraphMessageMeta[], folders: OutlookFolders): Omit<ThreadState, 'muted'> {
  const received = messages.filter((m) => !m.isDraft)
  return {
    inInbox: !!folders.inbox && messages.some((m) => m.parentFolderId === folders.inbox),
    archived: !!folders.archive && messages.some((m) => m.parentFolderId === folders.archive),
    unread: received.some((m) => m.isRead === false),
    starred: messages.some((m) => m.flag?.flagStatus === 'flagged'),
    labels: new Set(messages.flatMap((m) => m.categories ?? []).map((c) => c.toLowerCase())),
  }
}

/** One Graph write; returns the message it answers with (a move answers with the moved message, under its new id). */
async function graphCall(token: string, path: string, method: 'PATCH' | 'POST', body: unknown, onWrite?: OnWrite): Promise<{ id?: unknown } | null> {
  const res = await providerFetch(`${GRAPH_API}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new ProviderError('microsoft', 'message update', res.status, await errorCode(res))
  onWrite?.()
  return (await res.json().catch(() => null)) as { id?: unknown } | null
}

/**
 * Apply the change to an Outlook conversation. Returns the newest message's
 * id when a move gave it a new one (the index row follows it), else null.
 * `onNewestMoved` hears it as soon as it moves, so a later failure still
 * lets the index follow it.
 */
async function applyOutlook(
  token: string,
  messages: GraphMessageMeta[],
  folders: OutlookFolders,
  applied: ThreadChange,
  onWrite?: OnWrite,
  onNewestMoved?: (id: string) => void,
): Promise<string | null> {
  if (applied.archive === true && !folders.archive) throw new Error('This mailbox has no Archive folder')
  if (applied.archive === false && !folders.inbox) throw new Error('This mailbox has no Inbox folder')
  const notDrafts = messages.filter((m) => !m.isDraft)
  const newest = notDrafts[0]
  // Unread goes on the newest message the person received, never their own sent one.
  const newestReceived = notDrafts.find((m) => !folders.sent || m.parentFolderId !== folders.sent) ?? newest
  const patches = new Map<string, Record<string, unknown>>()
  const patch = (id: string, fields: Record<string, unknown>) => patches.set(id, { ...patches.get(id), ...fields })

  if (applied.read === true) for (const m of notDrafts) if (m.isRead === false) patch(m.id, { isRead: true })
  if (applied.read === false && newestReceived) patch(newestReceived.id, { isRead: false })
  if (applied.star === true && newest) patch(newest.id, { flag: { flagStatus: 'flagged' } })
  if (applied.star === false) for (const m of messages) if (m.flag?.flagStatus === 'flagged') patch(m.id, { flag: { flagStatus: 'notFlagged' } })
  const adding = applied.addLabels ?? []
  const removing = new Set((applied.removeLabels ?? []).map((l) => l.toLowerCase()))
  if (adding.length || removing.size) {
    for (const m of messages) {
      const current = m.categories ?? []
      const kept = current.filter((c) => !removing.has(c.toLowerCase()))
      const have = new Set(kept.map((c) => c.toLowerCase()))
      const next = [...kept, ...adding.filter((l) => !have.has(l.toLowerCase()))]
      if (next.length !== current.length || next.some((c, i) => c !== current[i])) patch(m.id, { categories: next })
    }
  }
  for (const [id, fields] of patches) await graphCall(token, `messages/${encodeURIComponent(id)}`, 'PATCH', fields, onWrite)

  // Moves last: a Graph message id is folder-scoped, so a moved message keeps no id the patches could use.
  const from = applied.archive === true ? folders.inbox : applied.archive === false ? folders.archive : null
  let newestMovedTo: string | null = null
  if (from) {
    for (const m of messages) {
      if (m.parentFolderId !== from) continue
      const moved = await graphCall(token, `messages/${encodeURIComponent(m.id)}/move`, 'POST', { destinationId: applied.archive ? 'archive' : 'inbox' }, onWrite)
      if (m.id === messages[0].id && typeof moved?.id === 'string' && moved.id) {
        newestMovedTo = moved.id
        onNewestMoved?.(moved.id)
      }
    }
  }
  return newestMovedTo
}

// ---------------------------------------------------------------------------
// Mute (email_thread_mute, migration 441)
// ---------------------------------------------------------------------------

const MUTE_UNAVAILABLE = 'Muting is not available yet (migration 441 has not run).'

function isPre441Error(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  return isMissingColumnError(error, 'email_thread_mute')
}

function muteRows(db: SupabaseClient, userId: string, accountId: string | null, threadIds: readonly string[]) {
  let query = db.from('email_thread_mute').select('provider_thread_id').eq('user_id', userId).in('provider_thread_id', [...threadIds])
  query = accountId ? query.eq('account_id', accountId) : query.is('account_id', null)
  return query
}

/** Whether the thread is muted in this mailbox; null before migration 441. */
async function isMuted(userId: string, mailbox: LiveMailbox, threadId: string): Promise<boolean | null> {
  const { data, error } = await muteRows(getServiceClient(), userId, mailbox.accountId, [threadId])
  if (error) {
    if (isPre441Error(error)) return null
    throw new Error(`Mute read error: ${error.message}`)
  }
  return (data ?? []).length > 0
}

async function setMuted(userId: string, mailbox: LiveMailbox, threadId: string, muted: boolean): Promise<void> {
  const db = getServiceClient()
  if (muted) {
    const { error } = await db.from('email_thread_mute').insert({
      user_id: userId,
      account_id: mailbox.accountId,
      provider: mailbox.provider,
      provider_thread_id: threadId,
    })
    // 23505: muted a moment ago.
    if (error && error.code !== '23505') throw new Error(isPre441Error(error) ? MUTE_UNAVAILABLE : `Mute error: ${error.message}`)
    return
  }
  let query = db.from('email_thread_mute').delete().eq('user_id', userId).eq('provider_thread_id', threadId)
  query = mailbox.accountId ? query.eq('account_id', mailbox.accountId) : query.is('account_id', null)
  const { error } = await query
  if (error) throw new Error(isPre441Error(error) ? MUTE_UNAVAILABLE : `Unmute error: ${error.message}`)
}

// ---------------------------------------------------------------------------
// The index (what Mail lists), as the change left the thread
// ---------------------------------------------------------------------------

/**
 * The person's index rows for the thread in this mailbox (a legacy mailbox's
 * have no account), as the change just left the mailbox: stamped `synced_at`,
 * so a sync that read the mailbox before it doesn't put the old state back
 * (src/lib/crm/email-sync.ts, GMAIL_MAILBOX_STATE).
 */
function indexRows(db: SupabaseClient, userId: string, threadId: string, accountId: string | null, patch: Record<string, unknown>) {
  const query = db.from('email_thread_index').update({ ...patch, synced_at: new Date().toISOString() }).eq('user_id', userId).eq('provider_thread_id', threadId)
  return accountId ? query.eq('account_id', accountId) : query.is('account_id', null)
}

async function updateIndexRows(userId: string, threadId: string, accountId: string | null, applied: ThreadChange, newestMessageId: string | null): Promise<void> {
  const patch: Record<string, unknown> = {}
  if (applied.archive !== undefined) patch.folder = applied.archive ? 'archive' : 'inbox'
  if (applied.read !== undefined) patch.is_unread = !applied.read
  if (applied.star !== undefined) patch.is_starred = applied.star
  if (newestMessageId) patch.provider_message_id = newestMessageId
  if (!Object.keys(patch).length) return
  const { error } = await indexRows(getServiceClient(), userId, threadId, accountId, patch)
  // The mailbox changed; the next sync writes the row if this didn't.
  if (error) console.warn('[thread-triage] index row not updated:', error.message)
}

// ---------------------------------------------------------------------------
// One thread, then many
// ---------------------------------------------------------------------------

function mailboxKey(mailbox: LiveMailbox): string {
  return mailbox.accountId ?? `${mailbox.provider}:${mailbox.email ?? ''}`
}

/** What one call shares across its threads: Gmail's labels, Outlook's folders, and one Outlook thread at a time per mailbox. */
class TriageCall {
  readonly labels = new GmailLabels()
  constructor(readonly options: ChangeOptions = {}) {}
  private folders = new Map<string, Promise<OutlookFolders>>()
  private queues = new Map<string, Promise<unknown>>()

  outlookFolders(key: string, token: string): Promise<OutlookFolders> {
    let folders = this.folders.get(key)
    if (!folders) {
      folders = outlookFolders(token)
      this.folders.set(key, folders)
      folders.catch(() => this.folders.delete(key))
    }
    return folders
  }

  /** Run `work` after this mailbox's earlier work in the call has settled. */
  inTurn<T>(key: string, work: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(key) ?? Promise.resolve()).then(work, work)
    this.queues.set(key, run.catch(() => {}))
    return run
  }
}

/** Whether the change takes the thread out of the inbox (what Incoming's Done asks). */
const takesOutOfInbox = (change: ThreadChange) => change.archive === true || change.mute === true

/**
 * A thread wholly in Trash or Spam: its index rows say so, and a plain
 * archive (with or without read) is already done; anything else on it fails.
 */
async function inTrash(userId: string, mailbox: LiveMailbox, threadId: string, change: ThreadChange, where: 'trash' | 'spam'): Promise<ThreadTriageOutcome> {
  const { error } = await indexRows(getServiceClient(), userId, threadId, mailbox.accountId, { folder: where })
  if (error) console.warn('[thread-triage] trashed thread index row not updated:', error.message)
  const plainArchive = change.archive === true && Object.keys(change).every((k) => k === 'archive' || k === 'read')
  const out = takesOutOfInbox(change) ? { outOfInbox: where } : {}
  const name = providerName(mailbox.provider)
  if (plainArchive) return { threadId, status: 'unchanged', account: mailbox.email, provider: mailbox.provider, ...out }
  return {
    threadId,
    status: 'failed',
    account: mailbox.email,
    provider: mailbox.provider,
    trashed: true,
    reason: 'trash',
    ...out,
    error: `This thread is in ${where === 'spam' ? 'Spam' : 'Trash'} at ${name} (Trash or Spam is never changed here).`,
  }
}

/** The change in one mailbox, or why it holds none of the thread. */
async function changeInMailbox(
  userId: string,
  mailbox: LiveMailbox,
  threadId: string,
  change: ThreadChange,
  call: TriageCall,
): Promise<ThreadTriageOutcome | Absent> {
  const key = mailboxKey(mailbox)
  let state: Omit<ThreadState, 'muted'>
  let apply: (applied: ThreadChange, onWrite: OnWrite, onNewestMoved: (id: string) => void) => Promise<string | null>
  const unknownLabels: string[] = []

  if (mailbox.provider === 'google') {
    const messages = await gmailThreadMessages(mailbox.token, threadId)
    if (!Array.isArray(messages)) return messages
    if (messages.every((m) => (m.labelIds ?? []).some((l) => l === 'TRASH' || l === 'SPAM'))) {
      const spam = messages.every((m) => (m.labelIds ?? []).includes('SPAM'))
      return inTrash(userId, mailbox, threadId, change, spam ? 'spam' : 'trash')
    }
    const wantsLabels = !!(change.addLabels?.length || change.removeLabels?.length)
    state = await gmailThreadState(messages, async (ids) => {
      if (!wantsLabels) return new Set()
      const list = await call.labels.list(key, mailbox.token)
      return new Set(list.filter((l) => ids.has(l.id)).flatMap((l) => [l.name.toLowerCase(), l.id.toLowerCase()]))
    })
    for (const name of change.removeLabels ?? []) {
      if (!(await call.labels.find(key, mailbox.token, name))) unknownLabels.push(name)
    }
    apply = async (applied, onWrite) => {
      await applyGmail(mailbox.token, threadId, messages, applied, async (name, create) => {
        if (create) return (await call.labels.ensure(key, mailbox.token, name)).label.id
        const found = await call.labels.find(key, mailbox.token, name)
        if (!found) throw new Error(`Gmail has no label "${name}"`)
        return found.id
      }, onWrite)
      return null
    }
  } else {
    const folders = await call.outlookFolders(key, mailbox.token)
    const messages = await readOutlookConversation(mailbox.token, threadId, folders)
    if (messages === 'trash') return inTrash(userId, mailbox, threadId, change, 'trash')
    if (!Array.isArray(messages)) return messages
    state = outlookThreadState(messages, folders)
    apply = (applied, onWrite, onNewestMoved) => applyOutlook(mailbox.token, messages, folders, applied, onWrite, onNewestMoved)
  }
  if (call.options.skipStarred && state.starred) return { threadId, status: 'unchanged', account: mailbox.email, kept: 'starred' }

  const muted = change.mute !== undefined ? await isMuted(userId, mailbox, threadId) : false
  if (muted === null) return { threadId, status: 'failed', account: mailbox.email, provider: mailbox.provider, reason: 'unknown', error: MUTE_UNAVAILABLE }
  const { applied, undo } = effectiveChange({ ...state, muted }, change)
  const known = unknownLabels.length ? { unknownLabels } : {}
  if (isEmptyChange(applied)) {
    // Nothing to change in the mailbox, but the index (what Mail and the
    // Inbox list) may lag behind it: a thread archived elsewhere (a phone,
    // Gmail itself) still reads "inbox" there until the next sync. Archiving
    // it again was a no-op, so the Inbox's Done came back on its next read
    // (Liam, 11-24: "I click the check box and the emails … goes away then
    // after a few second it reappears"). The index follows the mailbox now.
    const archive = change.mute === true ? true : change.archive
    if (archive === true && !state.inInbox) await updateIndexRows(userId, threadId, mailbox.accountId, { archive: true }, null)
    else if (archive === false && state.inInbox) await updateIndexRows(userId, threadId, mailbox.accountId, { archive: false }, null)
    return { threadId, status: 'unchanged', account: mailbox.email, ...known }
  }

  // The mute row first: a failed mailbox change takes it back.
  if (applied.mute !== undefined) await setMuted(userId, mailbox, threadId, applied.mute)
  let wrote = false
  let newestMoved: string | null = null
  let newestMessageId: string | null
  try {
    const { mute: _mute, ...mailboxChange } = applied
    newestMessageId = isEmptyChange(mailboxChange) ? null : await apply(mailboxChange, () => (wrote = true), (id) => (newestMoved = id))
  } catch (err) {
    if (applied.mute !== undefined) await setMuted(userId, mailbox, threadId, !applied.mute).catch(() => {})
    // The newest message moved before the failure: the index follows its new
    // id, or the next re-index reads it as new mail.
    if (newestMoved) await updateIndexRows(userId, threadId, mailbox.accountId, {}, newestMoved)
    // Part of it may have landed: the undo is state-based, so it puts back
    // what did and leaves the rest alone.
    return {
      threadId,
      status: 'failed',
      account: mailbox.email,
      provider: mailbox.provider,
      applied,
      ...(wrote ? { undo } : {}),
      ...failureOf(err, mailbox.provider),
    }
  }
  await updateIndexRows(userId, threadId, mailbox.accountId, applied, newestMessageId)
  const created = (applied.addLabels ?? []).filter((name) => (call.labels.created.get(key) ?? []).some((c) => c.toLowerCase() === name.toLowerCase()))
  return {
    threadId,
    status: 'changed',
    account: mailbox.email,
    applied,
    undo,
    ...(created.length ? { createdLabels: created } : {}),
    ...known,
  }
}

/** The provider the person's index row for the thread names, for a mailbox that couldn't be reached. */
async function indexedProvider(userId: string, workspaceId: string, threadId: string): Promise<'google' | 'microsoft' | null> {
  try {
    const { data } = await getServiceClient()
      .from('email_thread_index')
      .select('provider')
      .eq('user_id', userId)
      .eq('workspace_id', workspaceId)
      .eq('provider_thread_id', threadId)
      .limit(1)
      .maybeSingle()
    const provider = (data as { provider?: unknown } | null)?.provider
    return provider === 'google' || provider === 'microsoft' ? provider : null
  } catch {
    return null
  }
}

/** A thread the mailbox no longer holds: gone from the index there (as the sync's triage drops a 'gone' thread). */
async function dropGone(userId: string, mailbox: LiveMailbox, threadId: string): Promise<void> {
  let query = getServiceClient()
    .from('email_thread_index')
    .delete()
    .eq('user_id', userId)
    .eq('provider', mailbox.provider)
    .eq('provider_thread_id', threadId)
  query = mailbox.accountId ? query.eq('account_id', mailbox.accountId) : query.is('account_id', null)
  const { error } = await query
  if (error) console.warn('[thread-triage] gone thread index rows not removed:', error.message)
}

async function changeOneThread(userId: string, workspaceId: string, threadId: string, change: ThreadChange, call: TriageCall): Promise<ThreadTriageOutcome> {
  let provider: 'google' | 'microsoft' | undefined
  try {
    let reached = false
    const gone: LiveMailbox[] = []
    for await (const mailbox of mailboxesForThread(userId, threadId, { workspaceId })) {
      reached = true
      provider = mailbox.provider
      const outcome = mailbox.provider === 'microsoft'
        ? await call.inTurn(mailboxKey(mailbox), () => changeInMailbox(userId, mailbox, threadId, change, call))
        : await changeInMailbox(userId, mailbox, threadId, change, call)
      if (!('absent' in outcome)) return outcome
      if (outcome.absent === 'gone') gone.push(mailbox)
    }
    // No mailbox to read at all (a token that won't refresh, a disabled
    // account) is a failure to retry, not a thread that is gone: only a
    // mailbox that was read and holds none of it is not_found.
    if (!reached) {
      const indexed = await indexedProvider(userId, workspaceId, threadId)
      return {
        threadId,
        status: 'failed',
        reason: 'reconnect',
        ...(indexed ? { provider: indexed } : {}),
        error: `${providerName(indexed)} needs reconnecting in Settings › Connectors: no mailbox for this email could be reached.`,
      }
    }
    if (!gone.length) {
      // Every mailbox refused the id: not one that is gone.
      return { threadId, status: 'not_found', provider, reason: 'unreadable', error: `${providerName(provider)} wouldn’t read this thread’s id.` }
    }
    // Read, and none of it there any more (deleted at the mailbox): out of the
    // inbox here too, when that is what was asked.
    if (takesOutOfInbox(change)) {
      for (const mailbox of gone) await dropGone(userId, mailbox, threadId)
      return { threadId, status: 'not_found', provider, outOfInbox: 'gone', error: `${providerName(provider)} no longer has this email (it was deleted there), so it’s gone from the inbox here too.` }
    }
    return { threadId, status: 'not_found', provider, error: 'No mailbox connected to this workspace holds this thread.' }
  } catch (err) {
    return { threadId, status: 'failed', ...(provider ? { provider } : {}), ...(provider ? failureOf(err, provider) : { reason: 'unknown' as const, error: err instanceof Error ? err.message : 'The mailbox refused the change.' }) }
  }
}

/** A real failure, for Sentry: its status, provider, reason and HTTP status, never the mail (the thread id hashed). */
function reportFailures(outcomes: readonly ThreadTriageOutcome[], change: ThreadChange): void {
  for (const o of outcomes) {
    const real = (o.status === 'failed' && o.reason !== 'trash') || (o.status === 'not_found' && o.reason === 'unreadable')
    if (!real) continue
    try {
      Sentry.captureMessage('email triage: a thread change failed', {
        level: 'warning',
        tags: {
          'triage.status': o.status,
          'triage.reason': o.reason ?? 'unknown',
          'triage.provider': o.provider ?? 'unknown',
          'triage.http_status': o.httpStatus !== undefined ? String(o.httpStatus) : 'none',
          'triage.provider_code': o.code ?? 'none',
          'triage.mailbox_reached': o.reason === 'reconnect' ? 'no' : 'yes',
        },
        extra: {
          thread: createHash('sha256').update(o.threadId).digest('hex').slice(0, 16),
          change: Object.keys(change).sort(),
          partly_landed: !!o.undo,
        },
      })
    } catch {
      // Reporting never breaks the change.
    }
  }
}

/**
 * Apply `change` to each thread in its own mailbox (the ones this workspace
 * may read), a few at a time. One outcome per thread, in the order given.
 * Never throws: a thread that fails says why, and the rest still change.
 */
export async function changeEmailThreads(
  userId: string,
  workspaceId: string,
  threadIds: readonly string[],
  change: ThreadChange,
  options: ChangeOptions = {},
): Promise<ThreadTriageOutcome[]> {
  const ids = [...new Set(threadIds.map((id) => id.trim()).filter(Boolean))]
  const call = new TriageCall(options)
  const outcomes: ThreadTriageOutcome[] = new Array(ids.length)
  let next = 0
  const worker = async () => {
    while (next < ids.length) {
      const i = next++
      outcomes[i] = await changeOneThread(userId, workspaceId, ids[i], change, call)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker))
  reportFailures(outcomes, change)
  return outcomes
}

/**
 * The undo of a batch, as calls: the threads whose undo is the same change go
 * in one call, in the order they first appear. A failed thread whose change
 * partly landed is in it too.
 */
export function groupUndo(outcomes: readonly ThreadTriageOutcome[]): Array<{ threadIds: string[]; change: ThreadChange }> {
  const groups = new Map<string, { threadIds: string[]; change: ThreadChange }>()
  for (const outcome of outcomes) {
    if ((outcome.status !== 'changed' && outcome.status !== 'failed') || !outcome.undo || isEmptyChange(outcome.undo)) continue
    const key = JSON.stringify(outcome.undo, Object.keys(outcome.undo).sort())
    const group = groups.get(key)
    if (group) group.threadIds.push(outcome.threadId)
    else groups.set(key, { threadIds: [outcome.threadId], change: outcome.undo })
  }
  return [...groups.values()]
}

// ---------------------------------------------------------------------------
// Arrival: a muted thread's new message skips the inbox
// ---------------------------------------------------------------------------

export interface MutedArrivalsInput {
  userId: string
  provider: 'google' | 'microsoft'
  /** The connected account; null for a legacy user+provider mailbox. */
  accountId: string | null
  accessToken: string
  /** Threads with a new newest message. */
  threadIds: readonly string[]
}

/**
 * Of these threads, the muted ones (email_thread_mute), each archived again
 * at the provider and in the index. Returns them all, archived or not: a
 * muted thread stays out of drafting and the agent's news either way. Before
 * migration 441, or when the mutes can't be read: none. Never throws.
 */
export async function rearchiveMutedArrivals(supabase: SupabaseClient, input: MutedArrivalsInput): Promise<Set<string>> {
  const muted = new Set<string>()
  if (!input.threadIds.length) return muted
  try {
    const { data, error } = await muteRows(supabase, input.userId, input.accountId, input.threadIds)
    if (error) {
      if (!isPre441Error(error)) console.warn('[thread-triage] mutes not read:', error.message)
      return muted
    }
    for (const row of (data ?? []) as Array<{ provider_thread_id?: string | null }>) {
      if (row.provider_thread_id) muted.add(row.provider_thread_id)
    }
  } catch (err) {
    console.warn('[thread-triage] mutes not read:', err instanceof Error ? err.message : err)
    return muted
  }
  let folders: OutlookFolders | null = null
  for (const threadId of muted) {
    try {
      let newestMessageId: string | null = null
      if (input.provider === 'google') {
        await gmailModify(input.accessToken, `threads/${encodeURIComponent(threadId)}`, [], ['INBOX'])
      } else {
        folders ??= await outlookFolders(input.accessToken)
        const messages = await outlookConversation(input.accessToken, threadId, folders)
        if (messages && messages.some((m) => m.parentFolderId === folders!.inbox)) {
          newestMessageId = await applyOutlook(input.accessToken, messages, folders, { archive: true })
        }
      }
      const patch = { folder: 'archive', ...(newestMessageId ? { provider_message_id: newestMessageId } : {}) }
      const { error: indexError } = await indexRows(supabase, input.userId, threadId, input.accountId, patch)
      if (indexError) console.warn('[thread-triage] muted thread index row not updated:', indexError.message)
    } catch (err) {
      console.warn(`[thread-triage] muted thread ${threadId} not archived again:`, err instanceof Error ? err.message : err)
    }
  }
  return muted
}
