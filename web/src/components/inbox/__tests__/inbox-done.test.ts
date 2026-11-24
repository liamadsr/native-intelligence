// @vitest-environment jsdom
/**
 * Done sticks (../inbox-store.ts inboxDone; Liam, 11-24: "The incoming panel
 * has an issue. I click the check box and the emails or notification goes
 * away then after a few second it reappears"). A read that still lists the
 * item (one already on its way when Done was pressed, or one that lands
 * before the write) never brings it back; something newer in it does; a Done
 * the server didn't carry out brings the row back with an error, never
 * silently. Fixtures are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toasts = vi.hoisted(() => ({ error: [] as string[], success: [] as Array<{ msg: string; undo?: () => void }> }))
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    error: (msg: string) => toasts.error.push(msg),
    success: (msg: string, opts?: { action?: { onClick: () => void } }) => toasts.success.push({ msg, undo: opts?.action?.onClick }),
  }),
}))

const { __resetInboxStoreForTests, inboxDone, inboxRows, inboxState, loadInbox } = await import('../inbox-store')

const at = '2026-11-24T10:00:00.000Z'
const note = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  source: 'notification',
  category: 'other',
  at,
  title: key,
  body: null,
  unread: true,
  count: 1,
  notificationIds: ['0b5a1c3e-0000-4000-8000-000000000001'],
  actor: null,
  open: { kind: 'none' },
  type: 'reminder',
  ...over,
})
const mail = (key: string) => note(key, { source: 'mail', category: 'mail', type: 'mail_to_respond', notificationIds: [], open: { kind: 'mail', threadIndexId: 't1', providerThreadId: 'pt1', accountId: null } })

/** What the list read answers, and what each write answers. */
let listed: unknown[] = []
let doneAnswer: unknown = { updated: 1 }
let triageAnswer: unknown = { changed: 1, threads: [{ thread_id: 'pt1', status: 'changed' }] }
const posts: Array<[string, unknown]> = []

beforeEach(() => {
  __resetInboxStoreForTests()
  toasts.error.length = 0
  toasts.success.length = 0
  posts.length = 0
  doneAnswer = { updated: 1 }
  triageAnswer = { changed: 1, threads: [{ thread_id: 'pt1', status: 'changed' }] }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push([url, JSON.parse(String(init.body))])
        const answer = url.includes('triage') ? triageAnswer : doneAnswer
        return new Response(JSON.stringify(answer), { status: 200 })
      }
      return new Response(JSON.stringify({ items: listed, held: [], mail: [] }), { status: 200 })
    }),
  )
})
afterEach(() => vi.unstubAllGlobals())

const keys = () => inboxRows(inboxState()).map((i) => i.key)

describe('Done in the inbox', () => {
  it('stays gone when a read still lists the item (the bug: it came back a few seconds later)', async () => {
    listed = [note('n:a'), note('n:b')]
    await loadInbox()
    expect(keys()).toEqual(['n:a', 'n:b'])
    await inboxDone(inboxState().data!.items[0])
    expect(posts).toEqual([['/api/account/inbox/notifications', { action: 'done', ids: ['0b5a1c3e-0000-4000-8000-000000000001'] }]])
    expect(toasts.success.map((t) => t.msg)).toEqual(['Done'])
    // The next read still lists it (it crossed the write, or was on its way): it stays hidden.
    await loadInbox()
    expect(keys()).toEqual(['n:b'])
    // Once a read no longer lists it, it is forgotten; something new in it later shows again.
    listed = [note('n:b')]
    await loadInbox()
    listed = [note('n:a', { at: '2026-11-24T11:00:00.000Z' }), note('n:b')]
    await loadInbox()
    expect(keys()).toEqual(['n:a', 'n:b'])
  })

  it('a read already on its way when Done was pressed doesn’t bring it back', async () => {
    listed = [note('n:a')]
    await loadInbox()
    const inFlight = loadInbox()
    await inboxDone(inboxState().data!.items[0])
    await inFlight
    expect(keys()).toEqual([])
  })

  it('something newer in the item (a new message in the conversation) brings it back', async () => {
    listed = [note('n:a')]
    await loadInbox()
    await inboxDone(inboxState().data!.items[0])
    listed = [note('n:a', { at: '2026-11-24T10:05:00.000Z' })]
    await loadInbox()
    expect(keys()).toEqual(['n:a'])
  })

  it('a Done the server didn’t write (no notification changed) brings the row back with an error', async () => {
    listed = [note('n:a')]
    await loadInbox()
    doneAnswer = { updated: 0 }
    await inboxDone(inboxState().data!.items[0])
    await Promise.resolve()
    await loadInbox()
    expect(keys()).toEqual(['n:a'])
    expect(toasts.error).toEqual(['That could not be marked done. It’s back in the list.'])
    expect(toasts.success).toEqual([])
  })

  it('mail: archived, or already archived in the mailbox, stays gone; a mailbox that refused brings it back with an error', async () => {
    listed = [mail('mail:t1')]
    await loadInbox()
    triageAnswer = { changed: 0, threads: [{ thread_id: 'pt1', status: 'unchanged' }] }
    await inboxDone(inboxState().data!.items[0])
    expect(posts[0]).toEqual(['/api/account/email/threads/triage', { thread_ids: ['pt1'], change: { archive: true } }])
    await loadInbox()
    expect(keys()).toEqual([])
    expect(toasts.success.map((t) => t.msg)).toEqual(['Archived'])

    __resetInboxStoreForTests()
    listed = [mail('mail:t1')]
    await loadInbox()
    triageAnswer = { changed: 0, threads: [{ thread_id: 'pt1', status: 'failed', error: 'No mailbox for this thread could be reached.' }] }
    await inboxDone(inboxState().data!.items[0])
    await loadInbox()
    expect(keys()).toEqual(['mail:t1'])
    expect(toasts.error).toEqual(['That email could not be archived. It’s back in the list.'])
  })

  it('Undo brings it back', async () => {
    listed = [note('n:a')]
    await loadInbox()
    await inboxDone(inboxState().data!.items[0])
    toasts.success[0].undo!()
    await new Promise((r) => setTimeout(r, 0))
    await loadInbox()
    expect(posts.at(-1)).toEqual(['/api/account/inbox/notifications', { action: 'undone', ids: ['0b5a1c3e-0000-4000-8000-000000000001'] }])
    expect(keys()).toEqual(['n:a'])
  })
})
