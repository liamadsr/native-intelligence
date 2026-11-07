/**
 * conversation/activity → (debounced) → claim/extract-from-source, via the
 * createFunction-capture pattern. Pins the bots v2 fence: a conversation with
 * an AI teammate (chat_conversations.ai_team_member_id, migration 300) is
 * NEVER sent to extraction — this function is the one chokepoint every
 * emitter's event passes — while an ordinary chat of four or more messages is.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createStepMock } from '@/test/inngest-step-mock'
import { makeFakeSupabase } from '@/lib/work/__tests__/fake-supabase'

type Handler = (ctx: { event: { data: Record<string, unknown> }; step: ReturnType<typeof createStepMock> }) => Promise<unknown>

const hoisted = vi.hoisted(() => ({
  handler: null as unknown as Handler,
  db: null as unknown,
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: (config: Record<string, unknown>, fn: Handler) => {
      hoisted.handler = fn
      return { id: config.id }
    },
    send: vi.fn(),
  },
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => hoisted.db }))

import '../conversation-ingest'

function seed(teammate: string | null, messages = 6) {
  const db = makeFakeSupabase()
  db.seed('chat_conversations', [{ id: 'conv-1', workspace_id: 'ws-1', title: 'Q3 plan', ai_team_member_id: teammate }])
  db.seed(
    'chat_messages',
    Array.from({ length: messages }, (_, i) => ({ id: `m${i}`, conversation_id: 'conv-1', workspace_id: 'ws-1' })),
  )
  db.seed('member', [{ id: 'mem-1', user_id: 'user-1', workspace_id: 'ws-1' }])
  hoisted.db = db
}

const event = { data: { workspaceId: 'ws-1', userId: 'user-1', conversationId: 'conv-1' } }

describe('conversationIngest', () => {
  beforeEach(() => vi.clearAllMocks())

  it('an ordinary chat of 4+ messages is sent to extraction', async () => {
    seed(null)
    const step = createStepMock()
    expect(await hoisted.handler({ event, step })).toEqual({ status: 'queued', conversationId: 'conv-1' })
    expect(step.sendEvent).toHaveBeenCalledWith(
      'send-extraction',
      expect.objectContaining({ name: 'claim/extract-from-source', data: expect.objectContaining({ sourceType: 'conversation', sourceId: 'conv-1' }) }),
    )
  })

  it('a teammate thread is skipped — never extracted, however long', async () => {
    seed('tm-1', 40)
    const step = createStepMock()
    expect(await hoisted.handler({ event, step })).toEqual({ status: 'skipped', reason: 'teammate_thread' })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })
})
