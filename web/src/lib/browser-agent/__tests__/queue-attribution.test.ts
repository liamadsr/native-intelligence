import { beforeEach, describe, expect, it, vi } from 'vitest'
import { browserCommandAttribution } from '../attribution'

const mock = vi.hoisted(() => ({ insert: vi.fn(), send: vi.fn(), remove: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => ({
    from: () => ({ insert: (value: unknown) => {
      mock.insert(value)
      return { select: () => ({ single: async () => ({ data: { id: 'command' }, error: null }) }) }
    } }),
    channel: () => ({ send: mock.send }), removeChannel: mock.remove,
  }),
}))
import { enqueueBrowserCommand } from '../queue'

const scope = { conversationId: 'conversation', workspaceId: 'workspace' }
const runtime = { sessionId: 'session', turnId: 'turn_3', callId: 'call_1' }
const attribution = browserCommandAttribution(scope, runtime)!
beforeEach(() => vi.clearAllMocks())

describe('browser command correlation', () => {
  it('records signed tenancy and durable runtime coordinates outside the model request', async () => {
    await enqueueBrowserCommand({ userId: 'user', workspaceId: 'workspace', command: 'run_task', attribution,
      request: { task: { goal: 'Read results' }, attribution: { parent_run_id: 'forged', workspace_id: 'foreign' } } })
    expect(mock.insert).toHaveBeenCalledWith(expect.objectContaining({ user_id: 'user', workspace_id: 'workspace', session_id: 'session',
      request: { task: { goal: 'Read results' }, attribution: { version: 1, source: 'chat_agent', parent_run_id: 'ai_chat:session:turn_3',
        conversation_id: 'conversation', workspace_id: 'workspace', eve_session_id: 'session', eve_turn_id: 'turn_3', eve_call_id: 'call_1' } } }))
  })

  it('strips request-supplied identity and leaves legacy commands unattributed', async () => {
    await enqueueBrowserCommand({ userId: 'user', workspaceId: 'workspace', command: 'run_task',
      request: { task: { goal: 'Read results' }, attribution } })
    expect(mock.insert.mock.calls[0][0]).toMatchObject({ session_id: null, request: { task: { goal: 'Read results' } } })
    expect(mock.insert.mock.calls[0][0].request).not.toHaveProperty('attribution')
  })

  it('does not correlate a mismatched workspace or device surface', async () => {
    await enqueueBrowserCommand({ userId: 'user', workspaceId: 'other', command: 'get_text', attribution })
    expect(mock.insert.mock.calls[0][0].request).not.toHaveProperty('attribution')
    expect(browserCommandAttribution({ ...scope, surface: 'device_ask' }, runtime)).toBeUndefined()
  })

  it('does not guess missing or malformed runtime identities', () => {
    for (const bad of [{}, { ...runtime, sessionId: 'ambiguous:session' }, { ...runtime, turnId: ' ' }, { ...runtime, callId: '' }]) {
      expect(browserCommandAttribution(scope, bad)).toBeUndefined()
    }
  })
})
