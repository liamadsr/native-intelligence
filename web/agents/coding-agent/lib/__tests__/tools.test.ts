/**
 * Tests for the coding-agent's authored terminal tools (finish_run) and its
 * progress/cancel tool (post_progress).
 *
 * Invariants under test:
 *   - the run token is derived from the SESSION PRINCIPAL, never model input, and
 *     is what gets forwarded to the internal routes;
 *   - finish_run relays the outcome route's result faithfully, including the 409
 *     "already settled" branch and the non-settled error branch;
 *   - post_progress turns a canceling:true response into a hard STOP instruction
 *     for the model.
 *
 * We mock the spec-client so no real fetch happens; the mock also lets us capture
 * exactly which run token each tool forwarded.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolContext } from 'eve/tools'

// runTokenFromAuth stays REAL (it's the derivation under test); the network
// helpers are mocked so we can assert what the tools forward + return. The mock
// fns are hoisted so the vi.mock factory (itself hoisted) can close over them.
const { postOutcome, postEvent } = vi.hoisted(() => ({
  postOutcome: vi.fn(),
  postEvent: vi.fn(),
}))
vi.mock('../spec-client.js', async () => {
  const actual = await vi.importActual<typeof import('../spec-client')>('../spec-client')
  return { ...actual, postOutcome, postEvent }
})

import finishRun from '../../tools/finish_run'
import postProgress from '../../tools/post_progress'

/** Build a ToolContext whose principal carries `runToken` in its attributes. */
function ctxWith(runToken: string | null): ToolContext {
  const current =
    runToken === null
      ? null
      : {
          authenticator: 'agent-run-internal',
          principalId: 'user-1',
          principalType: 'user',
          attributes: { runToken, workspaceId: 'ws-1' },
        }
  return {
    session: { id: 'sess', auth: { current, initiator: current }, turn: {} as never },
  } as unknown as ToolContext
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('finish_run', () => {
  it('forwards the PRINCIPAL run token + full outcome, relays prUrl on success', async () => {
    postOutcome.mockResolvedValue({ settled: true, prUrl: 'https://github.com/o/r/pull/9', message: 'ok' })
    const res = await finishRun.execute!(
      {
        result: 'pr_open',
        summary: 'implemented X',
        pr: { title: 't', body: 'b', head: 'dial8/x', base: 'main' },
      },
      ctxWith('tok-abc'),
    )
    // token came from the principal, and the whole outcome body was forwarded.
    expect(postOutcome).toHaveBeenCalledWith('tok-abc', {
      result: 'pr_open',
      summary: 'implemented X',
      error: undefined,
      pr: { title: 't', body: 'b', head: 'dial8/x', base: 'main' },
    })
    expect(res).toMatchObject({ settled: true, prUrl: 'https://github.com/o/r/pull/9' })
  })

  it('relays the 409 already-settled branch so the model stops', async () => {
    postOutcome.mockResolvedValue({ settled: true, alreadySettled: true, message: 'run already settled', prUrl: null })
    const res = await finishRun.execute!(
      { result: 'completed', summary: 'done' },
      ctxWith('tok-abc'),
    )
    expect(res).toMatchObject({ settled: true, alreadySettled: true })
    expect((res as { message: string }).message).toMatch(/already settled/i)
  })

  it('relays a non-settled failure (route/network) so the model can retry', async () => {
    postOutcome.mockResolvedValue({ settled: false, error: 'route down' })
    const res = await finishRun.execute!(
      { result: 'failed', summary: 's', error: 'could not build' },
      ctxWith('tok-abc'),
    )
    expect(res).toEqual({ settled: false, error: 'route down' })
  })

  it('a reviewer’s changes come back unsettled so the model fixes and calls again (P10 F6)', async () => {
    postOutcome.mockResolvedValue({ settled: false, changesRequested: true, message: 'Re-enable the button on error.' })
    const res = await finishRun.execute!(
      { result: 'pr_open', summary: 's', pr: { title: 't', body: 'b', head: 'dial8/x', base: 'main' } },
      ctxWith('tok-abc'),
    )
    expect(res).toEqual({ settled: false, changesRequested: true, message: 'Re-enable the button on error.' })
  })

  it('a review that stopped the run ends it with the reason', async () => {
    postOutcome.mockResolvedValue({ settled: true, reviewStopped: true, prUrl: null, message: 'No pull request: rejected.' })
    const res = await finishRun.execute!(
      { result: 'pr_open', summary: 's', pr: { title: 't', body: 'b', head: 'dial8/x', base: 'main' } },
      ctxWith('tok-abc'),
    )
    expect(res).toEqual({ settled: true, prUrl: null, message: 'No pull request: rejected.' })
  })

  it('still calls postOutcome with "" when the session has no token (route refuses)', async () => {
    postOutcome.mockResolvedValue({ settled: false, error: 'no run token on this session — outcome refused' })
    const res = await finishRun.execute!(
      { result: 'completed', summary: 's' },
      ctxWith(null),
    )
    expect(postOutcome).toHaveBeenCalledWith('', expect.objectContaining({ result: 'completed' }))
    expect((res as { settled: boolean }).settled).toBe(false)
  })
})

describe('post_progress', () => {
  it('forwards the principal token + text and returns ok when not canceling', async () => {
    postEvent.mockResolvedValue({ canceling: false })
    const res = await postProgress.execute!(
      { text: 'exploring the repo', kind: 'progress' },
      ctxWith('tok-xyz'),
    )
    expect(postEvent).toHaveBeenCalledWith('tok-xyz', 'progress', 'exploring the repo')
    expect(res).toEqual({ canceling: false, ok: true })
  })

  it('returns a hard STOP instruction when the run is canceling', async () => {
    postEvent.mockResolvedValue({ canceling: true })
    const res = await postProgress.execute!(
      { text: 'working', kind: 'progress' },
      ctxWith('tok-xyz'),
    )
    expect((res as { canceling: boolean }).canceling).toBe(true)
    expect((res as { instruction: string }).instruction).toMatch(/STOP/i)
    expect((res as { instruction: string }).instruction).toMatch(/do NOT call finish_run/i)
  })

  it('defaults kind to "progress" via the input schema, then forwards it', async () => {
    postEvent.mockResolvedValue({ canceling: false })
    // eve validates input against inputSchema before calling execute; exercise
    // that same default here so we test production behavior (a bare execute call
    // would skip the schema and forward kind: undefined).
    const schema = postProgress.inputSchema as unknown as {
      parse: (v: unknown) => { text: string; kind: 'log' | 'progress' }
    }
    const parsed = schema.parse({ text: 'x' })
    await postProgress.execute!(parsed, ctxWith('tok-xyz'))
    expect(postEvent).toHaveBeenCalledWith('tok-xyz', 'progress', 'x')
  })
})
