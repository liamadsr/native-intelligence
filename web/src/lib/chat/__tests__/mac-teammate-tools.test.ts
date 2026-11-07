/**
 * The Mac body's teammate tools (teammate plan C4), as C1's tool route runs
 * them: runMacTeammateTool over the in-memory service client, and what C1's
 * spec advertises for them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ledger = vi.hoisted(() => ({
  moveTurn: vi.fn(async (_svc: unknown, s: unknown, _move?: unknown) => s),
  startTurnRow: vi.fn(async () => 'job-1'),
  nextTurn: vi.fn(async (_svc: unknown, s: unknown) => s),
  turnStatus: vi.fn(async (): Promise<string | null> => 'running'),
}))
vi.mock('@/lib/local-agent/ledger', async (orig) => ({ ...(await orig<typeof import('@/lib/local-agent/ledger')>()), ...ledger }))

import {
  MAC_TEAMMATE_TOOL_NAMES,
  isMacTeammateTool,
  macTeammateKey,
  macTeammateToolEntries,
  runMacTeammateTool,
} from '../local-agent-tools'
import { createSession } from '@/lib/local-agent/store'
import { CONV, FOLDER, USER, WS, seeded, type FakeDb } from '@/lib/local-agent/__tests__/fake-db'

const launch = { callId: 'call-1', turnId: 'turn-1', sessionId: 'wrun_mac1' }

let db: FakeDb
let sid: string
const ctx = () => ({ userId: USER, workspaceId: WS, sessionId: sid })
const events = () => (db.tables.local_agent_event ?? []).filter((e) => e.session_id === sid)

beforeEach(async () => {
  for (const f of Object.values(ledger)) f.mockClear()
  db = seeded()
  const { session } = await createSession(db as never, { userId: USER, workspaceId: WS, folderId: FOLDER, conversationId: CONV, request: 'Fix it', mode: 'edit', startedBy: 'agent' })
  sid = session.id
  Object.assign(db.tables.local_agent_session.find((s) => s.id === sid)!, { status: 'running', run_id: 'r', lease_expires_at: new Date(Date.now() + 60_000).toISOString() })
})

describe('runMacTeammateTool', () => {
  it('message_teammate: sent, with the note to end the turn; its question is in the thread', async () => {
    const out = await runMacTeammateTool(db as never, ctx(), 'message_teammate', { text: 'Which repository holds the API?' }, launch)
    expect(out.status).toBe(200)
    const output = (out.body as { output: Record<string, unknown> }).output
    expect(output.status).toBe('sent')
    expect(output.note).toContain('end your turn now')
    expect(events()).toEqual([expect.objectContaining({ kind: 'ask', payload: expect.objectContaining({ via: 'message_teammate', key: macTeammateKey('message_teammate', launch) }) })])
  })

  it('report_to_person: shown, in its own thread', async () => {
    const out = await runMacTeammateTool(db as never, ctx(), 'report_to_person', { text: 'Reading the auth tests.' }, launch)
    expect(out).toEqual({ status: 200, body: { output: { status: 'shown', note: 'The person sees it in your thread. Carry on.' } } })
    expect(events()).toEqual([expect.objectContaining({ kind: 'report', payload: expect.objectContaining({ text: 'Reading the auth tests.', via: 'report_to_person' }) })])
  })

  it('a retried call (same eve ids) acts once; a new call acts again', async () => {
    await runMacTeammateTool(db as never, ctx(), 'report_to_person', { text: 'One.' }, launch)
    await runMacTeammateTool(db as never, ctx(), 'report_to_person', { text: 'One.' }, launch)
    expect(events()).toHaveLength(1)
    await runMacTeammateTool(db as never, ctx(), 'report_to_person', { text: 'Two.' }, { ...launch, callId: 'call-2' })
    expect(events()).toHaveLength(2)
  })

  it('400s a tool that isn’t one, missing eve ids and bad input', async () => {
    expect(await runMacTeammateTool(db as never, ctx(), 'send_email', {}, launch)).toMatchObject({ status: 400, body: { code: 'INPUT_INVALID' } })
    expect(await runMacTeammateTool(db as never, ctx(), 'report_to_person', { text: 'x' }, { ...launch, callId: undefined })).toMatchObject({ status: 400, body: { error: 'missing durable callId' } })
    expect(await runMacTeammateTool(db as never, ctx(), 'report_to_person', { text: 'x' }, { ...launch, turnId: 'a:b' })).toMatchObject({ status: 400, body: { error: 'missing durable turnId' } })
    expect(await runMacTeammateTool(db as never, ctx(), 'report_to_person', { text: 'x' }, { ...launch, sessionId: '' })).toMatchObject({ status: 400, body: { error: 'missing durable sessionId' } })
    const bad = await runMacTeammateTool(db as never, ctx(), 'message_teammate', { text: 'x'.repeat(4001) }, launch)
    expect(bad).toMatchObject({ status: 400, body: { code: 'INPUT_INVALID', details: expect.anything() } })
    expect(await runMacTeammateTool(db as never, ctx(), 'message_teammate', {}, launch)).toMatchObject({ status: 400 })
    expect(events()).toEqual([])
  })

  it('past the hourly cap, message_teammate is a refusal the model reads', async () => {
    for (let i = 0; i < 6; i++) await runMacTeammateTool(db as never, ctx(), 'message_teammate', { text: `Q${i}?` }, { ...launch, callId: `c${i}` })
    const out = await runMacTeammateTool(db as never, ctx(), 'message_teammate', { text: 'Q7?' }, { ...launch, callId: 'c7' })
    expect((out.body as { output: Record<string, unknown> }).output).toMatchObject({ status: 'refused', code: 'TEAMMATE_CAP' })
    expect((out.body as { output: { reason: string } }).output.reason).toContain('Carry on with what you have')
  })

  it('a session that ended or isn’t this token’s is a refusal the model reads', async () => {
    const foreign = await runMacTeammateTool(db as never, { ...ctx(), workspaceId: '00000000-0000-4000-8000-000000000000' }, 'report_to_person', { text: 'x' }, launch)
    expect((foreign.body as { output: Record<string, unknown> }).output).toMatchObject({ status: 'refused', code: 'NOT_FOUND' })
    db.tables.local_agent_session.find((s) => s.id === sid)!.status = 'cancelled'
    const ended = await runMacTeammateTool(db as never, ctx(), 'message_teammate', { text: 'x' }, launch)
    expect((ended.body as { output: Record<string, unknown> }).output).toMatchObject({ status: 'refused', code: 'ENDED' })
    expect(events()).toEqual([])
  })
})

describe('what C1’s spec advertises', () => {
  it('two tools, with a text input of at most 4000 characters', () => {
    expect(MAC_TEAMMATE_TOOL_NAMES).toEqual(['message_teammate', 'report_to_person'])
    expect(isMacTeammateTool('message_teammate')).toBe(true)
    expect(isMacTeammateTool('report')).toBe(false)
    expect(isMacTeammateTool(undefined)).toBe(false)
    const entries = macTeammateToolEntries()
    expect(entries.map((e) => e.name)).toEqual(['message_teammate', 'report_to_person'])
    for (const e of entries) {
      expect(e.description.length).toBeGreaterThan(40)
      expect(e.inputSchema).toMatchObject({ type: 'object', properties: { text: { type: 'string', maxLength: 4000 } }, required: ['text'] })
    }
    expect(entries[0].description).toContain('end your turn')
    expect(entries[1].description).toContain('does not end your turn')
  })
})
