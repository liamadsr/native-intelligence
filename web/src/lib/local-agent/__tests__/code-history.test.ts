/**
 * What a Code tab job leaves in its conversation's stored history
 * (code-history.ts, through the work recorder's report, chat-report.ts):
 *
 *   - a turn that ends with a result (review, or done) writes its finish
 *     summary once, as plain assistant text in the chat it was started from;
 *     a retried settle writes nothing new, and only the new row fires the
 *     knowledge trigger (conversation/activity);
 *   - a question, a failure or a stop writes nothing; nothing of the job's
 *     transcript ever does; no teammate's report and no home turn;
 *   - the knowledge extraction reads the person's message, and the summary as
 *     a fenced "Coding agent report" line, and nothing else of the job;
 *   - the ledger marks a Code job's turn rows (and only those) in their source.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sent = vi.hoisted(() => [] as Array<{ name: string; data: unknown }>)
vi.mock('@/lib/notifications', () => ({ createNotification: vi.fn(async () => {}) }))
vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    send: vi.fn(async (e: { name: string; data: unknown } | Array<{ name: string; data: unknown }>) => {
      for (const one of Array.isArray(e) ? e : [e]) sent.push(one)
      return { ids: [] }
    }),
  },
}))

import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { startWork, type StartWorkInput } from '@/lib/work/recorder'
import { renderClaimSourceTranscript } from '@/lib/chat/conversation-history'
import { CODE_FINISH_KIND, codeFinishMessageId, codeFinishSessionOf } from '../code-thread'
import { isCodeJobRow } from '../code-history'
import { ledgerSessionOf, type DbSession } from '../store'
import { turnTitle } from '../ledger'

const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const turnRow = (turn: number, over: Partial<StartWorkInput> = {}): StartWorkInput => ({
  workspaceId: 'w1',
  memberId: 'm1',
  kind: 'local_agent',
  title: 'Claude Code on Studio Mac · harbor-site: Fix the date picker',
  actor: 'agent',
  status: 'running',
  runKey: `local_agent:${SESSION}:${turn}`,
  origin: 'chat',
  source: { chat_conversation_id: 'conv-1', local_agent_session_id: SESSION, folder_label: 'harbor-site', device_name: 'Studio Mac', turn, worker: 'claude-code', local_agent_code: true },
  ...over,
})

function seeded(): FakeSupabase {
  const fake = makeFakeSupabase()
  fake.seed('member', [{ id: 'm1', workspace_id: 'w1', user_id: 'u1' }])
  fake.seed('chat_conversations', [{ id: 'conv-1', user_id: 'u1', workspace_id: 'w1', is_home: true }])
  return fake
}

type Stored = { role: string; ui_message: { id: string; role: string; parts: Array<{ type: string; text?: string }>; metadata: Record<string, unknown> } }
const stored = (fake: FakeSupabase) => fake.rows('chat_messages') as unknown as Stored[]
const activity = () => sent.filter((e) => e.name === 'conversation/activity')

beforeEach(() => {
  sent.length = 0
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

describe('a Code job’s turn in its conversation', () => {
  it('a result writes the finish summary once, as plain assistant text, and fires the knowledge trigger once', async () => {
    const fake = seeded()
    const work = await startWork(fake as never, turnRow(1))
    await work.finish({ summary: 'Fixed the date picker: it now keeps the chosen month. Tests pass.', review: { kind: 'review', verb: 'review' } })
    // A retried settle of the same turn.
    const again = await startWork(fake as never, turnRow(1))
    await again.finish({ summary: 'Fixed the date picker: it now keeps the chosen month. Tests pass.', review: { kind: 'review', verb: 'review' } })

    const rows = stored(fake)
    expect(rows).toHaveLength(1)
    expect(rows[0].role).toBe('assistant')
    expect(rows[0].ui_message.id).toBe(codeFinishMessageId(SESSION, 1))
    expect(rows[0].ui_message.parts).toEqual([{ type: 'text', text: 'Fixed the date picker: it now keeps the chosen month. Tests pass.' }])
    expect(rows[0].ui_message.metadata).toMatchObject({ kind: CODE_FINISH_KIND, local_agent_session_id: SESSION, turn: 1, eve_written: true })
    expect(codeFinishSessionOf(rows[0].ui_message)).toBe(SESSION)
    expect(activity()).toEqual([{ name: 'conversation/activity', data: { workspaceId: 'w1', userId: 'u1', conversationId: 'conv-1' } }])
    // No teammate's report, so no home turn.
    expect(sent.some((e) => e.name === 'home/turn.requested')).toBe(false)
  })

  it('a done turn (a read, nothing committed) writes its summary too; each turn its own message', async () => {
    const fake = seeded()
    await (await startWork(fake as never, turnRow(1))).finish({ summary: 'The picker lives in booking/date-field.tsx.', reportDone: true })
    await (await startWork(fake as never, turnRow(2))).finish({ summary: 'Added the test.', review: { kind: 'review', verb: 'review' } })
    expect(stored(fake).map((r) => r.ui_message.id)).toEqual([codeFinishMessageId(SESSION, 1), codeFinishMessageId(SESSION, 2)])
  })

  it('a question, a failure or a stop writes nothing', async () => {
    const fake = seeded()
    await (await startWork(fake as never, turnRow(1))).needInput([{ id: 'local-agent-ask', question: 'Which month should it open on?' }])
    await (await startWork(fake as never, turnRow(2))).fail('the Mac app closed')
    await (await startWork(fake as never, turnRow(3))).cancel()
    expect(stored(fake)).toEqual([])
    expect(activity()).toEqual([])
  })

  it('an empty summary writes nothing', async () => {
    const fake = seeded()
    await (await startWork(fake as never, turnRow(1))).finish({ summary: null, review: { kind: 'review', verb: 'review' } })
    expect(stored(fake)).toEqual([])
  })

  it('a job the chat agent started still reports as its teammate (today’s path)', async () => {
    const fake = seeded()
    const source = { ...turnRow(1).source } as Record<string, unknown>
    delete source.local_agent_code
    await (await startWork(fake as never, turnRow(1, { source }))).finish({ summary: 'Looked around.', review: { kind: 'review', verb: 'review' } })
    expect(stored(fake)[0].ui_message.metadata.kind).not.toBe(CODE_FINISH_KIND)
  })
})

describe('what the knowledge extraction reads of it', () => {
  it('the person’s message and the finish summary as the exchange, and nothing of the transcript', async () => {
    const fake = seeded()
    await (await startWork(fake as never, turnRow(1))).finish({ summary: 'Fixed the date picker.', review: { kind: 'review', verb: 'review' } })
    await (await startWork(fake as never, turnRow(2))).finish({ summary: 'Added a test for the month.', review: { kind: 'review', verb: 'review' } })
    const finishes = stored(fake)
    const person = (id: string, text: string) => ({ role: 'user', ui_message: { id, role: 'user', parts: [{ type: 'text', text }], metadata: { local_agent_code: { requestId: id } } } })
    const rows = [person('r1', 'The date picker forgets the month'), finishes[0], person('r2', 'Add a test for it'), finishes[1]]
    const { lines, userTurns, exchangeLines } = renderClaimSourceTranscript(rows)
    // The person's words as theirs; the coding agent's as its own fenced, labelled line, never the assistant's.
    expect(lines[0]).toBe('User: The date picker forgets the month')
    expect(lines[1]).toMatch(/^Coding agent report \(written by the person's own coding agent.*<teammate-text>Fixed the date picker\.<\/teammate-text>$/)
    expect(lines[2]).toBe('User: Add a test for it')
    expect(lines[3]).toMatch(/<teammate-text>Added a test for the month\.<\/teammate-text>$/)
    expect(lines.some((l) => l.startsWith('Assistant:'))).toBe(false)
    expect(userTurns).toBe(2)
    expect(exchangeLines).toBe(4)
  })
})

describe('the ledger marks a Code job’s rows', () => {
  const row = (over: Partial<DbSession>): DbSession =>
    ({
      id: SESSION, user_id: 'u1', workspace_id: 'w1', device_id: 'd1', folder_id: 'f1', conversation_id: 'conv-1', tracked_job_id: null,
      current_turn: 1, current_tracked_job_id: null, started_by: 'person', idempotency_key: 'local-agent-code:req-1', request: 'Fix it',
      folder: { label: 'harbor-site' }, device: { name: 'Studio Mac' }, ...over,
    }) as DbSession

  it('a job on the person’s own coding agent is named for it (the Agents panel lists it so)', () => {
    expect(turnTitle('Studio Mac', 'harbor-site', 'Fix the date picker', 'claude-code')).toBe('Claude Code on Studio Mac · harbor-site: Fix the date picker')
    expect(turnTitle('Studio Mac', 'harbor-site', 'Fix the date picker')).toBe('Native Intelligence on Studio Mac · harbor-site: Fix the date picker')
  })

  it('a person’s Code start, and nothing else', () => {
    expect(ledgerSessionOf(row({}))).toMatchObject({ code: true })
    expect(ledgerSessionOf(row({ started_by: 'agent' }))).not.toHaveProperty('code')
    expect(ledgerSessionOf(row({ idempotency_key: 'local-agent:conv-1:session:s:turn:t:call:c' }))).not.toHaveProperty('code')
    expect(isCodeJobRow({ kind: 'local_agent', source: { local_agent_code: true } })).toBe(true)
    expect(isCodeJobRow({ kind: 'work_run', source: { local_agent_code: true } })).toBe(false)
    expect(isCodeJobRow({ kind: 'local_agent', source: {} })).toBe(false)
  })
})
