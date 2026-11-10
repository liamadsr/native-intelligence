import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/admin'
import { isMissingColumnError } from '@/lib/mcp-client/public-row'
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
  error?: string
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

/** The thread's messages, oldest first, or null when this mailbox has none of it. */
async function gmailThreadMessages(token: string, threadId: string): Promise<GmailMessageMeta[] | null> {
  const res = await providerFetch(`${GMAIL_API}/threads/${encodeURIComponent(threadId)}?format=minimal`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status === 400 || res.status === 404) return null
  if (!res.ok) throw new Error(`Gmail thread read error: ${res.status}`)
  const data = (await res.json()) as { messages?: GmailMessageMeta[] }
  const messages = (data.messages ?? []).filter((m) => typeof m?.id === 'string')
  return messages.length ? messages : null
}

async function gmailLabelList(token: string): Promise<GmailLabel[]> {
  const res = await providerFetch(`${GMAIL_API}/labels`, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`Gmail labels read error: ${res.status}`)
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
  if (!res.ok) throw new Error(`Gmail label create error: ${res.status}`)
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
  if (!res.ok) throw new Error(`Gmail modify error: ${res.status}`)
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
  if (!res.ok) throw new Error(`Outlook folder read error: ${res.status}`)
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
    if (res.status === 400 || res.status === 404) return null
    if (!res.ok) throw new Error(`Outlook thread read error: ${res.status}`)
    const data = (await res.json()) as { value?: GraphMessageMeta[]; '@odata.nextLink'?: string }
    messages.push(...(data.value ?? []).filter((m) => typeof m?.id === 'string'))
    url = data['@odata.nextLink'] ?? null
  }
  const live = messages
    .filter((m) => !folders.deleted || m.parentFolderId !== folders.deleted)
    .sort((a, b) => (b.receivedDateTime ?? '').localeCompare(a.receivedDateTime ?? ''))
  return live.length ? live : null
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
  if (!res.ok) throw new Error(`Outlook message update error: ${res.status}`)
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

/** The person's index rows for the thread in this mailbox (a legacy mailbox's have no account). */
function indexRows(db: SupabaseClient, userId: string, threadId: string, accountId: string | null, patch: Record<string, unknown>) {
  const query = db.from('email_thread_index').update(patch).eq('user_id', userId).eq('provider_thread_id', threadId)
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

/** The change in one mailbox, or null when it holds none of the thread. */
async function changeInMailbox(
  userId: string,
  mailbox: LiveMailbox,
  threadId: string,
  change: ThreadChange,
  call: TriageCall,
): Promise<ThreadTriageOutcome | null> {
  const key = mailboxKey(mailbox)
  let state: Omit<ThreadState, 'muted'>
  let apply: (applied: ThreadChange, onWrite: OnWrite, onNewestMoved: (id: string) => void) => Promise<string | null>
  const unknownLabels: string[] = []

  if (mailbox.provider === 'google') {
    const messages = await gmailThreadMessages(mailbox.token, threadId)
    if (!messages) return null
    if (messages.every((m) => (m.labelIds ?? []).some((l) => l === 'TRASH' || l === 'SPAM'))) {
      return { threadId, status: 'failed', account: mailbox.email, trashed: true, error: 'This thread is in Trash or Spam.' }
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
    const messages = await outlookConversation(mailbox.token, threadId, folders)
    if (!messages) return null
    state = outlookThreadState(messages, folders)
    apply = (applied, onWrite, onNewestMoved) => applyOutlook(mailbox.token, messages, folders, applied, onWrite, onNewestMoved)
  }
  if (call.options.skipStarred && state.starred) return { threadId, status: 'unchanged', account: mailbox.email, kept: 'starred' }

  const muted = change.mute !== undefined ? await isMuted(userId, mailbox, threadId) : false
  if (muted === null) return { threadId, status: 'failed', account: mailbox.email, error: MUTE_UNAVAILABLE }
  const { applied, undo } = effectiveChange({ ...state, muted }, change)
  const known = unknownLabels.length ? { unknownLabels } : {}
  if (isEmptyChange(applied)) return { threadId, status: 'unchanged', account: mailbox.email, ...known }

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
      applied,
      ...(wrote ? { undo } : {}),
      error: err instanceof Error ? err.message : 'The mailbox refused the change.',
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

async function changeOneThread(userId: string, workspaceId: string, threadId: string, change: ThreadChange, call: TriageCall): Promise<ThreadTriageOutcome> {
  try {
    let reached = false
    for await (const mailbox of mailboxesForThread(userId, threadId, { workspaceId })) {
      reached = true
      const outcome = mailbox.provider === 'microsoft'
        ? await call.inTurn(mailboxKey(mailbox), () => changeInMailbox(userId, mailbox, threadId, change, call))
        : await changeInMailbox(userId, mailbox, threadId, change, call)
      if (outcome) return outcome
    }
    // No mailbox to read at all (a token that won't refresh, a disabled
    // account) is a failure to retry, not a thread that is gone: only a
    // mailbox that was read and holds none of it is not_found.
    if (!reached) return { threadId, status: 'failed', error: 'No mailbox for this thread could be reached. It may need reconnecting.' }
    return { threadId, status: 'not_found', error: 'No mailbox connected to this workspace holds this thread.' }
  } catch (err) {
    return { threadId, status: 'failed', error: err instanceof Error ? err.message : 'The mailbox refused the change.' }
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
