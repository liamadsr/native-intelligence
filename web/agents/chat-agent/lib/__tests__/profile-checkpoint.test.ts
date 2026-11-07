/**
 * The checkpoint post at recall['compaction.completed'] (A3 re-priming).
 * Pins:
 *   - checkpointText reads eve's checkpoint shape: the assistant summary right
 *     after the last `context.compaction` marker, text parts only, capped to
 *     the app's limit (the twin constant matches);
 *   - recallAfterCompaction posts { op: 'checkpoint', text } beside the recall
 *     and returns EXACTLY the recall's bytes, with or without a checkpoint,
 *     and whether the post succeeds or fails (replay determinism);
 *   - a failing post never throws and never changes the recall.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HOME_CHECKPOINT_MAX_CHARS } from '@/lib/chat/home-thread'

const post = vi.hoisted(() => vi.fn())
vi.mock('../spec-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../spec-client.js')>()),
  postChatMemory: post,
}))

const { CHECKPOINT_MAX_CHARS, checkpointText, recallAfterCompaction, recallProfile, resetProfileMemoryCachesForTests } = await import('../profile-memory.js')

const principal = (attributes: Record<string, string> = {}) => ({
  authenticator: 'app',
  principalId: 'user-1',
  principalType: 'user',
  attributes: { workspaceId: 'ws-1', chatRunToken: 'run-token', chatRunCtx: '', ...attributes },
})
const marker = { role: 'user', kind: 'context.compaction', content: 'Summary of our conversation so far:' }
const summary = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] })
const ctx = (operationId: string, messages: unknown[]) =>
  ({
    operationId,
    messages,
    session: { id: 'sess-1', auth: { initiator: principal(), current: principal() } },
    memory: { scope: { key: 'k', namespace: 'n', value: ['user-1', 'ws-1'] }, slot: 'profile' },
  }) as unknown as Parameters<typeof recallAfterCompaction>[0]

const RECALL = { messages: [{ id: 'facts', content: '<memory kind="profile">a</memory>' }] }

beforeEach(() => {
  post.mockReset()
  resetProfileMemoryCachesForTests()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('checkpointText', () => {
  it('is the assistant summary after the last compaction marker', () => {
    expect(checkpointText([marker, summary('old'), { role: 'user', kind: 'user', content: 'hi' }, marker, summary('  new one  ')])).toBe('new one')
  })

  it('is null with no marker, no summary after it, or a blank one', () => {
    expect(checkpointText([{ role: 'user', kind: 'user', content: 'hi' }])).toBeNull()
    expect(checkpointText([marker, { role: 'user', kind: 'user', content: 'x' }])).toBeNull()
    expect(checkpointText([marker, summary('   ')])).toBeNull()
    expect(checkpointText(null as never)).toBeNull()
  })

  it('caps to the app’s limit, and the twin constants agree', () => {
    expect(CHECKPOINT_MAX_CHARS).toBe(HOME_CHECKPOINT_MAX_CHARS)
    expect(checkpointText([marker, summary('y'.repeat(CHECKPOINT_MAX_CHARS + 100))])!.length).toBe(CHECKPOINT_MAX_CHARS)
  })
})

describe('recallAfterCompaction', () => {
  it('posts the checkpoint beside the recall, and returns the recall’s bytes unchanged', async () => {
    post.mockImplementation(async (_t: string, body: { op: string }) => (body.op === 'recall' ? RECALL : { stored: true }))
    const out = await recallAfterCompaction(ctx('op-1', [marker, summary('We planned the renewal.')]))
    expect(out).toEqual(RECALL)
    const checkpoint = post.mock.calls.find((c) => c[1].op === 'checkpoint')!
    expect(checkpoint[0]).toBe('run-token')
    expect(checkpoint[1]).toEqual({
      op: 'checkpoint',
      phase: 'compaction.completed',
      operationId: 'op-1',
      sessionId: 'sess-1',
      scope: ['user-1', 'ws-1'],
      text: 'We planned the renewal.',
    })
  })

  it('returns the same bytes as the plain recall, with or without a checkpoint and whatever the post does', async () => {
    post.mockImplementation(async (_t: string, body: { op: string }) => (body.op === 'recall' ? RECALL : { stored: true }))
    const plain = await recallProfile('compaction.completed', ctx('op-plain', []))
    resetProfileMemoryCachesForTests()
    const withCheckpoint = await recallAfterCompaction(ctx('op-a', [marker, summary('S')]))
    resetProfileMemoryCachesForTests()
    post.mockImplementation(async (_t: string, body: { op: string }) => {
      if (body.op === 'checkpoint') throw new Error('route down')
      return RECALL
    })
    const postFailed = await recallAfterCompaction(ctx('op-b', [marker, summary('S')]))
    expect(JSON.stringify(withCheckpoint)).toBe(JSON.stringify(plain))
    expect(JSON.stringify(postFailed)).toBe(JSON.stringify(plain))
  })

  it('posts nothing when there is no checkpoint in the history', async () => {
    post.mockResolvedValue(RECALL)
    await recallAfterCompaction(ctx('op-1', [{ role: 'user', kind: 'user', content: 'hi' }]))
    expect(post.mock.calls.map((c) => c[1].op)).toEqual(['recall'])
  })
})
