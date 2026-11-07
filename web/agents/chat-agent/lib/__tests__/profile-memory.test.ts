/**
 * The profile memory slot (memory/profile.ts, lib/profile-memory.ts; slice
 * A2a). Pins:
 *   - the scope is the INITIATOR's [userId, workspaceId] (it stays right during
 *     idle compaction): the person's, or the server principal's that creates a
 *     home thread's parked session (its principalId is a verified home-turn
 *     token's user); null with no signed-in person, any other service
 *     principal, no run token (local dev) or a teammate chat (its own memory);
 *   - the provider never throws: a route failure returns the last good result
 *     for the session, else no records; a malformed result counts as a failure;
 *   - a replay of the same operation returns the same result, even when the
 *     route answers differently the second time.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const post = vi.hoisted(() => vi.fn())
vi.mock('../spec-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../spec-client.js')>()),
  postChatMemory: post,
}))

const { profileMemoryScope, recallProfile, resetProfileMemoryCachesForTests, validRecall } = await import('../profile-memory.js')

/** An unsigned token whose payload carries `claims`: the scope only reads the teammate hint. */
const token = (claims: Record<string, unknown> = {}) =>
  `${Buffer.from(JSON.stringify({ conversationId: 'c', workspaceId: 'ws-1', userId: 'user-1', exp: 0, ...claims })).toString('base64url')}.sig`

const principal = (over: Record<string, unknown> = {}, attributes: Record<string, string> = {}) => ({
  authenticator: 'app',
  principalId: 'user-1',
  principalType: 'user',
  attributes: { workspaceId: 'ws-1', chatRunToken: token(), chatRunCtx: '', ...attributes },
  ...over,
})
const scopeCtx = (initiator: unknown, current: unknown = initiator) =>
  ({ session: { id: 's', auth: { initiator, current } } }) as unknown as Parameters<typeof profileMemoryScope>[0]

const records = (tag: string) => ({ messages: [{ id: 'facts', content: `<memory>${tag}</memory>` }, { id: 'facts-delta', content: 'No changes' }] })
const ctx = (operationId: string, sessionId = 'sess-1') =>
  ({
    operationId,
    session: { id: sessionId, auth: { initiator: principal(), current: principal({}, { chatRunToken: 'run-token' }) } },
    memory: { scope: { key: 'k', namespace: 'n', value: ['user-1', 'ws-1'] }, slot: 'profile' },
  }) as unknown as Parameters<typeof recallProfile>[1]

