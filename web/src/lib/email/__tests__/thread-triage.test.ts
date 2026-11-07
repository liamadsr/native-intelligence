import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

/**
 * The agent's inbox triage (src/lib/email/thread-triage.ts, GEN-1166): each
 * thread's state is read from its own mailbox first, only what changes is
 * applied, and the undo is exactly the inverse. Gmail and Outlook are played
 * by a fetch double that keeps each mailbox's labels / folders, so a change
 * followed by its undo can be checked to leave the mailbox as it was.
 */

let db: FakeSupabase
let mailbox: { provider: 'google' | 'microsoft'; token: string; email: string | null; accountId: string | null } | null

vi.mock('@/lib/admin', () => ({ getServiceClient: () => db }))
vi.mock('@/lib/email/thread-mailbox', () => ({
  mailboxesForThread: async function* () {
    if (mailbox) yield mailbox
  },
}))

const { changeEmailThreads, effectiveChange, groupUndo, rearchiveMutedArrivals } = await import('@/lib/email/thread-triage')

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'
const GRAPH = 'https://graph.microsoft.com/v1.0/me'

// ── A Gmail double: threads of messages with label ids, and a label list ──
let gmailThreads: Record<string, Array<{ id: string; labelIds: string[]; internalDate: string }>>
let gmailLabels: Array<{ id: string; name: string; type?: string }>
// ── A Graph double: conversations of messages in folders ──
let graphMessages: Array<{ id: string; conversationId: string; isRead: boolean; isDraft?: boolean; parentFolderId: string; flag?: { flagStatus: string }; categories?: string[]; receivedDateTime: string }>
let calls: Array<{ method: string; url: string; body?: unknown }>

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input)
  const method = init?.method ?? 'GET'
  const body = init?.body ? JSON.parse(String(init.body)) : undefined
  calls.push({ method, url, body })

  if (url.startsWith(GMAIL)) {
    const path = url.slice(GMAIL.length)
    const thread = /^\/threads\/([^/?]+)\?format=minimal$/.exec(path)
    if (thread && method === 'GET') {
      const messages = gmailThreads[decodeURIComponent(thread[1])]
      return Promise.resolve(messages ? json({ messages }) : json({}, 404))
    }
    const modify = /^\/(threads|messages)\/([^/]+)\/modify$/.exec(path)
    if (modify && method === 'POST') {
      const id = decodeURIComponent(modify[2])
      const targets = modify[1] === 'threads'
        ? gmailThreads[id] ?? []
        : Object.values(gmailThreads).flat().filter((m) => m.id === id)
      for (const m of targets) {
        m.labelIds = m.labelIds.filter((l) => !(body.removeLabelIds ?? []).includes(l))
        for (const l of body.addLabelIds ?? []) if (!m.labelIds.includes(l)) m.labelIds.push(l)
      }
      return Promise.resolve(json({}))
    }
    if (path === '/labels' && method === 'GET') return Promise.resolve(json({ labels: gmailLabels }))
    if (path === '/labels' && method === 'POST') {
      const label = { id: `Label_${gmailLabels.length + 1}`, name: body.name, type: 'user' }
      gmailLabels.push(label)
      return Promise.resolve(json(label))
    }
  }

  if (url.startsWith(GRAPH)) {
    const path = url.slice(GRAPH.length)
    const folder = /^\/mailFolders\/(\w+)\?\$select=id$/.exec(path)
    if (folder) return Promise.resolve(json({ id: `folder-${folder[1]}` }))
    if (path.startsWith('/messages?')) {
      const filter = new URL(url).searchParams.get('$filter') ?? ''
      const conversation = /conversationId eq '(.*)'/.exec(filter)?.[1]
      return Promise.resolve(json({ value: graphMessages.filter((m) => m.conversationId === conversation).map((m) => ({ ...m })) }))
    }
    const move = /^\/messages\/([^/]+)\/move$/.exec(path)
    if (move && method === 'POST') {
      const m = graphMessages.find((x) => x.id === decodeURIComponent(move[1]))
      if (m) m.parentFolderId = `folder-${body.destinationId}`
      // Graph answers with the moved message, under a new id (the double keeps the old one, for the tests' lookups).
      return Promise.resolve(json({ ...m, id: `${m?.id}-moved` }))
    }
    const patch = /^\/messages\/([^/?]+)$/.exec(path)
    if (patch && method === 'PATCH') {
      const m = graphMessages.find((x) => x.id === decodeURIComponent(patch[1]))
      if (m) Object.assign(m, body)
      return Promise.resolve(json({}))
    }
  }
  return Promise.resolve(json({ error: `unexpected ${method} ${url}` }, 500))
}

