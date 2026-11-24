// @vitest-environment jsdom
/**
 * Done sticks (../inbox-store.ts inboxDone; Liam, 11-24: "The incoming panel
 * has an issue. I click the check box and the emails or notification goes
 * away then after a few second it reappears"). A read that still lists the
 * item (one already on its way when Done was pressed, or one that lands
 * before the write) never brings it back; something newer in it does; a Done
 * the server didn't carry out brings the row back with an error, never
 * silently. Then (Liam, 11-24, after the first fix): "I just archived a bunch
 * of calendar invite then I open another mail and it all came back": a read
 * that left them out, then one that listed them again (the index rewritten
 * behind the archive), or their time moving, brought them back. Fixtures are
 * made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toasts = vi.hoisted(() => ({ error: [] as string[], success: [] as Array<{ msg: string; undo?: () => void }> }))
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    error: (msg: string) => toasts.error.push(msg),
    success: (msg: string, opts?: { action?: { onClick: () => void } }) => toasts.success.push({ msg, undo: opts?.action?.onClick }),
  }),
}))

const { __resetInboxStoreForTests, DONE_STORAGE_KEY, inboxDone, inboxOpen, inboxRows, inboxState, loadInbox } = await import('../inbox-store')

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
const mail = (key: string, over: Record<string, unknown> = {}) =>
  note(key, { source: 'mail', category: 'mail', type: 'mail_to_respond', notificationIds: [], messages: 1, open: { kind: 'mail', threadIndexId: key.slice(5), providerThreadId: `pt-${key.slice(5)}`, accountId: null }, ...over })
const invite = (n: number, over: Record<string, unknown> = {}) => mail(`mail:invite-${n}`, { title: 'Pat Example', body: `Invitation: Planning ${n}`, ...over })

/** What the list read answers, and what each write answers. */
let listed: unknown[] = []
let doneAnswer: unknown = { updated: 1 }
let triageAnswer: unknown = null
const posts: Array<[string, unknown]> = []

beforeEach(() => {
  __resetInboxStoreForTests()
  toasts.error.length = 0
  toasts.success.length = 0
  posts.length = 0
  doneAnswer = { updated: 1 }
  triageAnswer = null
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push([url, JSON.parse(String(init.body))])
        const body = JSON.parse(String(init.body)) as { thread_ids?: string[] }
        const answer = url.includes('triage') ? (triageAnswer ?? { changed: 1, threads: (body.thread_ids ?? []).map((t) => ({ thread_id: t, status: 'changed' })) }) : doneAnswer
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
    listed = [note('n:a', { at: '2026-11-24T11:00:00.000Z', notificationIds: ['0b5a1c3e-0000-4000-8000-000000000001', '0b5a1c3e-0000-4000-8000-000000000009'] }), note('n:b')]
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

  it('something new in the item (a new message in the conversation) brings it back', async () => {
    listed = [note('n:a')]
    await loadInbox()
    await inboxDone(inboxState().data!.items[0])
    listed = [note('n:a', { at: '2026-11-24T10:05:00.000Z', notificationIds: ['0b5a1c3e-0000-4000-8000-000000000001', '0b5a1c3e-0000-4000-8000-000000000002'] })]
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
    triageAnswer = { changed: 0, threads: [{ thread_id: 'pt-t1', status: 'unchanged' }] }
    await inboxDone(inboxState().data!.items[0])
    expect(posts[0]).toEqual(['/api/account/email/threads/triage', { thread_ids: ['pt-t1'], change: { archive: true } }])
    await loadInbox()
    expect(keys()).toEqual([])
    expect(toasts.success.map((t) => t.msg)).toEqual(['Archived'])

    __resetInboxStoreForTests()
    listed = [mail('mail:t1')]
    await loadInbox()
    triageAnswer = { changed: 0, threads: [{ thread_id: 'pt-t1', status: 'failed', error: 'No mailbox for this thread could be reached.' }] }
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

  it('several invites done in a row, then another mail opened and the list read again: they stay gone', async () => {
    listed = [invite(1), invite(2), invite(3), mail('mail:other')]
    await loadInbox()
    const [a, b, c] = inboxState().data!.items
    // In a row, without waiting for each answer.
    await Promise.all([inboxDone(a), inboxDone(b), inboxDone(c)])
    expect(posts.map(([, body]) => (body as { thread_ids: string[] }).thread_ids[0])).toEqual(['pt-invite-1', 'pt-invite-2', 'pt-invite-3'])
    // The archive landed: the next read leaves them out.
    listed = [mail('mail:other')]
    await loadInbox()
    expect(keys()).toEqual(['mail:other'])
    // Another mail opened; the index rewritten behind the archive lists them again.
    await inboxOpen(inboxState().data!.items[0])
    listed = [invite(1), invite(2), invite(3), mail('mail:other')]
    await loadInbox()
    await loadInbox()
    expect(keys()).toEqual(['mail:other'])
    expect(toasts.error).toEqual([])
  })

  it('the time moving after Done, with nothing new in it, doesn’t bring it back', async () => {
    listed = [invite(1), note('n:a')]
    await loadInbox()
    for (const item of [...inboxState().data!.items]) await inboxDone(item)
    // A re-index moves the mail's time, a regroup the notification's: same messages, same rows.
    listed = [invite(1, { at: '2026-11-24T10:30:00.000Z' }), note('n:a', { at: '2026-11-24T10:30:00.000Z' })]
    await loadInbox()
    expect(keys()).toEqual([])
    // A new message in the thread is news.
    listed = [invite(1, { at: '2026-11-24T10:40:00.000Z', messages: 2 })]
    await loadInbox()
    expect(keys()).toEqual(['mail:invite-1'])
  })

  it('a read that leaves the item out, then one that lists it: it stays gone', async () => {
    listed = [note('n:a'), invite(1)]
    await loadInbox()
    for (const item of [...inboxState().data!.items]) await inboxDone(item)
    // Mail that couldn't be read this time, the notification past a page: left out.
    listed = []
    await loadInbox()
    listed = [note('n:a'), invite(1)]
    await loadInbox()
    expect(keys()).toEqual([])
  })

  it('kept on this device: a reload doesn’t bring a done item back', async () => {
    listed = [invite(1), invite(2)]
    await loadInbox()
    await inboxDone(inboxState().data!.items[0])
    expect(JSON.parse(window.localStorage.getItem(DONE_STORAGE_KEY)!)).toHaveProperty(['mail:invite-1'])
    __resetInboxStoreForTests({ keepDevice: true })
    await loadInbox()
    expect(keys()).toEqual(['mail:invite-2'])
    // Undo takes it back out of what the device keeps.
    listed = [invite(2)]
    await loadInbox()
    await inboxDone(inboxState().data!.items[0])
    toasts.success.at(-1)!.undo!()
    await new Promise((r) => setTimeout(r, 0))
    expect(JSON.parse(window.localStorage.getItem(DONE_STORAGE_KEY)!)).not.toHaveProperty(['mail:invite-2'])
  })

  it('a held item done stays gone from Held too', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === 'POST' ? new Response(JSON.stringify({ updated: 1 }), { status: 200 }) : new Response(JSON.stringify({ items: [], held: [note('n:h', { heldUntil: '2026-11-25T08:00:00.000Z' })], mail: [] }), { status: 200 }),
      ),
    )
    await loadInbox()
    await inboxDone(inboxState().data!.held[0])
    await loadInbox()
    expect(inboxState().data!.held).toEqual([])
  })
})
