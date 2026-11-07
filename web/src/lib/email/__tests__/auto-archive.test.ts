/**
 * The morning tidy (src/lib/email/auto-archive.ts, migration 446). Pinned:
 *   • what qualifies: this person's inbox rows in this workspace, notification
 *     or transactional, not starred, not a draft, not needing a reply, quiet
 *     for 30 minutes and newer than this workspace's last cutoff before today
 *     (at most 26 hours back); not from a sender of an undone batch; nothing
 *     the agent raised in the last 7 days; at most 100 a day across the
 *     person's workspaces, newest first, one per thread. Kept senders, raised
 *     threads and the cap are the PERSON's, in any workspace (one mailbox,
 *     copied into each it is linked to); the window's start is the
 *     workspace's own (its own clock, maybe its own mailbox);
 *   • a pass: the plan lands as a `running` row before anything moves, then
 *     `done` with what moved and its senders; one message in the home thread
 *     and one log line, only when something moved; starred or flagged mail
 *     is left alone live (skipStarred); a row that can't record what moved
 *     throws before any message says it can be undone;
 *   • a done day is returned as is, a running one resumes (what the first
 *     attempt moved counts as archived where the index says so), no home
 *     thread or no 446 is a skip;
 *   • Undo: `archive: false` on what moved, marked undone once (one log
 *     line), the message rewritten as put back; a thread deleted or trashed
 *     since is `gone`, not a failure; another person's batch is not found.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ThreadChange, ThreadTriageOutcome } from '../thread-triage'
import { AUTO_ARCHIVE_LOOKBACK_MS, autoArchivePlan, runAutoArchive, undoAutoArchive } from '../auto-archive'
import { EMAIL_AUTO_ARCHIVE_PART_TYPE } from '../auto-archive-part'

vi.mock('@/lib/admin', () => ({ getServiceClient: () => { throw new Error('no service client in tests') } }))

type Row = Record<string, unknown>

/** An in-memory Supabase that applies the filters the tidy chains, and keeps its writes. */
function fakeDb(seed: Record<string, Row[]>, opts: { missing?: string[]; failUpdates?: string[] } = {}) {
  const tables: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]))
  let ids = 0
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = []
    let max = Infinity
    let sort: { key: string; ascending: boolean } | null = null
    let write: { kind: 'update'; patch: Row } | { kind: 'upsert'; row: Row; ignore: boolean; onConflict: string } | null = null
    const missing = opts.missing?.includes(table)
    const run = async () => {
      if (missing) return { data: null, error: { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` } }
      const list = (tables[table] ??= [])
      if (write?.kind === 'upsert') {
        const keys = write.onConflict.split(',')
        const row = write.row
        const clash = list.find((r) => keys.every((k) => r[k] === row[k]))
        if (clash) {
          if (write.ignore) return { data: [], error: null }
          Object.assign(clash, row)
          return { data: [clash], error: null }
        }
        const fresh = { id: `${table}-${++ids}`, created_at: new Date(1_800_000_000_000 + ids).toISOString(), undone_at: null, archived_ids: [], senders: [], ...row }
        list.push(fresh)
        return { data: [fresh], error: null }
      }
      let rows = list.filter((r) => filters.every((f) => f(r)))
      if (write?.kind === 'update') {
        if (opts.failUpdates?.includes(table)) return { data: null, error: { message: `${table} write refused` } }
        for (const r of rows) Object.assign(r, write.patch)
        return { data: rows, error: null }
      }
      if (sort) {
        const { key, ascending } = sort
        rows = [...rows].sort((a, b) => String(a[key]).localeCompare(String(b[key])) * (ascending ? 1 : -1))
      }
      return { data: rows.slice(0, max), error: null }
    }
    const chain: Record<string, unknown> = {
      select: () => chain,
      order: (key: string, o?: { ascending?: boolean }) => ((sort = { key, ascending: o?.ascending !== false }), chain),
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), chain),
      is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), chain),
      not: (k: string, op: string, v: unknown) => (filters.push((r) => (op === 'is' ? (r[k] ?? null) !== v : true)), chain),
      in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), chain),
      gt: (k: string, v: string) => (filters.push((r) => String(r[k]) > v), chain),
      gte: (k: string, v: string) => (filters.push((r) => String(r[k]) >= v), chain),
      lte: (k: string, v: string) => (filters.push((r) => String(r[k]) <= v), chain),
      lt: (k: string, v: string) => (filters.push((r) => String(r[k]) < v), chain),
      limit: (n: number) => ((max = n), chain),
      update: (patch: Row) => ((write = { kind: 'update', patch }), chain),
      upsert: (row: Row, o: { onConflict: string; ignoreDuplicates?: boolean }) => (
        (write = { kind: 'upsert', row, ignore: o.ignoreDuplicates === true, onConflict: o.onConflict }), chain
      ),
      maybeSingle: async () => {
        const { data, error } = await run()
        return { data: (data as Row[] | null)?.[0] ?? null, error }
      },
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => run().then(ok, bad),
    }
    return chain
  }
  return { db: { from } as never, tables }
}

const NOW = Date.parse('2026-10-27T08:00:00Z')
const WS = 'ws-1'
const ME = 'user-1'
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString()

function thread(id: string, over: Row = {}): Row {
  return {
    workspace_id: WS,
    user_id: ME,
    provider_thread_id: id,
    from_email: `${id}@shop.example`,
    folder: 'inbox',
    auto_classified: 'transactional',
    is_starred: false,
    is_draft: false,
    needs_reply: false,
    last_message_at: ago(120),
    ...over,
  }
}

const HOME = { chat_conversations: [{ id: 'conv-1', user_id: ME, workspace_id: WS, is_home: true }] }

/** A change that archives (or puts back) every thread it is given. */
function changeAll(status: ThreadTriageOutcome['status'] = 'changed') {
  return vi.fn(async (_u: string, _w: string, ids: readonly string[], change: ThreadChange): Promise<ThreadTriageOutcome[]> =>
    ids.map((threadId) => ({ threadId, status, ...(status === 'changed' ? { applied: change, undo: { archive: !change.archive } } : {}) })),
  )
}

describe('autoArchivePlan', () => {
  it('takes this person’s quiet inbox receipts and notifications in the window, newest first', async () => {
    const { db } = fakeDb({
      email_thread_index: [
        thread('t-receipt', { last_message_at: ago(60) }),
        thread('t-notice', { auto_classified: 'notification', last_message_at: ago(90) }),
        thread('t-news', { auto_classified: 'newsletter' }),
        thread('t-person', { auto_classified: 'personal' }),
        thread('t-starred', { is_starred: true }),
        thread('t-draft', { is_draft: true }),
        thread('t-reply', { needs_reply: true }),
        thread('t-archived', { folder: 'archive' }),
        thread('t-fresh', { last_message_at: ago(10) }),
        thread('t-old', { last_message_at: ago(27 * 60) }),
        thread('t-other-ws', { workspace_id: 'ws-2' }),
        thread('t-other-user', { user_id: 'user-2' }),
        thread('t-null-star', { is_starred: null, last_message_at: ago(200) }),
      ],
    })
    const plan = await autoArchivePlan(db, { workspaceId: WS, userId: ME }, NOW)
    expect(plan.threadIds).toEqual(['t-receipt', 't-notice', 't-null-star'])
    expect(plan.cutoffIso).toBe(ago(30))
    expect(plan.sinceIso).toBe(new Date(NOW - AUTO_ARCHIVE_LOOKBACK_MS).toISOString())
  })

  it('starts after the last pass’s cutoff', async () => {
    const { db } = fakeDb({
      email_auto_archive: [{ workspace_id: WS, user_id: ME, cutoff_at: ago(100), created_at: ago(24 * 60), senders: [], undone_at: null }],
      email_thread_index: [thread('t-before', { last_message_at: ago(110) }), thread('t-after', { last_message_at: ago(95) })],
    })
    const plan = await autoArchivePlan(db, { workspaceId: WS, userId: ME }, NOW)
    expect(plan.threadIds).toEqual(['t-after'])
    expect(plan.sinceIso).toBe(ago(100))
  })

  it('leaves mail from the senders of an undone batch, and threads the agent raised, in any of the person’s workspaces', async () => {
    const { db } = fakeDb({
      email_auto_archive: [
        { workspace_id: 'ws-2', user_id: ME, local_date: '2026-10-25', cutoff_at: ago(48 * 60), created_at: ago(48 * 60), senders: ['kept@shop.example'], undone_at: ago(20 * 60) },
        { workspace_id: WS, user_id: 'user-2', local_date: '2026-10-25', cutoff_at: ago(48 * 60), created_at: ago(48 * 60), senders: ['t-go@shop.example'], undone_at: ago(20 * 60) },
      ],
      email_thread_index: [
        thread('t-kept', { from_email: 'Kept@Shop.Example' }),
        thread('t-raised'),
        thread('t-old-event'),
        thread('t-go'),
      ],
      agent_event: [
        { workspace_id: WS, user_id: ME, ref_type: 'email_thread', ref_id: 't-raised', occurs_at: ago(60) },
        { workspace_id: WS, user_id: ME, ref_type: 'email_thread', ref_id: 't-old-event', occurs_at: ago(8 * 24 * 60) },
        { workspace_id: 'ws-2', user_id: ME, ref_type: 'email_thread', ref_id: 't-raised-elsewhere', occurs_at: ago(60) },
        { workspace_id: WS, user_id: 'user-2', ref_type: 'email_thread', ref_id: 't-go', occurs_at: ago(60) },
      ],
    })
    const plan = await autoArchivePlan(db, { workspaceId: WS, userId: ME }, NOW)
    expect(plan.threadIds).toEqual(['t-old-event', 't-go'])
  })

  it('starts after this workspace’s last cutoff before today; today’s pass elsewhere takes from the cap', async () => {
    const { db } = fakeDb({
      email_auto_archive: [
        // Yesterday's, here: the window starts there.
        { workspace_id: WS, user_id: ME, local_date: '2026-10-26', cutoff_at: ago(24 * 60 + 30), created_at: ago(24 * 60), archived_ids: [], senders: [], undone_at: null },
        // Another workspace's later one (another clock, maybe another mailbox): not this window's start.
        { workspace_id: 'ws-2', user_id: ME, local_date: '2026-10-26', cutoff_at: ago(14 * 60), created_at: ago(14 * 60), archived_ids: [], senders: [], undone_at: null },
        // Today's, in another workspace, minutes ago: its 98 count against the day's 100.
        { workspace_id: 'ws-2', user_id: ME, local_date: '2026-10-27', cutoff_at: ago(31), created_at: ago(1), archived_ids: Array.from({ length: 98 }, (_, i) => `x-${i}`), senders: [], undone_at: null },
      ],
      email_thread_index: [
        thread('t-1', { last_message_at: ago(60) }),
        thread('t-2', { last_message_at: ago(70) }),
        thread('t-3', { last_message_at: ago(80) }),
        thread('t-before', { last_message_at: ago(25 * 60) }),
      ],
    })
    const plan = await autoArchivePlan(db, { workspaceId: WS, userId: ME }, NOW, '2026-10-27')
    expect(plan.sinceIso).toBe(ago(24 * 60 + 30))
    expect(plan.threadIds).toEqual(['t-1', 't-2'])
  })

  it('reads what the agent raised a few threads at a time (the ids ride in the URL)', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => thread(`t-${String(i).padStart(3, '0')}`, { last_message_at: ago(40 + i) }))
    const { db } = fakeDb({ email_thread_index: rows, agent_event: [{ workspace_id: WS, user_id: ME, ref_type: 'email_thread', ref_id: 't-110', occurs_at: ago(60) }] })
    const inLists: number[] = []
    type Chain = { in: (k: string, vs: unknown[]) => unknown }
    const from = (db as unknown as { from: (t: string) => Chain }).from
    ;(db as unknown as { from: unknown }).from = (table: string) => {
      const chain = from(table)
      if (table !== 'agent_event') return chain
      const inner = chain.in
      chain.in = (k, vs) => (inLists.push(vs.length), inner(k, vs))
      return chain
    }
    const plan = await autoArchivePlan(db, { workspaceId: WS, userId: ME }, NOW)
    expect(inLists).toEqual([50, 50, 20])
    expect(plan.threadIds).toHaveLength(100)
    expect(plan.threadIds).not.toContain('t-110')
  })

  it('one per thread, at most 100', async () => {
    const rows = Array.from({ length: 140 }, (_, i) => thread(`t-${String(i).padStart(3, '0')}`, { last_message_at: ago(40 + i) }))
    rows.push(thread('t-000', { account_id: 'second-mailbox', last_message_at: ago(41) }))
    const { db } = fakeDb({ email_thread_index: rows })
    const plan = await autoArchivePlan(db, { workspaceId: WS, userId: ME }, NOW)
    expect(plan.threadIds).toHaveLength(100)
    expect(new Set(plan.threadIds).size).toBe(100)
    expect(plan.threadIds[0]).toBe('t-000')
  })
})

describe('runAutoArchive', () => {
  const args = { workspaceId: WS, userId: ME, date: '2026-10-27', nowMs: NOW }

  it('archives, records the day, writes one message and one log line', async () => {
    const { db, tables } = fakeDb({
      ...HOME,
      email_thread_index: [
        thread('t-1', { from_email: 'auto-confirm@amazon.com' }),
        thread('t-2', { from_email: 'shipment@amazon.com', last_message_at: ago(130) }),
        thread('t-3', { from_email: 'payroll@gusto.com', last_message_at: ago(140) }),
      ],
    })
    const change = changeAll()
    const writeMessage = vi.fn(async () => true)
    const appendLog = vi.fn(async () => true)
    const out = await runAutoArchive(db, args, { change, writeMessage, appendLog })

    expect(change).toHaveBeenCalledWith(ME, WS, ['t-1', 't-2', 't-3'], { archive: true }, { skipStarred: true })
    expect(out).toEqual({ status: 'archived', batchId: expect.any(String), archived: 3, failed: 0 })
    const row = tables.email_auto_archive[0]
    expect(row).toMatchObject({
      workspace_id: WS,
      user_id: ME,
      local_date: '2026-10-27',
      status: 'done',
      cutoff_at: ago(30),
      thread_ids: ['t-1', 't-2', 't-3'],
      archived_ids: ['t-1', 't-2', 't-3'],
      senders: ['auto-confirm@amazon.com', 'shipment@amazon.com', 'payroll@gusto.com'],
    })
    expect(writeMessage).toHaveBeenCalledOnce()
    expect(writeMessage).toHaveBeenCalledWith(db, { workspaceId: WS, userId: ME, conversationId: 'conv-1' }, {
      batch_id: row.id,
      count: 3,
      domains: ['amazon.com', 'gusto.com'],
      more_domains: 0,
    })
    expect(appendLog).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        userId: ME,
        kind: 'mail_archived',
        refType: 'email_auto_archive',
        refId: row.id,
        dedupeKey: `mail:auto-archive:${row.id}`,
        line: expect.stringContaining('Archived 3 receipts and notifications'),
      }),
      db,
    )
  })

  it('a thread that failed outright is not put back by Undo; one that partly moved is', async () => {
    const { db, tables } = fakeDb({ ...HOME, email_thread_index: [thread('t-1'), thread('t-2', { last_message_at: ago(130) }), thread('t-3', { last_message_at: ago(140) })] })
    const change = vi.fn(async (): Promise<ThreadTriageOutcome[]> => [
      { threadId: 't-1', status: 'changed', undo: { archive: false } },
      { threadId: 't-2', status: 'failed', error: 'boom' },
      { threadId: 't-3', status: 'failed', undo: { archive: false }, error: 'half' },
    ])
    const out = await runAutoArchive(db, args, { change, writeMessage: vi.fn(async () => true), appendLog: vi.fn(async () => true) })
    expect(out).toMatchObject({ status: 'archived', archived: 2, failed: 1 })
    expect(tables.email_auto_archive[0].archived_ids).toEqual(['t-1', 't-3'])
  })

  it('nothing to archive: no row, no message', async () => {
    const { db, tables } = fakeDb({ ...HOME, email_thread_index: [thread('t-news', { auto_classified: 'newsletter' })] })
    const change = changeAll()
    const writeMessage = vi.fn(async () => true)
    expect(await runAutoArchive(db, args, { change, writeMessage })).toEqual({ status: 'nothing' })
    expect(change).not.toHaveBeenCalled()
    expect(writeMessage).not.toHaveBeenCalled()
    expect(tables.email_auto_archive ?? []).toEqual([])
  })

  it('a day already done is returned as is', async () => {
    const { db } = fakeDb({
      ...HOME,
      email_auto_archive: [{ id: 'b-1', workspace_id: WS, user_id: ME, local_date: '2026-10-27', status: 'done', cutoff_at: ago(30), thread_ids: ['t-1'], archived_ids: ['t-1'], senders: [], undone_at: null }],
      email_thread_index: [thread('t-2')],
    })
    const change = changeAll()
    expect(await runAutoArchive(db, args, { change })).toEqual({ status: 'already', batchId: 'b-1', archived: 1 })
    expect(change).not.toHaveBeenCalled()
  })

  it('a running day resumes its own plan: what the first attempt moved counts', async () => {
    const { db, tables } = fakeDb({
      ...HOME,
      email_auto_archive: [{ id: 'b-1', workspace_id: WS, user_id: ME, local_date: '2026-10-27', status: 'running', cutoff_at: ago(30), thread_ids: ['t-1', 't-2'], archived_ids: [], senders: [], undone_at: null }],
      email_thread_index: [thread('t-1', { folder: 'archive' }), thread('t-2'), thread('t-3')],
    })
    const change = vi.fn(async (): Promise<ThreadTriageOutcome[]> => [
      { threadId: 't-1', status: 'unchanged' },
      { threadId: 't-2', status: 'changed', undo: { archive: false } },
    ])
    const out = await runAutoArchive(db, args, { change, writeMessage: vi.fn(async () => true), appendLog: vi.fn(async () => true) })
    expect(change).toHaveBeenCalledWith(ME, WS, ['t-1', 't-2'], { archive: true }, { skipStarred: true })
    expect(out).toMatchObject({ status: 'archived', batchId: 'b-1', archived: 2 })
    expect(tables.email_auto_archive[0]).toMatchObject({ status: 'done', archived_ids: ['t-1', 't-2'] })
  })

  it('a resumed day leaves out what was never in the inbox, and what was kept starred', async () => {
    const { db, tables } = fakeDb({
      ...HOME,
      email_auto_archive: [{ id: 'b-1', workspace_id: WS, user_id: ME, local_date: '2026-10-27', status: 'running', cutoff_at: ago(30), thread_ids: ['t-moved', 't-stale', 't-starred'], archived_ids: [], senders: [], undone_at: null }],
      email_thread_index: [thread('t-moved', { folder: 'archive' }), thread('t-stale'), thread('t-starred')],
    })
    const change = vi.fn(async (): Promise<ThreadTriageOutcome[]> => [
      { threadId: 't-moved', status: 'unchanged' },
      { threadId: 't-stale', status: 'unchanged' },
      { threadId: 't-starred', status: 'unchanged', kept: 'starred' },
    ])
    await runAutoArchive(db, args, { change, writeMessage: vi.fn(async () => true), appendLog: vi.fn(async () => true) })
    expect(tables.email_auto_archive[0].archived_ids).toEqual(['t-moved'])
  })

  it('a row that can’t record what moved throws, before any message says it can be undone', async () => {
    const { db, tables } = fakeDb({ ...HOME, email_thread_index: [thread('t-1')] }, { failUpdates: ['email_auto_archive'] })
    const writeMessage = vi.fn(async () => true)
    const appendLog = vi.fn(async () => true)
    await expect(runAutoArchive(db, args, { change: changeAll(), writeMessage, appendLog })).rejects.toThrow(/done mark failed/)
    expect(writeMessage).not.toHaveBeenCalled()
    expect(appendLog).not.toHaveBeenCalled()
    expect(tables.email_auto_archive[0]).toMatchObject({ status: 'running', thread_ids: ['t-1'] })
  })

  it('the retry after a failed done mark resumes the row, and what the first attempt archived is in its Undo', async () => {
    const seed = { ...HOME, email_thread_index: [thread('t-1')] }
    const first = fakeDb(seed, { failUpdates: ['email_auto_archive'] })
    await expect(runAutoArchive(first.db, args, { change: changeAll(), writeMessage: vi.fn(async () => true), appendLog: vi.fn(async () => true) })).rejects.toThrow()
    // The archive landed (the index says so); the row is still running.
    const { db, tables } = fakeDb({
      ...HOME,
      email_auto_archive: first.tables.email_auto_archive,
      email_thread_index: [thread('t-1', { folder: 'archive' })],
    })
    const writeMessage = vi.fn(async () => true)
    const out = await runAutoArchive(db, args, { change: changeAll('unchanged'), writeMessage, appendLog: vi.fn(async () => true) })
    expect(out).toMatchObject({ status: 'archived', archived: 1 })
    expect(tables.email_auto_archive[0]).toMatchObject({ status: 'done', archived_ids: ['t-1'] })
    expect(writeMessage).toHaveBeenCalledOnce()
  })

  it('a fresh day counts a thread already out of the inbox as not archived by the tidy', async () => {
    const { db, tables } = fakeDb({ ...HOME, email_thread_index: [thread('t-1'), thread('t-2', { last_message_at: ago(130) })] })
    const change = vi.fn(async (): Promise<ThreadTriageOutcome[]> => [
      { threadId: 't-1', status: 'unchanged' },
      { threadId: 't-2', status: 'changed', undo: { archive: false } },
    ])
    await runAutoArchive(db, args, { change, writeMessage: vi.fn(async () => true), appendLog: vi.fn(async () => true) })
    expect(tables.email_auto_archive[0].archived_ids).toEqual(['t-2'])
  })

  it('nothing moved: the day is done, with no message', async () => {
    const { db, tables } = fakeDb({ ...HOME, email_thread_index: [thread('t-1')] })
    const writeMessage = vi.fn(async () => true)
    const appendLog = vi.fn(async () => true)
    const out = await runAutoArchive(db, args, { change: changeAll('not_found'), writeMessage, appendLog })
    expect(out).toMatchObject({ status: 'archived', archived: 0 })
    expect(tables.email_auto_archive[0].status).toBe('done')
    expect(writeMessage).not.toHaveBeenCalled()
    expect(appendLog).not.toHaveBeenCalled()
  })

  it('no home thread: nothing moves', async () => {
    const { db } = fakeDb({ chat_conversations: [], email_thread_index: [thread('t-1')] })
    const change = changeAll()
    expect(await runAutoArchive(db, args, { change })).toEqual({ status: 'no_home_thread' })
    expect(change).not.toHaveBeenCalled()
  })

  it('before migration 446: a skip, not a throw', async () => {
    const { db } = fakeDb({ ...HOME, email_thread_index: [thread('t-1')] }, { missing: ['email_auto_archive'] })
    const change = changeAll()
    expect(await runAutoArchive(db, args, { change })).toEqual({ status: 'unavailable' })
    expect(change).not.toHaveBeenCalled()
  })
})

describe('undoAutoArchive', () => {
  const batch = (over: Row = {}): Row => ({
    id: 'b-1',
    workspace_id: WS,
    user_id: ME,
    local_date: '2026-10-27',
    status: 'done',
    cutoff_at: ago(30),
    thread_ids: ['t-1', 't-2'],
    archived_ids: ['t-1', 't-2'],
    senders: ['a@amazon.com', 'b@gusto.com'],
    undone_at: null,
    ...over,
  })

  it('puts the batch back, marks it undone once, logs it and rewrites the message', async () => {
    const { db, tables } = fakeDb({ ...HOME, email_auto_archive: [batch()], email_thread_index: [thread('t-1', { from_email: 'a@amazon.com' }), thread('t-2', { from_email: 'b@gusto.com' })] })
    const change = changeAll()
    const writeMessage = vi.fn(async () => true)
    const appendLog = vi.fn(async () => true)
    const out = await undoAutoArchive(db, { workspaceId: WS, userId: ME, batchId: 'b-1', nowMs: NOW }, { change, writeMessage, appendLog })

    expect(out).toEqual({ ok: true, restored: 2, failed: 0, gone: 0 })
    expect(change).toHaveBeenCalledWith(ME, WS, ['t-1', 't-2'], { archive: false })
    expect(tables.email_auto_archive[0].undone_at).toBe(new Date(NOW).toISOString())
    expect(appendLog).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'mail_archived', dedupeKey: 'mail:auto-archive:b-1:undone', line: expect.stringContaining('Put back 2') }),
      db,
    )
    expect(writeMessage).toHaveBeenCalledWith(db, { workspaceId: WS, userId: ME, conversationId: 'conv-1' }, {
      batch_id: 'b-1',
      count: 2,
      domains: ['amazon.com', 'gusto.com'],
      more_domains: 0,
      undone: true,
    })

    // Again: the moves are safe to repeat, the mark and the line are not repeated.
    appendLog.mockClear()
    await undoAutoArchive(db, { workspaceId: WS, userId: ME, batchId: 'b-1', nowMs: NOW + 60_000 }, { change: changeAll('unchanged'), writeMessage, appendLog })
    expect(tables.email_auto_archive[0].undone_at).toBe(new Date(NOW).toISOString())
    expect(appendLog).not.toHaveBeenCalled()
  })

  it('another person’s batch, or another workspace’s, is not found', async () => {
    const { db } = fakeDb({ ...HOME, email_auto_archive: [batch({ user_id: 'user-2' }), batch({ id: 'b-2', workspace_id: 'ws-2' })] })
    const change = changeAll()
    expect(await undoAutoArchive(db, { workspaceId: WS, userId: ME, batchId: 'b-1' }, { change })).toEqual({ ok: false, reason: 'not_found' })
    expect(await undoAutoArchive(db, { workspaceId: WS, userId: ME, batchId: 'b-2' }, { change })).toEqual({ ok: false, reason: 'not_found' })
    expect(change).not.toHaveBeenCalled()
  })

  it('a thread deleted or trashed since is gone, not a failure; a refusal is a failure', async () => {
    const { db } = fakeDb({ ...HOME, email_auto_archive: [batch({ archived_ids: ['t-1', 't-2', 't-3', 't-4'] })] })
    const change = vi.fn(async (): Promise<ThreadTriageOutcome[]> => [
      { threadId: 't-1', status: 'changed' },
      { threadId: 't-2', status: 'not_found' },
      { threadId: 't-3', status: 'failed', trashed: true, error: 'This thread is in Trash or Spam.' },
      { threadId: 't-4', status: 'failed', error: 'Graph said 503' },
    ])
    expect(await undoAutoArchive(db, { workspaceId: WS, userId: ME, batchId: 'b-1' }, { change, writeMessage: vi.fn(async () => true), appendLog: vi.fn(async () => true) })).toEqual({
      ok: true,
      restored: 1,
      failed: 1,
      gone: 2,
    })
  })
})

describe('the message part', () => {
  it('is the one data part the chat draws', async () => {
    const { writeAutoArchiveMessage } = await import('../auto-archive')
    const { db, tables } = fakeDb({ chat_messages: [] })
    const data = { batch_id: 'b-1', count: 2, domains: ['amazon.com'], more_domains: 0 }
    expect(await writeAutoArchiveMessage(db, { workspaceId: WS, userId: ME, conversationId: 'conv-1' }, data)).toBe(true)
    expect(tables.chat_messages).toHaveLength(1)
    expect(tables.chat_messages[0]).toMatchObject({
      conversation_id: 'conv-1',
      user_id: ME,
      workspace_id: WS,
      role: 'assistant',
      ui_message: {
        id: 'email-auto-archive:b-1',
        role: 'assistant',
        parts: [{ type: EMAIL_AUTO_ARCHIVE_PART_TYPE, id: 'email-auto-archive:b-1', data }],
        metadata: { kind: 'email_auto_archive', batch_id: 'b-1' },
      },
    })
  })
})
