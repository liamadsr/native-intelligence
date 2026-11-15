/**
 * A loop run's follow-up chat (bots v3 Phase 4) mints its turn's token from
 * the parked run's facts: the fire's subject (a new row's table, a new
 * contact) rides it too, so the chat turn shadows the run's forced reads
 * (skill-run-rebuild.ts). Leaving one off was a real bug the first time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({ tokens: [] as string[] }))
vi.mock('@/lib/flows/run-skill-eve', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/flows/run-skill-eve')>()),
  skillRunnerClient: vi.fn((opts: { runToken: string }) => {
    hoisted.tokens.push(opts.runToken)
    return {} as never
  }),
}))

const { loopRunChatClient } = await import('../run-chat-dispatch')
const { verifyRunToken } = await import('@/lib/flows/skill-run-token')

const CONTACT = '55555555-5555-4555-8555-555555555555'
const TABLE = '33333333-3333-4333-8333-333333333333'

describe('the follow-up chat token', () => {
  let saved: string | undefined
  beforeEach(() => {
    saved = process.env.RUN_SKILL_INTERNAL_SECRET
    process.env.RUN_SKILL_INTERNAL_SECRET = 'test-secret-for-run-tokens'
    hoisted.tokens = []
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.RUN_SKILL_INTERNAL_SECRET
    else process.env.RUN_SKILL_INTERNAL_SECRET = saved
  })

  const record = (extra: Record<string, unknown>) => ({
    workItemId: 'job-1',
    workspaceId: 'ws-1',
    state: { sessionId: 'sess-1', streamIndex: 3, settleStreamIndex: 3 },
    facts: { skillId: 's-1', mode: 'report' as const, hasCapture: false, outputContract: 'prose' as const, model: 'm', runAsUserId: 'u-1', ...extra },
  })

  it("carries the contact a contact fire's run was about, and the table a row fire's was", () => {
    loopRunChatClient('test-secret-for-run-tokens', { record: record({ contactId: CONTACT }), teammateId: 'bot-1' })
    loopRunChatClient('test-secret-for-run-tokens', { record: record({ recordTableId: TABLE }), teammateId: 'bot-1' })
    loopRunChatClient('test-secret-for-run-tokens', { record: record({}), teammateId: 'bot-1' })
    const [contactTurn, rowTurn, plainTurn] = hoisted.tokens.map((t) => verifyRunToken(t))
    expect(contactTurn).toMatchObject({ contactId: CONTACT, chat: { teammateId: 'bot-1' } })
    expect(contactTurn).not.toHaveProperty('recordTableId')
    expect(rowTurn).toMatchObject({ recordTableId: TABLE })
    expect(rowTurn).not.toHaveProperty('contactId')
    expect(plainTurn).not.toHaveProperty('contactId')
    expect(plainTurn).not.toHaveProperty('recordTableId')
  })
})
