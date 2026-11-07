/**
 * The inbox-triage tools (GEN-1166), as the model calls them:
 *   update_email_thread  refuses an empty or contradictory change and the
 *                        flags' own names as labels; waits for the person's
 *                        yes over ten threads (awaiting_go_ahead, which arms
 *                        the same-turn guard); returns what changed and the
 *                        undo, as update_email_thread arguments.
 *   unsubscribe_thread   runs only as the replay of the person's accepted
 *                        card; refuses a thread flagged suspicious; hands back
 *                        a web-page-only link inside the untrusted marker.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>
const h = vi.hoisted(() => ({
  trust: [] as Row[],
  changeEmailThreads: vi.fn(),
  unsubscribeFromThread: vi.fn(),
}))

function fakeDb() {
  return {
    from() {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        in: () => b,
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: h.trust, error: null }).then(resolve),
      }
      return b
    },
  }
}

vi.mock('@/lib/admin', () => ({ getServiceClient: () => fakeDb() }))
vi.mock('@/lib/integrations/email', () => ({ listEmails: vi.fn(), createEmailDraft: vi.fn() }))
vi.mock('@/lib/oauth/token-manager', () => ({ getValidToken: vi.fn() }))
vi.mock('@/lib/email/account-scope', () => ({ readableWorkspaceEmailAccounts: async () => [] }))
vi.mock('@/lib/email/email-read-service', () => ({ readEmailThread: vi.fn(), readEmailMessage: vi.fn() }))
vi.mock('@/lib/email/thread-triage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/email/thread-triage')>()),
  changeEmailThreads: h.changeEmailThreads,
}))
vi.mock('@/lib/email/unsubscribe', () => ({ unsubscribeFromThread: h.unsubscribeFromThread }))

const { createEmailTools, BULK_THREAD_CONFIRM_OVER } = await import('../email')
import { UNTRUSTED_EMAIL_PREFIX } from '@/lib/email/untrusted'

type Exec = { execute: (a: unknown, o: unknown) => Promise<Record<string, unknown>> }
type Triage = NonNullable<Parameters<typeof createEmailTools>[5]>
const tools = (triage: Triage = {}) => createEmailTools('user-1', 'ws-1', false, 'session', false, triage) as unknown as Record<string, Exec>
const update = (args: Record<string, unknown>, triage: Triage = {}) => tools(triage).update_email_thread.execute(args, {})
const approved = (tool: string, extra: Partial<NonNullable<Triage['approvedCall']>> = {}) => ({ approvedCall: { approvalId: 'appr-1', tool, ...extra } })
const unsubscribe = (approvedTool?: string, extra: Partial<NonNullable<Triage['approvedCall']>> = {}) =>
  tools(approvedTool ? approved(approvedTool, extra) : {}).unsubscribe_thread.execute({ thread_id: 't1' }, {})

beforeEach(() => {
  h.trust = []
  h.changeEmailThreads.mockReset()
  h.unsubscribeFromThread.mockReset()
})

describe('update_email_thread', () => {
  it('archives and returns what changed, with its undo as update_email_thread arguments', async () => {
    h.changeEmailThreads.mockResolvedValue([
      { threadId: 'a', status: 'changed', account: 'me@gmail.com', applied: { archive: true, read: true }, undo: { archive: false, read: false } },
      { threadId: 'b', status: 'changed', account: 'me@gmail.com', applied: { archive: true }, undo: { archive: false } },
      { threadId: 'c', status: 'unchanged', account: 'me@gmail.com' },
    ])
    const out = await update({ thread_ids: ['a', 'b', 'c', 'a'], archive: true, read: true })
    expect(h.changeEmailThreads).toHaveBeenCalledWith('user-1', 'ws-1', ['a', 'b', 'c'], { archive: true, read: true })
    expect(out).toMatchObject({
      success: true,
      changed: 2,
      threads: [
        { thread_id: 'a', status: 'changed', account: 'me@gmail.com', applied: { archive: true, read: true } },
        { thread_id: 'b', status: 'changed', applied: { archive: true } },
        { thread_id: 'c', status: 'unchanged' },
      ],
      undo: [
        { thread_ids: ['a'], archive: false, read: false },
        { thread_ids: ['b'], archive: false },
      ],
    })
    expect(out.message).toMatch(/^Changed 2 threads, 1 thread already that way\./)
  })

  it('labels and mute ride through as the tool names them', async () => {
    h.changeEmailThreads.mockResolvedValue([
      { threadId: 'a', status: 'changed', applied: { addLabels: ['Receipts'], mute: true, archive: true }, undo: { removeLabels: ['Receipts'], mute: false, archive: false }, createdLabels: ['Receipts'] },
    ])
    const out = await update({ thread_ids: ['a'], add_labels: ['Receipts'], mute: true })
    expect(h.changeEmailThreads).toHaveBeenCalledWith('user-1', 'ws-1', ['a'], { addLabels: ['Receipts'], mute: true })
    expect(out).toMatchObject({
      undo: [{ thread_ids: ['a'], archive: false, remove_labels: ['Receipts'], mute: false }],
      created_labels: ['Receipts'],
    })
  })

  it('refuses a call that changes nothing, mute with archive false, and the flags as labels', async () => {
    expect(await update({ thread_ids: ['a'] })).toMatchObject({ success: false })
    expect(await update({ thread_ids: ['a'], mute: true, archive: false })).toMatchObject({ success: false, error: expect.stringMatching(/Muting archives/) })
    expect(await update({ thread_ids: ['a'], add_labels: ['Inbox'] })).toMatchObject({ success: false, error: expect.stringMatching(/use archive, read or star/) })
    expect(await update({ thread_ids: ['a'], remove_labels: ['TRASH'] })).toMatchObject({ success: false })
    expect(h.changeEmailThreads).not.toHaveBeenCalled()
  })

  it(`over ${BULK_THREAD_CONFIRM_OVER} threads waits for the person's yes, and changes nothing until then`, async () => {
    const ids = Array.from({ length: BULK_THREAD_CONFIRM_OVER + 1 }, (_, i) => `t${i}`)
    const waiting = await update({ thread_ids: ids, archive: true })
    expect(waiting).toMatchObject({ success: false, code: 'NEEDS_CONFIRMATION', awaiting_go_ahead: true, thread_count: ids.length })
    expect(h.changeEmailThreads).not.toHaveBeenCalled()

    h.changeEmailThreads.mockResolvedValue(ids.map((threadId) => ({ threadId, status: 'changed', applied: { archive: true }, undo: { archive: false } })))
    const done = await update({ thread_ids: ids, archive: true, confirmed_with_user: true })
    expect(done.changed).toBe(ids.length)
    // Its undo is as big, so it carries the yes the person gives by asking for it.
    expect(done.undo).toEqual([{ thread_ids: ids, archive: false, confirmed_with_user: true }])
  })

  it('an undo split over several calls carries the yes when they add up past the limit', async () => {
    const ids = Array.from({ length: BULK_THREAD_CONFIRM_OVER + 2 }, (_, i) => `t${i}`)
    h.changeEmailThreads.mockResolvedValue(ids.map((threadId, i) => ({
      threadId, status: 'changed', applied: { archive: true }, undo: i % 2 ? { archive: false } : { archive: false, read: false },
    })))
    const done = await update({ thread_ids: ids, archive: true, confirmed_with_user: true })
    expect((done.undo as Array<Record<string, unknown>>).map((u) => u.confirmed_with_user)).toEqual([true, true])
  })

  it('a claimed yes to a bulk change in a turn that read mail is asked about instead (it may be planted)', async () => {
    const ids = Array.from({ length: BULK_THREAD_CONFIRM_OVER + 1 }, (_, i) => `t${i}`)
    const out = await update({ thread_ids: ids, archive: true, confirmed_with_user: true }, { turnReadOutside: () => ['list_emails'] })
    expect(out).toMatchObject({ success: false, code: 'NEEDS_CONFIRMATION', awaiting_go_ahead: true, error: expect.stringMatching(/this turn read mail/) })
    expect(h.changeEmailThreads).not.toHaveBeenCalled()
    // A small change, or a turn that read nothing outside, runs.
    h.changeEmailThreads.mockResolvedValue([{ threadId: 't0', status: 'unchanged' }])
    expect(await update({ thread_ids: ['t0'], archive: true }, { turnReadOutside: () => ['list_emails'] })).toMatchObject({ success: true })
    h.changeEmailThreads.mockResolvedValue(ids.map((threadId) => ({ threadId, status: 'unchanged' })))
    expect(await update({ thread_ids: ids, archive: true, confirmed_with_user: true }, { turnReadOutside: () => [] })).toMatchObject({ success: true })
  })

  it('a change that partly landed says so, and its undo is offered', async () => {
    h.changeEmailThreads.mockResolvedValue([
      { threadId: 'a', status: 'failed', applied: { archive: true, star: true }, undo: { archive: false, star: false }, error: 'Gmail modify error: 500' },
    ])
    const out = await update({ thread_ids: ['a'], archive: true, star: true })
    expect(out).toMatchObject({ success: false, changed: 0, undo: [{ thread_ids: ['a'], archive: false, star: false }] })
    expect((out.threads as Array<Record<string, unknown>>)[0].applied).toBeUndefined()
    expect(out.message).toMatch(/Part of the change landed on 1 that failed/)
  })

  it(`exactly ${BULK_THREAD_CONFIRM_OVER} threads need no yes`, async () => {
    const ids = Array.from({ length: BULK_THREAD_CONFIRM_OVER }, (_, i) => `t${i}`)
    h.changeEmailThreads.mockResolvedValue(ids.map((threadId) => ({ threadId, status: 'unchanged' })))
    expect(await update({ thread_ids: ids, read: true })).toMatchObject({ success: true, changed: 0 })
  })

  it('reports failures beside what changed, and fails when nothing could change', async () => {
    h.changeEmailThreads.mockResolvedValue([{ threadId: 'a', status: 'failed', error: 'Gmail modify error: 403' }, { threadId: 'b', status: 'not_found', error: 'No mailbox' }])
    const out = await update({ thread_ids: ['a', 'b'], archive: true })
    expect(out).toMatchObject({ success: false, changed: 0, threads: [{ thread_id: 'a', status: 'failed', error: 'Gmail modify error: 403' }, { thread_id: 'b', status: 'not_found' }] })
    expect(out.undo).toBeUndefined()
  })
})

describe('unsubscribe_thread', () => {
  it('never runs in the turn: only as the replay of the person’s accepted card', async () => {
    expect(await unsubscribe()).toMatchObject({ success: false, code: 'APPROVAL_REQUIRED' })
    expect(await unsubscribe('update_email_thread')).toMatchObject({ success: false, code: 'APPROVAL_REQUIRED' })
    expect(h.unsubscribeFromThread).not.toHaveBeenCalled()
  })

  it('unsubscribes under the accepted card, held to the way the card showed', async () => {
    h.unsubscribeFromThread.mockResolvedValue({ ok: true, method: 'one_click', target: 'shop.com' })
    expect(await unsubscribe('unsubscribe_thread', { unsubscribe: { method: 'one_click', key: 'k1' } })).toMatchObject({
      success: true, method: 'one_click', message: expect.stringContaining('shop.com'),
    })
    expect(h.unsubscribeFromThread).toHaveBeenCalledWith('user-1', 'ws-1', 't1', { pinned: 'k1' })
    // A card that couldn't read the list's headers pinned nothing (it said so).
    await unsubscribe('unsubscribe_thread')
    expect(h.unsubscribeFromThread).toHaveBeenLastCalledWith('user-1', 'ws-1', 't1', { pinned: null })
  })

  it('refuses a thread flagged suspicious, even under the card', async () => {
    h.trust = [{ provider_thread_id: 't1', trust: 'suspicious' }]
    expect(await unsubscribe('unsubscribe_thread')).toMatchObject({ success: false, trust: 'suspicious' })
    expect(h.unsubscribeFromThread).not.toHaveBeenCalled()
  })

  it('a web page only: the sender’s link, inside the untrusted marker, for the person to open', async () => {
    h.unsubscribeFromThread.mockResolvedValue({ ok: false, reason: 'link_only', url: 'https://shop.com/prefs' })
    const out = await unsubscribe('unsubscribe_thread')
    expect(out).toMatchObject({ success: false, code: 'LINK_ONLY' })
    expect(String(out.unsubscribe_url).startsWith(UNTRUSTED_EMAIL_PREFIX)).toBe(true)
    expect(out.unsubscribe_url).toContain('https://shop.com/prefs')
  })
})