beforeEach(() => {
  post.mockReset()
  resetProfileMemoryCachesForTests()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('profileMemoryScope', () => {
  it("is the initiator's user and workspace, whoever the current caller is", () => {
    expect(profileMemoryScope(scopeCtx(principal()))).toEqual(['user-1', 'ws-1'])
    // Idle compaction: current is the server principal; the initiator still decides.
    expect(profileMemoryScope(scopeCtx(principal(), principal({ principalType: 'service', authenticator: 'server' })))).toEqual(['user-1', 'ws-1'])
  })

  it("a home thread's session, created parked by the server principal, recalls for its person (2026-10-18)", () => {
    // auth.ts serverCreatePrincipal: principalId = the verified home-turn token's userId.
    const server = principal({ principalType: 'service', authenticator: 'server' }, { chatRunToken: token({ server: 'home_turn' }) })
    expect(profileMemoryScope(scopeCtx(server))).toEqual(['user-1', 'ws-1'])
    // The person's own turn in that session: the initiator (the server principal) still decides.
    expect(profileMemoryScope(scopeCtx(server, principal()))).toEqual(['user-1', 'ws-1'])
    // ...and still needs its workspace and run token.
    expect(profileMemoryScope(scopeCtx({ ...server, attributes: { ...server.attributes, workspaceId: '' } }))).toBeNull()
    expect(profileMemoryScope(scopeCtx({ ...server, attributes: { ...server.attributes, chatRunToken: '' } }))).toBeNull()
    expect(profileMemoryScope(scopeCtx({ ...server, principalId: '' }))).toBeNull()
  })

  it('is off with no person, any other service principal, no workspace, no run token, or a teammate chat', () => {
    expect(profileMemoryScope(scopeCtx(null))).toBeNull()
    expect(profileMemoryScope(scopeCtx(undefined))).toBeNull()
    // A service principal from any authenticator but the server's.
    expect(profileMemoryScope(scopeCtx(principal({ principalType: 'service' })))).toBeNull()
    expect(profileMemoryScope(scopeCtx(principal({ principalType: 'service', authenticator: 'device' })))).toBeNull()
    expect(profileMemoryScope(scopeCtx(principal({ principalType: 'service', authenticator: undefined })))).toBeNull()
    // The server authenticator with a principal type other than service or user.
    expect(profileMemoryScope(scopeCtx(principal({ principalType: 'agent', authenticator: 'server' })))).toBeNull()
    expect(profileMemoryScope(scopeCtx({ principalType: 'user', authenticator: 'app', principalId: 'user-1' }))).toBeNull()
    expect(profileMemoryScope(scopeCtx(principal({}, { workspaceId: '' })))).toBeNull()
    expect(profileMemoryScope(scopeCtx(principal({}, { chatRunToken: '' })))).toBeNull()
    expect(profileMemoryScope(scopeCtx(principal({}, { chatRunToken: token({ teammateId: 'tm-1' }) })))).toBeNull()
  })

  it('a device ask recalls like the main chat', () => {
    expect(profileMemoryScope(scopeCtx(principal({ authenticator: 'device' }, { chatRunToken: token({ surface: 'device_ask' }) })))).toEqual(['user-1', 'ws-1'])
  })
})

describe('recallProfile', () => {
  it("posts the operation with the current run token and eve's locked scope, and returns the records", async () => {
    post.mockResolvedValueOnce(records('a'))
    expect(await recallProfile('turn.started', ctx('op-1'))).toEqual(records('a'))
    expect(post).toHaveBeenCalledWith('run-token', {
      op: 'recall',
      phase: 'turn.started',
      operationId: 'op-1',
      sessionId: 'sess-1',
      scope: ['user-1', 'ws-1'],
    })
  })

  it('never throws: a failure returns the last good result for the session, else nothing', async () => {
    post.mockRejectedValueOnce(new Error('network'))
    expect(await recallProfile('turn.started', ctx('op-1'))).toEqual({ messages: [] })
    post.mockResolvedValueOnce(records('good'))
    await recallProfile('turn.started', ctx('op-2'))
    post.mockRejectedValueOnce(new Error('500'))
    expect(await recallProfile('compaction.completed', ctx('op-3'))).toEqual(records('good'))
    // Another session never sees this one's cache.
    post.mockRejectedValueOnce(new Error('500'))
    expect(await recallProfile('turn.started', ctx('op-4', 'sess-2'))).toEqual({ messages: [] })
  })

  it('treats a malformed result as a failure', async () => {
    post.mockResolvedValueOnce({ messages: [{ id: 'facts', content: '   ' }] })
    expect(await recallProfile('turn.started', ctx('op-1'))).toEqual({ messages: [] })
    expect(validRecall({ messages: [{ id: 'a', content: 'x' }, { id: 'a', content: 'y' }] })).toBeNull()
    expect(validRecall({ messages: [{ id: 'a', content: 'x' }] })).toEqual({ messages: [{ id: 'a', content: 'x' }] })
  })

  it('a replay of the same operation returns the same result without asking again', async () => {
    post.mockRejectedValueOnce(new Error('network'))
    const first = await recallProfile('turn.started', ctx('op-1'))
    const calls = post.mock.calls.length
    post.mockResolvedValueOnce(records('later'))
    expect(await recallProfile('turn.started', ctx('op-1'))).toEqual(first)
    expect(post).toHaveBeenCalledTimes(calls)
  })

  describe('pinning a fallback (A2a review: a replay must get the same bytes)', () => {
    const pinCall = () => post.mock.calls.find((c) => (c[1] as { op?: string }).op === 'pin')

    it('a timeout where the app still stored its result: the stored result wins the pin and is returned', async () => {
      post.mockResolvedValueOnce(records('earlier'))
      await recallProfile('turn.started', ctx('op-0'))
      post.mockRejectedValueOnce(new Error('The operation was aborted due to timeout'))
      post.mockResolvedValueOnce(records('stored-at-app'))
      expect(await recallProfile('turn.started', ctx('op-1'))).toEqual(records('stored-at-app'))
      expect(pinCall()?.[1]).toEqual({
        op: 'pin',
        phase: 'turn.started',
        operationId: 'op-1',
        sessionId: 'sess-1',
        scope: ['user-1', 'ws-1'],
        result: records('earlier'),
      })
    })

    it('a 500 that stored nothing: the fallback is pinned and returned', async () => {
      post.mockRejectedValueOnce(new Error('memory route answered 500'))
      post.mockImplementationOnce(async (_token: string, body: { result: unknown }) => body.result)
      expect(await recallProfile('turn.started', ctx('op-1'))).toEqual({ messages: [] })
      expect(pinCall()?.[1]).toMatchObject({ op: 'pin', operationId: 'op-1', result: { messages: [] } })
    })

    it('an unreachable app keeps the fallback (never throws)', async () => {
      post.mockRejectedValueOnce(new Error('network'))
      post.mockRejectedValueOnce(new Error('network'))
      await expect(recallProfile('turn.started', ctx('op-1'))).resolves.toEqual({ messages: [] })
    })
  })
})

describe('the profile slot (memory/profile.ts)', () => {
  it('recalls at turn start and after compaction, captures before compaction, offers no tools, scoped by the initiator', async () => {
    const slot = (await import('../../memory/profile.js')).default as unknown as {
      namespace: string
      scope: (c: unknown) => unknown
      provider: { recall: Record<string, unknown>; capture?: Record<string, unknown>; tools?: unknown }
    }
    expect(Object.keys(slot.provider.recall).sort()).toEqual(['compaction.completed', 'turn.started'])
    expect(slot.provider.tools).toBeUndefined()
    expect(Object.keys(slot.provider.capture ?? {})).toEqual(['compaction.requested'])
    const capture = slot.provider.capture!['compaction.requested'] as (c: unknown) => Promise<unknown>
    post.mockRejectedValueOnce(new Error('down'))
    await expect(capture({ ...ctx('op-cap'), messages: [{ role: 'user', kind: 'user', content: 'Keep it short' }], turn: null })).resolves.toBeUndefined()
    expect(slot.namespace).toBe('dial8-profile-facts-v1')
    expect(slot.scope(scopeCtx(principal()))).toEqual(['user-1', 'ws-1'])
    post.mockRejectedValueOnce(new Error('down'))
    const recall = slot.provider.recall['turn.started'] as (c: unknown) => Promise<unknown>
    await expect(recall(ctx('op-slot'))).resolves.toEqual({ messages: [] })
  })
})