const GOOGLE = { provider: 'google' as const, token: 'g-tok', email: 'me@gmail.com', accountId: 'acct-g' }
const MICROSOFT = { provider: 'microsoft' as const, token: 'm-tok', email: 'me@outlook.com', accountId: 'acct-m' }

beforeEach(() => {
  db = makeFakeSupabase()
  mailbox = GOOGLE
  calls = []
  gmailLabels = [
    { id: 'INBOX', name: 'INBOX', type: 'system' },
    { id: 'UNREAD', name: 'UNREAD', type: 'system' },
    { id: 'Label_1', name: 'Receipts', type: 'user' },
  ]
  gmailThreads = {
    amazon: [
      { id: 'a1', labelIds: ['INBOX', 'UNREAD', 'CATEGORY_UPDATES'], internalDate: '1000' },
      { id: 'a2', labelIds: ['INBOX', 'UNREAD'], internalDate: '2000' },
    ],
    archived: [{ id: 'z1', labelIds: ['Label_1'], internalDate: '1000' }],
    trashed: [{ id: 't1', labelIds: ['TRASH'], internalDate: '1000' }],
  }
  graphMessages = [
    { id: 'o1', conversationId: 'conv-1', isRead: false, parentFolderId: 'folder-inbox', receivedDateTime: '2026-10-27T08:00:00Z' },
    { id: 'o2', conversationId: 'conv-1', isRead: true, parentFolderId: 'folder-sentitems', receivedDateTime: '2026-10-27T09:00:00Z' },
    { id: 'o3', conversationId: 'conv-1', isRead: true, parentFolderId: 'folder-deleteditems', receivedDateTime: '2026-10-27T10:00:00Z' },
  ]
  vi.stubGlobal('fetch', vi.fn(fakeFetch))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const STATE = { inInbox: true, archived: false, unread: true, starred: false, labels: new Set<string>(['receipts']), muted: false }

describe('effectiveChange', () => {
  it('keeps only what changes the thread, and inverts it', () => {
    expect(effectiveChange(STATE, { archive: true, read: true, star: false, addLabels: ['Receipts', 'Travel'], removeLabels: ['Old'] })).toEqual({
      applied: { archive: true, read: true, addLabels: ['Travel'] },
      undo: { archive: false, read: false, removeLabels: ['Travel'] },
    })
  })

  it('changes nothing already so', () => {
    expect(effectiveChange({ ...STATE, inInbox: false, archived: true, unread: false }, { archive: true, read: true })).toEqual({ applied: {}, undo: {} })
  })

  it('moves back to the inbox only a thread that is archived (an Outlook thread filed elsewhere stays)', () => {
    expect(effectiveChange({ ...STATE, inInbox: false, archived: true }, { archive: false })).toEqual({ applied: { archive: false }, undo: { archive: true } })
    expect(effectiveChange({ ...STATE, inInbox: false, archived: false }, { archive: false })).toEqual({ applied: {}, undo: {} })
  })

  it('mute archives a thread in the inbox, and its undo brings it back unmuted', () => {
    expect(effectiveChange(STATE, { mute: true })).toEqual({
      applied: { archive: true, mute: true },
      undo: { archive: false, mute: false },
    })
  })

  it('unmute leaves the thread where it is', () => {
    expect(effectiveChange({ ...STATE, inInbox: false, muted: true }, { mute: false })).toEqual({
      applied: { mute: false },
      undo: { mute: true },
    })
  })

  it('removes a label it has, case-insensitively, and puts it back on undo', () => {
    expect(effectiveChange(STATE, { removeLabels: ['RECEIPTS'] })).toEqual({
      applied: { removeLabels: ['RECEIPTS'] },
      undo: { addLabels: ['RECEIPTS'] },
    })
  })
})

describe('changeEmailThreads on Gmail', () => {
  it('archives and marks read in one thread call, and the index row follows', async () => {
    db.seed('email_thread_index', [{ id: 'r1', user_id: 'u-1', provider_thread_id: 'amazon', account_id: 'acct-g', folder: 'inbox', is_unread: true }])
    const [outcome] = await changeEmailThreads('u-1', 'ws-1', ['amazon'], { archive: true, read: true })
    expect(outcome).toMatchObject({ threadId: 'amazon', status: 'changed', applied: { archive: true, read: true }, undo: { archive: false, read: false } })
    expect(calls.filter((c) => c.method === 'POST')).toEqual([
      { method: 'POST', url: `${GMAIL}/threads/amazon/modify`, body: { removeLabelIds: ['INBOX', 'UNREAD'] } },
    ])
    expect(gmailThreads.amazon.every((m) => !m.labelIds.includes('INBOX') && !m.labelIds.includes('UNREAD'))).toBe(true)
    expect(db.rows('email_thread_index')[0]).toMatchObject({ folder: 'archive', is_unread: false })
  })

  it('its undo puts the thread back in the inbox, unread on the newest message', async () => {
    const [outcome] = await changeEmailThreads('u-1', 'ws-1', ['amazon'], { archive: true, read: true })
    const [undone] = await changeEmailThreads('u-1', 'ws-1', ['amazon'], outcome.undo!)
    expect(undone.status).toBe('changed')
    expect(gmailThreads.amazon.map((m) => m.labelIds.includes('INBOX'))).toEqual([true, true])
    // Unread goes back on the newest message only, as Gmail's own button does.
    expect(gmailThreads.amazon.map((m) => m.labelIds.includes('UNREAD'))).toEqual([false, true])
  })

  it('changes nothing on a thread already archived, and offers no undo', async () => {
    const [outcome] = await changeEmailThreads('u-1', 'ws-1', ['archived'], { archive: true })
    expect(outcome).toMatchObject({ status: 'unchanged' })
    expect(outcome.undo).toBeUndefined()
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('adds an existing label by name and makes a missing one', async () => {
    const [outcome] = await changeEmailThreads('u-1', 'ws-1', ['amazon'], { addLabels: ['receipts', 'Shopping'] })
    expect(outcome).toMatchObject({ status: 'changed', applied: { addLabels: ['receipts', 'Shopping'] }, createdLabels: ['Shopping'] })
    expect(gmailLabels.map((l) => l.name)).toContain('Shopping')
    expect(gmailThreads.amazon[0].labelIds).toEqual(expect.arrayContaining(['Label_1', 'Label_4']))
  })

  it('names a label to remove that the mailbox lacks, and removes the rest', async () => {
    const [outcome] = await changeEmailThreads('u-1', 'ws-1', ['archived'], { removeLabels: ['Receipts', 'Nope'] })
    expect(outcome).toMatchObject({ status: 'changed', applied: { removeLabels: ['Receipts'] }, unknownLabels: ['Nope'] })
    expect(gmailThreads.archived[0].labelIds).toEqual([])
  })

  it('stars the newest message only', async () => {
    await changeEmailThreads('u-1', 'ws-1', ['amazon'], { star: true })
    expect(gmailThreads.amazon.map((m) => m.labelIds.includes('STARRED'))).toEqual([false, true])
  })

  it('refuses a thread in Trash or Spam, and says it is there', async () => {
    const [outcome] = await changeEmailThreads('u-1', 'ws-1', ['trashed'], { archive: false })
    expect(outcome).toMatchObject({ status: 'failed', trashed: true, error: expect.stringMatching(/Trash or Spam/) })
  })

  it('skipStarred leaves a thread starred on any message, read live (the index holds only the newest’s)', async () => {
    gmailThreads.amazon[0].labelIds.push('STARRED')
    const [kept] = await changeEmailThreads('u-1', 'ws-1', ['amazon'], { archive: true }, { skipStarred: true })
    expect(kept).toMatchObject({ status: 'unchanged', kept: 'starred' })
    expect(gmailThreads.amazon.every((m) => m.labelIds.includes('INBOX'))).toBe(true)
    // Without it, the archive goes ahead.
    const [moved] = await changeEmailThreads('u-1', 'ws-1', ['amazon'], { archive: true })
    expect(moved.status).toBe('changed')
  })

  it('reports a thread no mailbox holds', async () => {
    const [outcome] = await changeEmailThreads('u-1', 'ws-1', ['nowhere'], { archive: true })
    expect(outcome.status).toBe('not_found')
  })

  it('no mailbox to read at all (a token that won’t refresh) is a failure, not a thread that is gone', async () => {
    mailbox = null
    const [outcome] = await changeEmailThreads('u-1', 'ws-1', ['amazon'], { archive: false })
    expect(outcome).toMatchObject({ status: 'failed', error: expect.stringMatching(/could be reached/) })
    expect(outcome.trashed).toBeUndefined()
  })

  it('a change that partly landed fails with its undo, which puts back only what landed', async () => {
    // The thread call (archive) goes through; the star on the newest message is refused.
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith('/messages/a2/modify') ? Promise.resolve(json({}, 500)) : fakeFetch(input, init)))
    const [outcome] = await changeEmailThreads('u-1', 'ws-1', ['amazon'], { archive: true, star: true })
    expect(outcome).toMatchObject({ status: 'failed', undo: { archive: false, star: false } })
    expect(groupUndo([outcome])).toEqual([{ threadIds: ['amazon'], change: { archive: false, star: false } }])
    vi.stubGlobal('fetch', vi.fn(fakeFetch))
    const [undone] = await changeEmailThreads('u-1', 'ws-1', ['amazon'], outcome.undo!)
    expect(undone).toMatchObject({ status: 'changed', applied: { archive: false } })
    expect(gmailThreads.amazon.every((m) => m.labelIds.includes('INBOX') && !m.labelIds.includes('STARRED'))).toBe(true)
  })

  it('a change refused before anything landed has no undo', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith('/modify') ? Promise.resolve(json({}, 403)) : fakeFetch(input, init)))
    const [outcome] = await changeEmailThreads('u-1', 'ws-1', ['amazon'], { archive: true })
    expect(outcome.status).toBe('failed')
    expect(outcome.undo).toBeUndefined()
  })

  it('says why a refused change failed, and still changes the other threads', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith('/threads/amazon/modify') ? Promise.resolve(json({}, 403)) : fakeFetch(input, init)))
    gmailThreads.second = [{ id: 's1', labelIds: ['INBOX'], internalDate: '1' }]
    const outcomes = await changeEmailThreads('u-1', 'ws-1', ['amazon', 'second'], { archive: true })
    expect(outcomes.map((o) => o.status)).toEqual(['failed', 'changed'])
    expect(outcomes[0].error).toMatch(/403/)
  })
})

