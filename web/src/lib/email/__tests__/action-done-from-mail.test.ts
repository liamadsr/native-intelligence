/**
 * Arriving mail marks a matching open to-do done (action-done-from-mail.ts,
 * migration 450). Pinned:
 *   • the to-dos: the person's own to-do list here (open-work.ts: assigned
 *     through the join table, top level, accepted, in an open state), never
 *     one mail closed before or one linked to Linear, Jira or Asana;
 *     unreadable (450 missing, a failed read) closes nothing;
 *   • the input: the newest messages oldest first, drafts left out, none when
 *     the person sent the newest; to-dos made after the newest message left
 *     out; the least recently touched dropped until it fits;
 *   • a close: the row first (unique per to-do: a retry closes nothing
 *     twice), the move only while the to-do sits where it was read (else the
 *     row goes), a flow fired as an agent's change, one message in the home
 *     thread and one log line, the mail's text in neither;
 *   • the pass: only confirmation-like kinds in the inbox or archive, never a
 *     trust-marked thread, nothing without a home thread (Undo lives there),
 *     the to-dos read once, a closed one leaves the list, at most
 *     MAX_CLOSED_PER_PASS;
 *   • Undo: back where it was (or the team's default when that state is
 *     gone), only while still in the done state mail put it in; moved since,
 *     left alone; marked once, the message rewritten; another person's row is
 *     not found.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import type { EmailMessageForAI } from '../email-read-service'
import {
  MAX_CLOSED_PER_PASS,
  closeTodoFromMail,
  doneInput,
  mailDonePass,
  readOpenTodos,
  undoActionDoneFromMail,
  type OpenTodo,
} from '../action-done-from-mail'
import { ACTION_DONE_PART_TYPE } from '../action-done-part'

vi.mock('@/lib/admin', () => ({ getServiceClient: () => { throw new Error('no service client in tests') } }))

const WS = 'ws'
const ME = 'me@x.com'
const T0 = '2026-10-01T10:00:00.000Z'

const message = (over: Partial<EmailMessageForAI> = {}): EmailMessageForAI => ({
  messageId: 'm1', from: 'Enterprise Rent-A-Car <enterprise@email.enterprise.com>', to: ME, cc: '', isDraft: false,
  date: '10/27/2026', dateISO: '2026-10-27T13:30:00.000Z', subject: 'Your Enterprise Reservation Confirmation #1234567890',
  bodyText: 'Your reservation is confirmed. Pick-up: Wed, Oct 28.', hasAttachments: false, attachmentNames: [], ...over,
})

const todo = (over: Partial<OpenTodo> = {}): OpenTodo => ({
  id: 'a1', identifier: 'GEN-863', title: 'Look into renting a car for next week', description: null, dueAt: '2026-10-19T00:00:00.000Z',
  teamId: 'team', statusId: 'backlog', createdAt: T0, ...over,
})

function seedBoard(db: FakeSupabase) {
  db.seed('member', [{ id: 'mem-me', workspace_id: WS, user_id: 'u' }, { id: 'mem-sam', workspace_id: WS, user_id: 'sam' }])
  db.seed('team', [{ id: 'team', workspace_id: WS }])
  db.seed('workflow_state', [
    { id: 'backlog', team_id: 'team', category: 'backlog', sort_order: 0, is_default: false },
    { id: 'canceled', team_id: 'team', category: 'canceled', sort_order: 5 },
    { id: 'todo', team_id: 'team', category: 'unstarted', sort_order: 1, is_default: true },
    { id: 'done', team_id: 'team', category: 'completed', sort_order: 3 },
    { id: 'done-2', team_id: 'team', category: 'completed', sort_order: 4 },
  ])
  // `assigned`: the action_assignee!inner embed (open-work.ts), filtered to one member as
  // `.eq('assigned.member_id', …)` leaves it (the fake reads an embed column off an object).
  const action = (id: string, over: Record<string, unknown> = {}) => ({
    id, workspace_id: WS, identifier: `GEN-${id}`, title: `To-do ${id}`, description: null, due_at: null, team_id: 'team', status_id: 'backlog',
    created_at: T0, updated_at: T0, confirmation: 'confirmed', is_dismissed: false, parent_id: null, assigned: { member_id: 'mem-me' }, ...over,
  })
  db.seed('actions', [
    action('a1', { title: 'Look into renting a car for next week', updated_at: '2026-10-20T00:00:00.000Z' }),
    // Sam's first, the person second: still theirs (the join table, never assignee_id alone).
    action('shared', { assignee_id: 'mem-sam' }),
    action('sams', { assigned: { member_id: 'mem-sam' } }),
    action('done', { status_id: 'done' }),
    action('canceled', { status_id: 'canceled' }),
    action('dismissed', { confirmation: 'dismissed' }),
    action('suggested', { confirmation: 'suggested' }),
    action('sub', { parent_id: 'a1' }),
    action('hidden', { is_dismissed: true }),
    action('elsewhere', { workspace_id: 'other' }),
    action('closed-before'),
    action('in-jira'),
  ])
  db.seed('action_external_task', [{ action_id: 'in-jira', workspace_id: WS, provider: 'jira' }])
  db.seed('action_mail_done', [{ id: 'r0', workspace_id: WS, user_id: 'u', action_id: 'closed-before', undone_at: '2026-10-02T00:00:00.000Z' }])
  db.seed('chat_conversations', [{ id: 'home', user_id: 'u', workspace_id: WS, is_home: true }])
}

/** `table`'s reads fail as they do before migration 450. */
function without450(db: FakeSupabase): FakeSupabase {
  return {
    ...db,
    from: (table: string) => {
      const q = db.from(table) as Record<string, (...a: unknown[]) => unknown>
      if (table !== 'action_mail_done') return q
      const missing = { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.action_mail_done' in the schema cache" } }
      const chain: Record<string, unknown> = {}
      for (const k of ['select', 'eq', 'in', 'is', 'limit', 'order']) chain[k] = () => chain
      chain.maybeSingle = async () => missing
      chain.then = (ok: (v: unknown) => unknown) => Promise.resolve(missing).then(ok)
      return chain
    },
  }
}

describe('readOpenTodos', () => {
  let db: FakeSupabase
  beforeEach(() => {
    db = makeFakeSupabase()
    seedBoard(db)
  })

  it('the person’s own to-do list here (any assignee slot), never a suggestion, a sub-action, one mail closed before or one in Jira', async () => {
    const todos = await readOpenTodos(db as never, { workspaceId: WS, userId: 'u' })
    expect(todos?.map((t) => t.id).sort()).toEqual(['a1', 'shared'])
    expect(todos?.find((t) => t.id === 'a1')).toMatchObject({ identifier: 'GEN-a1', teamId: 'team', statusId: 'backlog', createdAt: T0 })
  })

  it('null when it can’t be read: not a member, 450 missing', async () => {
    expect(await readOpenTodos(db as never, { workspaceId: WS, userId: 'stranger' })).toBeNull()
    expect(await readOpenTodos(without450(db) as never, { workspaceId: WS, userId: 'u' })).toBeNull()
  })
})

describe('doneInput', () => {
  it('the newest messages oldest first (drafts left out), the to-dos made before the newest message', () => {
    const input = doneInput({
      mailbox: ME, now: 'n',
      messages: [message({ messageId: 'm0', subject: 'old' }), message({ messageId: 'm1', subject: 'mid' }), message({ messageId: 'd', isDraft: true, from: `Me <${ME}>` }), message({ messageId: 'm2', subject: 'new' })],
      todos: [todo(), todo({ id: 'later', createdAt: '2026-10-27T14:00:00.000Z' }), todo({ id: 'b', description: '  multi\n\nline  ', dueAt: null })],
    })!
    expect(input.messages.map((m) => m.subject)).toEqual(['mid', 'new'])
    expect(input.messages[1]).toMatchObject({ direction: 'inbound', date: '2026-10-27T13:30:00.000Z' })
    expect(input.todos).toEqual([
      { id: 'a1', title: 'Look into renting a car for next week', due: '2026-10-19' },
      { id: 'b', title: 'Look into renting a car for next week', details: 'multi line' },
    ])
  })

  it('null when the person sent the newest message, or no to-do is left', () => {
    expect(doneInput({ mailbox: ME, now: 'n', messages: [message({ from: `Me <${ME}>` })], todos: [todo()] })).toBeNull()
    expect(doneInput({ mailbox: ME, now: 'n', messages: [message()], todos: [] })).toBeNull()
    expect(doneInput({ mailbox: ME, now: 'n', messages: [message()], todos: [todo({ createdAt: '2026-10-28T00:00:00.000Z' })] })).toBeNull()
  })

  it('drops the least recently touched to-dos until it fits', () => {
    const many = Array.from({ length: 25 }, (_, i) => todo({ id: `t${i}`, title: 'y'.repeat(300), description: 'z'.repeat(400) }))
    const long = 'x'.repeat(5000)
    const input = doneInput({ mailbox: ME, now: 'n', messages: [message({ messageId: 'm0', bodyText: long }), message({ bodyText: long })], todos: many })!
    expect(JSON.stringify(input).length).toBeLessThanOrEqual(20_000)
    expect(input.todos[0].id).toBe('t0')
    expect(input.todos.length).toBeLessThan(25)
  })
})

describe('closeTodoFromMail', () => {
  let db: FakeSupabase
  const emit = vi.fn()
  const appendLog = vi.fn(async () => true)
  const close = (over: Partial<Parameters<typeof closeTodoFromMail>[1]> = {}) =>
    closeTodoFromMail(db as never, {
      workspaceId: WS, userId: 'u', conversationId: 'home', todo: todo(), accountId: 'acct', threadId: 't1', messageId: 'm1',
      from: 'Enterprise Rent-A-Car <enterprise@email.enterprise.com>', nowMs: Date.parse('2026-10-27T14:00:00.000Z'), ...over,
    }, { emit, appendLog })

  beforeEach(() => {
    db = makeFakeSupabase({ unique: { action_mail_done: ['action_id'] } })
    seedBoard(db)
    emit.mockReset()
    appendLog.mockClear()
  })

  it('records where it was, moves it to the team’s first done state, fires flows as an agent’s change, says so once in the home thread and the log', async () => {
    const out = await close()
    expect(out.status).toBe('closed')
    const recordId = (out as { recordId: string }).recordId
    expect(db.rows('action_mail_done').find((r) => r.id === recordId)).toMatchObject({
      workspace_id: WS, user_id: 'u', action_id: 'a1', prior_status_id: 'backlog', done_status_id: 'done',
      account_id: 'acct', thread_id: 't1', message_id: 'm1', sender_domain: 'email.enterprise.com',
    })
    expect(db.rows('actions').find((r) => r.id === 'a1')?.status_id).toBe('done')
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'a1', fromStatusId: 'backlog', toStatusId: 'done', origin: { actor: 'agent', depth: 1 } }))
    const [msg] = db.rows('chat_messages')
    expect(msg).toMatchObject({ conversation_id: 'home', user_id: 'u', workspace_id: WS, role: 'assistant' })
    const ui = msg.ui_message as { id: string; parts: Array<{ type: string; data: Record<string, unknown> }>; metadata: Record<string, unknown> }
    expect(ui.id).toBe(`action-done-from-mail:${recordId}`)
    expect(ui.parts[0]).toMatchObject({ type: ACTION_DONE_PART_TYPE, data: { record_id: recordId, action_id: 'a1', identifier: 'GEN-863', sender_domain: 'email.enterprise.com' } })
    expect(ui.metadata).toEqual({ kind: 'action_done_from_mail', record_id: recordId, action_id: 'a1' })
    expect(appendLog).toHaveBeenCalledOnce()
    const [line] = appendLog.mock.calls[0] as unknown as [{ kind: string; line: string; refType: string; refId: string; dedupeKey: string }]
    expect(line).toMatchObject({ kind: 'action_done_from_mail', refType: 'action', refId: 'a1', dedupeKey: `mail:action-done:${recordId}` })
    expect(line.line).toBe('Marked GEN-863 Look into renting a car for next week done: a confirmation from email.enterprise.com arrived (Undo is on its message in the home thread)')
    // No mail text anywhere it wrote.
    expect(JSON.stringify([db.rows('action_mail_done'), db.rows('chat_messages'), line])).not.toMatch(/Reservation Confirmation|Pick-up/)
  })

  it('a second close of the same to-do is `already` and changes nothing (a retried pass)', async () => {
    await close()
    emit.mockReset()
    expect(await close({ messageId: 'm2' })).toEqual({ status: 'already' })
    expect(emit).not.toHaveBeenCalled()
    expect(db.rows('chat_messages')).toHaveLength(1)
  })

  it('moved since it was read: the change in between wins, and the row goes', async () => {
    db.rows('actions').find((r) => r.id === 'a1')!.status_id = 'todo'
    expect(await close()).toEqual({ status: 'moved' })
    expect(db.rows('actions').find((r) => r.id === 'a1')?.status_id).toBe('todo')
    expect(db.rows('action_mail_done').filter((r) => r.action_id === 'a1')).toEqual([])
    expect(emit).not.toHaveBeenCalled()
    expect(db.rows('chat_messages')).toEqual([])
  })

  it('no done state, or 450 missing: nothing moves', async () => {
    expect(await close({ todo: todo({ teamId: 'no-team' }) })).toEqual({ status: 'no_done_state' })
    db.failNextInsert('action_mail_done', { code: 'PGRST205', message: "Could not find the table 'public.action_mail_done' in the schema cache" })
    expect(await close()).toEqual({ status: 'unavailable' })
    expect(db.rows('actions').find((r) => r.id === 'a1')?.status_id).toBe('backlog')
  })
})

