/**
 * The three event emitters and their hook points. Each emits one event per
 * item, its id keyed on the item (a re-delivered push, a retried post, a
 * re-sent create fire their loops once); a document's event is delivered five
 * minutes later. New mail is an arrival only when it is someone else's,
 * recent, and not a draft, spam, trash or sent. The hooks: the first mail
 * import never emits; an agent's chat reply and an agent's document never
 * emit (only the person's own post route and documents route do).
 * Made-up people and companies throughout.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'

const sent = vi.hoisted(() => ({ events: [] as unknown[], fail: false }))
vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    send: async (event: unknown) => {
      if (sent.fail) throw new Error('down')
      sent.events.push(event)
      return { ids: [] }
    },
  },
}))

const { emitChatMessage } = await import('../emit-chat-message')
const { DOCUMENT_CREATED_DELAY_MS, emitDocumentCreated } = await import('../emit-document-created')
const { ARRIVAL_WINDOW_MS, emailArrivals, emitEmailReceived, outlookJunkMessageIds } = await import('../emit-email-received')

beforeEach(() => {
  sent.events.length = 0
  sent.fail = false
})

const WS = 'ws-fernhill'
const NOW = Date.parse('2026-11-16T15:00:00.000Z')
const recent = new Date(NOW - 10 * 60_000).toISOString()

describe('emitChatMessage', () => {
  it('one event, keyed on the message, ids only', async () => {
    expect(await emitChatMessage({ workspaceId: WS, messageId: 'msg-1', channelId: 'ch-1', firedAt: '2026-11-16T15:00:00Z' })).toBe(true)
    expect(sent.events).toEqual([{ name: 'flow/chat.message', id: 'chat-message:msg-1', data: { workspace_id: WS, message_id: 'msg-1', channel_id: 'ch-1', fired_at: '2026-11-16T15:00:00Z' } }])
  })

  it('never throws', async () => {
    sent.fail = true
    await expect(emitChatMessage({ workspaceId: WS, messageId: 'msg-1', channelId: 'ch-1' })).resolves.toBe(false)
  })
})

describe('emitDocumentCreated', () => {
  it('one event keyed on the document, delivered five minutes later', async () => {
    expect(await emitDocumentCreated({ workspaceId: WS, documentId: 'doc-1', now: NOW })).toBe(true)
    expect(sent.events).toEqual([
      { name: 'flow/document.created', id: 'document-created:doc-1', ts: NOW + DOCUMENT_CREATED_DELAY_MS, data: { workspace_id: WS, document_id: 'doc-1', created_at: new Date(NOW).toISOString() } },
    ])
    expect(DOCUMENT_CREATED_DELAY_MS).toBe(5 * 60 * 1000)
  })

  it('never throws', async () => {
    sent.fail = true
    await expect(emitDocumentCreated({ workspaceId: WS, documentId: 'doc-1' })).resolves.toBe(false)
  })
})

describe('email arrivals', () => {
  const ROW = (thread: string, over: Record<string, unknown> = {}) => ({
    user_id: 'u-ana',
    workspace_id: WS,
    provider: 'google',
    account_id: 'acct-1',
    provider_thread_id: thread,
    provider_message_id: `${thread}-m2`,
    from_email: 'ben@acme.example',
    is_draft: false,
    folder: 'inbox',
    last_message_at: recent,
    ...over,
  })
  const LOOP = { id: 'f-1', workspace_id: WS, enabled: true, trigger_type: 'email_received', created_by: 'u-ana' }

  function db(rows: Array<Record<string, unknown>>, flows = [LOOP]): SupabaseClient {
    const client = memoryDb({ email_thread_index: rows, flow: flows, connected_account: [{ user_id: 'u-ana', capability: 'email', account_email: 'ana@fernhill.example' }] }) as SupabaseClient
    ;(client as unknown as { auth: unknown }).auth = { admin: { getUserById: async () => ({ data: { user: { email: 'ana.signin@fernhill.example' } } }) } }
    return client
  }
  const arrivals = (client: SupabaseClient, threadIds: string[], over: Record<string, unknown> = {}) =>
    emailArrivals(client, { userId: 'u-ana', workspaceId: WS, provider: 'google', accountId: 'acct-1', threadIds, mailboxEmail: 'ana@fernhill.example', now: NOW, ...over })

  it("someone else's recent mail is an arrival", async () => {
    expect(await arrivals(db([ROW('t1')]), ['t1'])).toEqual([{ threadId: 't1', messageId: 't1-m2', fromEmail: 'ben@acme.example' }])
  })

  it("never the person's own mail (any of their addresses: what the app sent from their mailbox too), a draft, spam, trash or sent", async () => {
    const rows = [
      ROW('own', { from_email: 'Ana@Fernhill.example' }),
      ROW('own-signin', { from_email: 'ana.signin@fernhill.example' }),
      ROW('draft', { is_draft: true }),
      ROW('spam', { folder: 'spam' }),
      ROW('trash', { folder: 'trash' }),
      ROW('sent', { folder: 'sent' }),
      ROW('archived', { folder: 'archive' }),
    ]
    const out = await arrivals(db(rows), rows.map((r) => r.provider_thread_id as string))
    expect(out.map((a) => a.threadId)).toEqual(['archived'])
  })

  it('never old mail (a thread from before the import, touched for the first time)', async () => {
    const old = new Date(NOW - ARRIVAL_WINDOW_MS - 60_000).toISOString()
    expect(await arrivals(db([ROW('old', { last_message_at: old })]), ['old'])).toEqual([])
  })

  it('reads nothing when the person has no email_received loop here', async () => {
    expect(await arrivals(db([ROW('t1')], []), ['t1'])).toEqual([])
    expect(await arrivals(db([ROW('t1')], [{ ...LOOP, created_by: 'u-ben' }]), ['t1'])).toEqual([])
  })

  it('Outlook: a message in Junk is no arrival, asked of Graph (and none when Graph will not say)', async () => {
    const rows = [ROW('c1', { provider: 'microsoft' }), ROW('c2', { provider: 'microsoft' })]
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('mailFolders/junkemail')) return new Response(JSON.stringify({ id: 'junk-folder' }))
      if (url.includes('c1-m2')) return new Response(JSON.stringify({ parentFolderId: 'inbox-folder' }))
      return new Response(JSON.stringify({ parentFolderId: 'junk-folder' }))
    }) as unknown as typeof fetch
    const out = await emailArrivals(
      db(rows),
      { userId: 'u-ana', workspaceId: WS, provider: 'microsoft', accountId: 'acct-1', threadIds: ['c1', 'c2'], mailboxEmail: 'ana@fernhill.example', now: NOW, getAccessToken: async () => 'tok' },
      { fetchImpl },
    )
    expect(out.map((a) => a.threadId)).toEqual(['c1'])
    // No token: none (fails closed rather than fire on junk).
    const none = await emailArrivals(db(rows), { userId: 'u-ana', workspaceId: WS, provider: 'microsoft', accountId: 'acct-1', threadIds: ['c1'], mailboxEmail: null, now: NOW, getAccessToken: async () => null })
    expect(none).toEqual([])
    const down = await outlookJunkMessageIds('tok', ['x'], (async () => new Response('', { status: 500 })) as unknown as typeof fetch)
    expect(down.has('x')).toBe(true)
  })

  it('Outlook: keyed on the internetMessageId, so a message that moved folders (a new Graph id) fires once', async () => {
    const graph = (graphId: string) =>
      vi.fn(async (url: string) => {
        if (url.includes('mailFolders/junkemail')) return new Response(JSON.stringify({ id: 'junk-folder' }))
        expect(url).toContain('internetMessageId')
        return new Response(JSON.stringify({ parentFolderId: url.includes(graphId) ? 'archive-folder' : 'inbox-folder', internetMessageId: '<ref-881@acme.example>' }))
      }) as unknown as typeof fetch
    const input = { userId: 'u-ana', workspaceId: WS, provider: 'microsoft' as const, accountId: 'acct-1', threadIds: ['c1'], mailboxEmail: 'ana@fernhill.example', now: NOW, getAccessToken: async () => 'tok' }
    // The same mail, first in the inbox, then (after an inbox rule moved it) under a new Graph id.
    const before = await emailArrivals(db([ROW('c1', { provider: 'microsoft' })]), input, { fetchImpl: graph('none') })
    const after = await emailArrivals(db([ROW('c1', { provider: 'microsoft', provider_message_id: 'c1-moved' })]), input, { fetchImpl: graph('c1-moved') })
    expect(before[0].messageId).not.toBe(after[0].messageId)
    for (const arrivals of [before, after]) {
      await emitEmailReceived({ workspaceId: WS, userId: 'u-ana', provider: 'microsoft', accountId: 'acct-1', arrivals, firedAt: '2026-11-16T15:00:00Z' })
    }
    const ids = (sent.events as Array<Array<{ id: string }>>).map((batch) => batch[0].id)
    expect(ids).toEqual(['email-received:u-ana:imid:<ref-881@acme.example>', 'email-received:u-ana:imid:<ref-881@acme.example>'])
  })

  it('Outlook: no internetMessageId from Graph keys on the Graph id, as before', async () => {
    const fetchImpl = (async (url: string) =>
      url.includes('mailFolders/junkemail') ? new Response(JSON.stringify({ id: 'junk-folder' })) : new Response(JSON.stringify({ parentFolderId: 'inbox-folder' }))) as unknown as typeof fetch
    const out = await emailArrivals(
      db([ROW('c1', { provider: 'microsoft' })]),
      { userId: 'u-ana', workspaceId: WS, provider: 'microsoft', accountId: 'acct-1', threadIds: ['c1'], mailboxEmail: null, now: NOW, getAccessToken: async () => 'tok' },
      { fetchImpl },
    )
    expect(out).toHaveLength(1)
    expect(out[0].stableId).toBeUndefined()
  })

  it('one event per arrived message, keyed on the person and the message id', async () => {
    const n = await emitEmailReceived({
      workspaceId: WS,
      userId: 'u-ana',
      provider: 'google',
      accountId: 'acct-1',
      arrivals: [{ threadId: 't1', messageId: 'm-77', fromEmail: 'ben@acme.example' }],
      firedAt: '2026-11-16T15:00:00Z',
    })
    expect(n).toBe(1)
    expect(sent.events).toEqual([
      [
        {
          name: 'flow/email.received',
          id: 'email-received:u-ana:m-77',
          data: { workspace_id: WS, user_id: 'u-ana', provider: 'google', account_id: 'acct-1', thread_id: 't1', message_id: 'm-77', from_email: 'ben@acme.example', fired_at: '2026-11-16T15:00:00Z' },
        },
      ],
    ])
    expect(await emitEmailReceived({ workspaceId: WS, userId: 'u-ana', provider: 'google', accountId: null, arrivals: [] })).toBe(0)
  })
})

describe('the hook points', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
  /** Every file under src/ that calls `name(`, apart from its own definition and tests. */
  const callers = (name: string) =>
    execSync(`grep -rl "${name}(" src --include=*.ts --include=*.tsx`, { encoding: 'utf8' })
      .split('\n')
      .filter((f) => f && !f.includes('__tests__'))
      .sort()

  // Each of these greps all of src/: under a second alone, past 5 s on a busy
  // machine running the full suite. Hence their longer limit.
  it('mail: only the incremental sync emits, after triage; never the first import or a full re-index', () => {
    expect(callers('emitEmailReceived')).toEqual(['src/lib/flows/emit-email-received.ts', 'src/lib/inngest/email-functions.ts'])
    const src = read('src/lib/inngest/email-functions.ts')
    const importFn = src.slice(src.indexOf('export const emailInitialImport'), src.indexOf('export const emailIncrementalSync'))
    expect(importFn).not.toMatch(/emitEmailReceived|emailArrivals/)
    const sync = src.slice(src.indexOf('export const emailIncrementalSync'))
    // Emitted from triage's arrivals only: the full re-index branch (index-recent-threads) holds none.
    const rebuild = sync.slice(sync.indexOf("if (result.fullRebuild)"), sync.indexOf('} else if (result.affectedThreadIds.length)'))
    expect(rebuild).not.toMatch(/emit|arrived/)
    expect(sync.indexOf("'emit-email-received'")).toBeGreaterThan(sync.indexOf("'index-and-triage'"))
    expect(sync).toMatch(/threadIds: triaged\.arrived/)
  }, 60_000)

  it("chat: only the person's post route emits; the agent's reply path never does", () => {
    expect(callers('emitChatMessage')).toEqual(['src/app/api/account/team-chat/channels/[id]/messages/route.ts', 'src/lib/flows/emit-chat-message.ts'])
    expect(read('src/lib/team-chat/agent-turn.ts')).not.toMatch(/emitChatMessage|flow\/chat\.message/)
  }, 60_000)

  it("documents: only the documents route's plain create emits; never an agent's create_document or a canon template", () => {
    expect(callers('emitDocumentCreated')).toEqual(['src/app/api/account/documents/route.ts', 'src/lib/flows/emit-document-created.ts'])
    expect(read('src/lib/ai/tools/documents.ts')).not.toMatch(/emitDocumentCreated|flow\/document\.created/)
    const route = read('src/app/api/account/documents/route.ts')
    const post = route.slice(route.indexOf('export async function POST'))
    // The canon branch returns before the emit.
    expect(post.indexOf('createCanonDocument(')).toBeLessThan(post.indexOf('emitDocumentCreated('))
    const canonBranch = post.slice(post.indexOf('if (body.canon_template !== undefined)'), post.indexOf("const title = (body.title || 'Untitled Document')"))
    expect(canonBranch).toMatch(/return NextResponse\.json/)
    expect(canonBranch).not.toMatch(/emitDocumentCreated/)
  }, 60_000)
})