describe('changeEmailThreads on Outlook', () => {
  beforeEach(() => {
    mailbox = MICROSOFT
  })

  it('archives the Inbox messages only, leaving sent and deleted ones', async () => {
    const [outcome] = await changeEmailThreads('u-1', 'ws-1', ['conv-1'], { archive: true, read: true })
    expect(outcome).toMatchObject({ status: 'changed', applied: { archive: true, read: true } })
    expect(graphMessages.map((m) => [m.id, m.parentFolderId, m.isRead])).toEqual([
      ['o1', 'folder-archive', true],
      ['o2', 'folder-sentitems', true],
      ['o3', 'folder-deleteditems', true],
    ])
    // Patches before moves: a moved message's id is gone.
    const writes = calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.url.slice(GRAPH.length)}`)
    expect(writes).toEqual(['PATCH /messages/o1', 'POST /messages/o1/move'])
  })

  it('undo moves the archived messages back and marks the newest received one unread', async () => {
    const [outcome] = await changeEmailThreads('u-1', 'ws-1', ['conv-1'], { archive: true, read: true })
    await changeEmailThreads('u-1', 'ws-1', ['conv-1'], outcome.undo!)
    expect(graphMessages.find((m) => m.id === 'o1')).toMatchObject({ parentFolderId: 'folder-inbox', isRead: false })
    // The person's own sent reply (o2) stays read.
    expect(graphMessages.find((m) => m.id === 'o2')!.isRead).toBe(true)
  })

  it('labels are categories on every message, kept unique', async () => {
    graphMessages[0].categories = ['Receipts']
    await changeEmailThreads('u-1', 'ws-1', ['conv-1'], { addLabels: ['receipts', 'Travel'] })
    expect(graphMessages[0].categories).toEqual(['Receipts', 'Travel'])
    // 'receipts' is already on the thread (o1), so only Travel is added; Deleted Items is left alone.
    expect(graphMessages[1].categories).toEqual(['Travel'])
    expect(graphMessages[2].categories).toBeUndefined()
  })

  it("moving a thread filed in another folder back to the inbox changes nothing", async () => {
    graphMessages = [{ id: 'f1', conversationId: 'conv-2', isRead: true, parentFolderId: 'folder-newsletters', receivedDateTime: '2026-10-27T08:00:00Z' }]
    const [outcome] = await changeEmailThreads('u-1', 'ws-1', ['conv-2'], { archive: false })
    expect(outcome.status).toBe('unchanged')
    expect(calls.some((c) => c.method !== 'GET')).toBe(false)
  })

  it("the index follows the newest message's new id after a move, so arrival doesn't take it for new mail", async () => {
    graphMessages = [
      { id: 'n1', conversationId: 'conv-3', isRead: true, parentFolderId: 'folder-archive', receivedDateTime: '2026-10-20T08:00:00Z' },
      { id: 'n2', conversationId: 'conv-3', isRead: false, parentFolderId: 'folder-inbox', receivedDateTime: '2026-10-27T08:00:00Z' },
    ]
    db.seed('email_thread_index', [
      { id: 'r1', user_id: 'u-1', provider_thread_id: 'conv-3', account_id: 'acct-m', provider_message_id: 'n2', folder: 'inbox' },
      { id: 'r2', user_id: 'u-1', provider_thread_id: 'conv-3', account_id: 'acct-other', provider_message_id: 'x', folder: 'inbox' },
    ])
    await changeEmailThreads('u-1', 'ws-1', ['conv-3'], { archive: true })
    expect(db.rows('email_thread_index')).toEqual([
      expect.objectContaining({ id: 'r1', provider_message_id: 'n2-moved', folder: 'archive' }),
      // Another mailbox's copy of the same id is left alone.
      expect.objectContaining({ id: 'r2', provider_message_id: 'x', folder: 'inbox' }),
    ])
  })

  it('a move refused partway still leaves the index on the newest message’s new id', async () => {
    graphMessages = [
      { id: 'n2', conversationId: 'conv-3', isRead: true, parentFolderId: 'folder-inbox', receivedDateTime: '2026-10-27T08:00:00Z' },
      { id: 'n1', conversationId: 'conv-3', isRead: true, parentFolderId: 'folder-inbox', receivedDateTime: '2026-10-20T08:00:00Z' },
    ]
    db.seed('email_thread_index', [{ id: 'r1', user_id: 'u-1', provider_thread_id: 'conv-3', account_id: 'acct-m', provider_message_id: 'n2', folder: 'inbox' }])
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith('/messages/n1/move') ? Promise.resolve(json({}, 503)) : fakeFetch(input, init)))
    const [outcome] = await changeEmailThreads('u-1', 'ws-1', ['conv-3'], { archive: true })
    expect(outcome).toMatchObject({ status: 'failed', undo: { archive: false } })
    // The folder is left for the next sync; the id is the moved message's.
    expect(db.rows('email_thread_index')[0]).toMatchObject({ provider_message_id: 'n2-moved', folder: 'inbox' })
  })

  it("reads the mailbox's folders once per call, and changes its threads one at a time", async () => {
    graphMessages.push({ id: 'p1', conversationId: 'conv-4', isRead: false, parentFolderId: 'folder-inbox', receivedDateTime: '2026-10-27T07:00:00Z' })
    let inFlight = 0
    let most = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      inFlight += 1
      most = Math.max(most, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 2))
      try {
        return await fakeFetch(input, init)
      } finally {
        inFlight -= 1
      }
    }))
    const outcomes = await changeEmailThreads('u-1', 'ws-1', ['conv-1', 'conv-4'], { read: true })
    expect(outcomes.map((o) => o.status)).toEqual(['changed', 'changed'])
    expect(calls.filter((c) => c.url.includes('/mailFolders/')).length).toBe(4)
    expect(most).toBe(1)
  })

  it('a throttled request is retried once after Retry-After', async () => {
    let throttled = false
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (!throttled && String(input).includes('/messages?')) {
        throttled = true
        return Promise.resolve(new Response('{}', { status: 429, headers: { 'Retry-After': '0' } }))
      }
      return fakeFetch(input, init)
    }))
    const [outcome] = await changeEmailThreads('u-1', 'ws-1', ['conv-1'], { read: true })
    expect(outcome.status).toBe('changed')
  })

  it('skipStarred leaves a conversation with a flagged message (the index reads importance, not the flag)', async () => {
    graphMessages[0].flag = { flagStatus: 'flagged' }
    const [outcome] = await changeEmailThreads('u-1', 'ws-1', ['conv-1'], { archive: true }, { skipStarred: true })
    expect(outcome).toMatchObject({ status: 'unchanged', kept: 'starred' })
    expect(graphMessages[0].parentFolderId).toBe('folder-inbox')
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('star flags the newest message; unstar clears every flag', async () => {
    await changeEmailThreads('u-1', 'ws-1', ['conv-1'], { star: true })
    expect(graphMessages.find((m) => m.id === 'o2')!.flag).toEqual({ flagStatus: 'flagged' })
    await changeEmailThreads('u-1', 'ws-1', ['conv-1'], { star: false })
    expect(graphMessages.find((m) => m.id === 'o2')!.flag).toEqual({ flagStatus: 'notFlagged' })
  })
})

describe('mute', () => {
  it('records the mute, archives, and undo takes both back', async () => {
    const [outcome] = await changeEmailThreads('u-1', 'ws-1', ['amazon'], { mute: true })
    expect(outcome).toMatchObject({ status: 'changed', applied: { archive: true, mute: true }, undo: { archive: false, mute: false } })
    expect(db.rows('email_thread_mute')).toEqual([
      expect.objectContaining({ user_id: 'u-1', account_id: 'acct-g', provider: 'google', provider_thread_id: 'amazon' }),
    ])
    expect(gmailThreads.amazon.some((m) => m.labelIds.includes('INBOX'))).toBe(false)

    await changeEmailThreads('u-1', 'ws-1', ['amazon'], outcome.undo!)
    expect(db.rows('email_thread_mute')).toEqual([])
    expect(gmailThreads.amazon.some((m) => m.labelIds.includes('INBOX'))).toBe(true)
  })

  it('takes the mute row back when the mailbox refuses the archive', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith('/modify') ? Promise.resolve(json({}, 500)) : fakeFetch(input, init)))
    const [outcome] = await changeEmailThreads('u-1', 'ws-1', ['amazon'], { mute: true })
    expect(outcome.status).toBe('failed')
    expect(db.rows('email_thread_mute')).toEqual([])
  })

  it('an arriving message on a muted thread is archived again; others are left alone', async () => {
    db.seed('email_thread_mute', [{ user_id: 'u-1', account_id: 'acct-g', provider: 'google', provider_thread_id: 'amazon' }])
    db.seed('email_thread_index', [{ id: 'r1', user_id: 'u-1', provider_thread_id: 'amazon', account_id: 'acct-g', folder: 'inbox' }])
    const muted = await rearchiveMutedArrivals(db as never, {
      userId: 'u-1',
      provider: 'google',
      accountId: 'acct-g',
      accessToken: 'g-tok',
      threadIds: ['amazon', 'archived'],
    })
    expect([...muted]).toEqual(['amazon'])
    expect(gmailThreads.amazon.some((m) => m.labelIds.includes('INBOX'))).toBe(false)
    expect(db.rows('email_thread_index')[0]).toMatchObject({ folder: 'archive' })
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual([`${GMAIL}/threads/amazon/modify`])
  })

  it("another mailbox's mute is not this one's", async () => {
    db.seed('email_thread_mute', [{ user_id: 'u-1', account_id: 'acct-other', provider: 'google', provider_thread_id: 'amazon' }])
    const muted = await rearchiveMutedArrivals(db as never, { userId: 'u-1', provider: 'google', accountId: 'acct-g', accessToken: 'g-tok', threadIds: ['amazon'] })
    expect(muted.size).toBe(0)
  })

  it('before migration 441: no thread is muted, and a mute says so', async () => {
    const broken = {
      from: () => {
        const chain: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'in', 'is', 'insert', 'delete']) chain[m] = () => chain
        chain.then = (resolve: (v: unknown) => void) =>
          resolve({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.email_thread_mute' in the schema cache" } })
        return chain
      },
    }
    expect((await rearchiveMutedArrivals(broken as never, { userId: 'u-1', provider: 'google', accountId: 'acct-g', accessToken: 'g-tok', threadIds: ['amazon'] })).size).toBe(0)
    db = broken as never
    const [outcome] = await changeEmailThreads('u-1', 'ws-1', ['amazon'], { mute: true })
    expect(outcome).toMatchObject({ status: 'failed', error: expect.stringMatching(/migration 441/) })
  })
})

describe('groupUndo', () => {
  it('groups the threads whose undo is the same change, and leaves out the unchanged and what never landed', () => {
    expect(
      groupUndo([
        { threadId: 'a', status: 'changed', undo: { archive: false, read: false } },
        { threadId: 'b', status: 'changed', undo: { read: false, archive: false } },
        { threadId: 'c', status: 'changed', undo: { archive: false } },
        { threadId: 'd', status: 'unchanged' },
        { threadId: 'e', status: 'failed', error: 'x' },
        { threadId: 'f', status: 'failed', error: 'x', undo: { archive: false } },
      ]),
    ).toEqual([
      { threadIds: ['a', 'b'], change: { archive: false, read: false } },
      { threadIds: ['c', 'f'], change: { archive: false } },
    ])
  })
})