describe('mailDonePass', () => {
  const readTodos = vi.fn()
  const decide = vi.fn()
  const close = vi.fn()
  const homeThread = vi.fn()
  const pass = () => mailDonePass({} as never, { workspaceId: WS, userId: 'u', accountId: 'acct', mailbox: ME, now: 'n' }, { readTodos, decide, close, homeThread })
  const thread = (over: Record<string, unknown> = {}) => ({ kind: 'meeting' as const, trust: null, folder: 'inbox', threadId: 't1', messageId: 'm1', messages: [message()], runId: 'i1', ...over })

  beforeEach(() => {
    readTodos.mockReset().mockResolvedValue([todo(), todo({ id: 'a2', title: 'Pay the Con Edison bill' })])
    decide.mockReset().mockResolvedValue({ status: 'accepted', value: { actionId: 'a1' }, inferenceId: 'inf', version: 'v1' })
    close.mockReset().mockResolvedValue({ status: 'closed', recordId: 'r1' })
    homeThread.mockReset().mockResolvedValue('home')
  })

  it('closes the to-do Jev picks, reading the to-dos once; a closed one leaves the list', async () => {
    const p = pass()
    expect(await p.consider(thread())).toBe('closed')
    expect(decide.mock.calls[0][0].todos.map((t: { id: string }) => t.id)).toEqual(['a1', 'a2'])
    expect(decide.mock.calls[0][1]).toEqual({ userId: 'u', workspaceId: WS, runId: 'i1' })
    expect(close.mock.calls[0][1]).toMatchObject({ conversationId: 'home', todo: { id: 'a1' }, threadId: 't1', messageId: 'm1', from: message().from })
    decide.mockResolvedValue({ status: 'accepted', value: { actionId: null }, inferenceId: 'inf', version: 'v1' })
    expect(await p.consider(thread({ threadId: 't2' }))).toBe('none')
    expect(decide.mock.calls[1][0].todos.map((t: { id: string }) => t.id)).toEqual(['a2'])
    expect(readTodos).toHaveBeenCalledOnce()
    expect(p.closed()).toBe(1)
  })

  it('only confirmation-like kinds in the inbox or archive, never a trust-marked thread; an unsure Jev closes nothing', async () => {
    const p = pass()
    for (const folder of ['spam', 'trash', 'sent', 'drafts', null]) expect(await p.consider(thread({ folder }))).toBe('skipped')
    expect(await p.consider(thread({ kind: 'conversation' }))).toBe('skipped')
    expect(await p.consider(thread({ kind: 'newsletter_or_promo' }))).toBe('skipped')
    expect(await p.consider(thread({ kind: null }))).toBe('skipped')
    expect(await p.consider(thread({ trust: 'injection' }))).toBe('skipped')
    expect(readTodos).not.toHaveBeenCalled()
    decide.mockResolvedValue({ status: 'escalate', reason: 'uncertain' })
    expect(await p.consider(thread({ kind: 'receipt_or_bill', folder: 'archive' }))).toBe('none')
    // A pick that is not on the list.
    decide.mockResolvedValue({ status: 'accepted', value: { actionId: 'nope' }, inferenceId: 'inf', version: 'v1' })
    expect(await p.consider(thread({ kind: 'delivery' }))).toBe('none')
    expect(close).not.toHaveBeenCalled()
  })

  it('no home thread (or an unreadable one): nothing read, nothing asked, nothing closed', async () => {
    homeThread.mockResolvedValue(null)
    const p = pass()
    expect(await p.consider(thread())).toBe('skipped')
    expect(await p.consider(thread({ threadId: 't2' }))).toBe('skipped')
    homeThread.mockRejectedValue(new Error('down'))
    expect(await pass().consider(thread())).toBe('skipped')
    expect(readTodos).not.toHaveBeenCalled()
    expect(decide).not.toHaveBeenCalled()
    expect(homeThread).toHaveBeenCalledTimes(2)
  })

  it('no to-dos (or unreadable) skips without asking Jev; at most MAX_CLOSED_PER_PASS a pass', async () => {
    readTodos.mockResolvedValue(null)
    expect(await pass().consider(thread())).toBe('skipped')
    expect(decide).not.toHaveBeenCalled()
    readTodos.mockResolvedValue(Array.from({ length: 6 }, (_, i) => todo({ id: `t${i}` })))
    let n = 0
    decide.mockImplementation(async () => ({ status: 'accepted', value: { actionId: `t${n++}` }, inferenceId: 'inf', version: 'v1' }))
    const p = pass()
    for (let i = 0; i < 6; i++) await p.consider(thread({ threadId: `t${i}` }))
    expect(p.closed()).toBe(MAX_CLOSED_PER_PASS)
    expect(close).toHaveBeenCalledTimes(MAX_CLOSED_PER_PASS)
  })

  it('never throws: a failing decision is skipped', async () => {
    decide.mockRejectedValue(new Error('down'))
    expect(await pass().consider(thread())).toBe('skipped')
  })
})

