/**
 * POST /api/internal/chat/reply — the chat-agent's reply backup. Gates:
 *   - a wrong or missing internal secret → 401, nothing written;
 *   - no / forged run token → 401;
 *   - an EXPIRED token whose HMAC verifies is accepted for
 *     TURN_REPORT_TOKEN_GRACE_MS past its expiry (a turn's last step can
 *     finish after its token does), and refused 401 from then on;
 *   - the token rides its header only (a `?token=` is no token);
 *   - a device-ask or server-principal token → 200 skipped, nothing written;
 *   - a malformed body → 400;
 *   - the happy path writes the reply under the token's tenancy (never the body's).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { chatMessagesFake } from '@/test/chat-messages-fake'

const SECRET = 'test-chat-internal-secret-abcdefghij'

let db = chatMessagesFake([])
vi.mock('@/lib/admin', () => ({ getServiceClient: () => db.client }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async () => undefined) } }))
const signal = vi.fn()
vi.mock('@/lib/chat/idle-compaction-signal', () => ({ signalChatSessionActivity: (...a: unknown[]) => signal(...a) }))

const { POST } = await import('../route')
const { mintChatRunToken, CHAT_RUN_SECRET_HEADER, CHAT_RUN_TOKEN_HEADER, TURN_REPORT_TOKEN_GRACE_MS } = await import('@/lib/chat/chat-run-token')

const body = {
  replyId: 'eve-msg-1',
  sessionId: 'wrun_1',
  turnId: 'turn_5',
  outcome: 'completed',
  events: [{ type: 'message.appended', data: { messageDelta: 'Done.' } }, { type: 'turn.completed' }],
}

function req(opts: { secret?: string | null; token?: string | null; body?: unknown } = {}): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const secret = opts.secret === undefined ? SECRET : opts.secret
  if (secret) headers[CHAT_RUN_SECRET_HEADER] = secret
  const token = opts.token === undefined ? mintChatRunToken({ conversationId: 'conv-1', userId: 'u-1', workspaceId: 'ws-1' }) : opts.token
  if (token) headers[CHAT_RUN_TOKEN_HEADER] = token
  return new Request('http://localhost/api/internal/chat/reply', { method: 'POST', headers, body: JSON.stringify(opts.body ?? body) })
}

describe('POST /api/internal/chat/reply', () => {
  beforeEach(() => {
    process.env.CHAT_INTERNAL_SECRET = SECRET
    db = chatMessagesFake([{ id: 'conv-1', user_id: 'u-1', workspace_id: 'ws-1' }])
    signal.mockClear()
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    delete process.env.CHAT_INTERNAL_SECRET
    vi.restoreAllMocks()
  })

  it('401s a wrong or missing internal secret, and writes nothing', async () => {
    expect((await POST(req({ secret: 'wrong-secret-wrong-secret-wrong' }))).status).toBe(401)
    expect((await POST(req({ secret: null }))).status).toBe(401)
    expect(db.messages).toHaveLength(0)
  })

  it('401s a missing or forged run token', async () => {
    expect((await POST(req({ token: null }))).status).toBe(401)
    expect((await POST(req({ token: 'forged.token' }))).status).toBe(401)
    expect(db.messages).toHaveLength(0)
  })

  it('writes the reply under the token’s tenancy, and restarts the idle-compaction timer', async () => {
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ written: true, replaced: false })
    expect(db.thread()).toEqual([{ role: 'assistant', id: 'eve-msg-1' }])
    expect(db.messages[0]).toMatchObject({ conversation_id: 'conv-1', user_id: 'u-1', workspace_id: 'ws-1' })
    expect(signal).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'conv-1', source: 'turn' }))
  })

  describe('a token past its expiry', () => {
    /** A token, and the time it expires at (exp, as signed). */
    function minted(): { token: string; exp: number } {
      const token = mintChatRunToken({ conversationId: 'conv-1', userId: 'u-1', workspaceId: 'ws-1' })
      const { exp } = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')) as { exp: number }
      return { token, exp }
    }
    afterEach(() => vi.useRealTimers())

    it('is accepted up to the last millisecond of the grace (the turn’s last step ran on)', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      const { token, exp } = minted()
      vi.setSystemTime(exp + 1)
      expect((await POST(req({ token }))).status).toBe(200)
      vi.setSystemTime(exp + TURN_REPORT_TOKEN_GRACE_MS - 1)
      const res = await POST(req({ token, body: { ...body, replyId: 'eve-msg-2' } }))
      expect(res.status).toBe(200)
      expect(db.messages).toHaveLength(2)
    })

    it('is refused 401 once the grace has run out, and writes nothing', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      const { token, exp } = minted()
      vi.setSystemTime(exp + TURN_REPORT_TOKEN_GRACE_MS)
      const res = await POST(req({ token }))
      expect(res.status).toBe(401)
      expect(await res.json()).toMatchObject({ error: 'run token expired too long ago' })
      vi.setSystemTime(exp + 2 * 60 * 60_000)
      expect((await POST(req({ token }))).status).toBe(401)
      expect(db.messages).toHaveLength(0)
    })

    it('is bounded at 30 minutes', () => {
      expect(TURN_REPORT_TOKEN_GRACE_MS).toBe(30 * 60 * 1000)
    })
  })

  it('reads the token from its header only, never ?token=', async () => {
    const token = mintChatRunToken({ conversationId: 'conv-1', userId: 'u-1', workspaceId: 'ws-1' })
    const inQuery = new Request(`http://localhost/api/internal/chat/reply?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CHAT_RUN_SECRET_HEADER]: SECRET },
      body: JSON.stringify(body),
    })
    expect((await POST(inQuery)).status).toBe(401)
    expect(db.messages).toHaveLength(0)
  })

  it('skips a device-ask or server-principal token', async () => {
    const device = mintChatRunToken({ conversationId: 'conv-1', userId: 'u-1', workspaceId: 'ws-1', surface: 'device_ask' })
    const home = mintChatRunToken({ conversationId: 'conv-1', userId: 'u-1', workspaceId: 'ws-1', server: 'home_turn' })
    for (const token of [device, home]) {
      const res = await POST(req({ token }))
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ written: false, skipped: true })
    }
    expect(db.messages).toHaveLength(0)
  })

  it('400s a malformed body', async () => {
    expect((await POST(req({ body: { ...body, events: [{ type: 'step.completed' }] } }))).status).toBe(400)
    expect((await POST(req({ body: { ...body, replyId: '' } }))).status).toBe(400)
    expect(db.messages).toHaveLength(0)
  })
})