describe('undoActionDoneFromMail', () => {
  let db: FakeSupabase
  const emit = vi.fn()
  const appendLog = vi.fn(async () => true)
  const undo = (recordId: string, userId = 'u') => undoActionDoneFromMail(db as never, { workspaceId: WS, userId, recordId, nowMs: Date.parse('2026-10-27T15:00:00.000Z') }, { emit, appendLog })

  beforeEach(async () => {
    db = makeFakeSupabase({ unique: { action_mail_done: ['action_id'] } })
    seedBoard(db)
    emit.mockReset()
    appendLog.mockClear()
  })

  async function closed(): Promise<string> {
    const out = await closeTodoFromMail(db as never, { workspaceId: WS, userId: 'u', conversationId: 'home', todo: todo(), accountId: null, threadId: 't1', messageId: 'm1', from: 'x@enterprise.com' }, { emit: vi.fn(), appendLog: vi.fn(async () => true) })
    return (out as { recordId: string }).recordId
  }

  it('puts it back where it was, as the person’s change; marks the row once; rewrites the message as reopened; a repeat is `already`', async () => {
    const id = await closed()
    expect(await undo(id)).toEqual({ ok: true, status: 'reopened' })
    expect(db.rows('actions').find((r) => r.id === 'a1')?.status_id).toBe('backlog')
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'a1', fromStatusId: 'done', toStatusId: 'backlog' }))
    expect(emit.mock.calls[0][0].origin).toBeUndefined()
    expect(db.rows('action_mail_done').find((r) => r.id === id)?.undone_at).toBe('2026-10-27T15:00:00.000Z')
    const [msg] = db.rows('chat_messages')
    expect((msg.ui_message as { parts: Array<{ data: Record<string, unknown> }> }).parts[0].data).toMatchObject({ record_id: id, undone: true })
    expect((msg.ui_message as { parts: Array<{ data: Record<string, unknown> }> }).parts[0].data.changed).toBeUndefined()
    expect(appendLog).toHaveBeenCalledOnce()
    expect((appendLog.mock.calls[0] as unknown as [{ line: string; dedupeKey: string }])[0]).toMatchObject({
      line: "Reopened GEN-a1 Look into renting a car for next week after Undo; mail won't close it again",
      dedupeKey: `mail:action-done:${id}:undone`,
    })
    expect(await undo(id)).toEqual({ ok: true, status: 'already' })
    expect(emit).toHaveBeenCalledOnce()
  })

  it('moved since mail closed it: left where the person put it, and the message says so', async () => {
    const id = await closed()
    db.rows('actions').find((r) => r.id === 'a1')!.status_id = 'todo'
    expect(await undo(id)).toEqual({ ok: true, status: 'changed' })
    expect(db.rows('actions').find((r) => r.id === 'a1')?.status_id).toBe('todo')
    expect(emit).not.toHaveBeenCalled()
    expect((db.rows('chat_messages')[0].ui_message as { parts: Array<{ data: Record<string, unknown> }> }).parts[0].data).toMatchObject({ undone: true, changed: true })
  })

  it('its old state gone: the team’s default', async () => {
    const id = await closed()
    db.rows('workflow_state').splice(db.rows('workflow_state').findIndex((s) => s.id === 'backlog'), 1)
    expect(await undo(id)).toEqual({ ok: true, status: 'reopened' })
    expect(db.rows('actions').find((r) => r.id === 'a1')?.status_id).toBe('todo')
  })

  it('another person’s row, or none: not found; 450 missing: unavailable', async () => {
    const id = await closed()
    expect(await undo(id, 'sam')).toEqual({ ok: false, reason: 'not_found' })
    expect(await undo('nope')).toEqual({ ok: false, reason: 'not_found' })
    expect(await undoActionDoneFromMail(without450(db) as never, { workspaceId: WS, userId: 'u', recordId: id })).toEqual({ ok: false, reason: 'unavailable' })
    expect(db.rows('actions').find((r) => r.id === 'a1')?.status_id).toBe('done')
  })
})
