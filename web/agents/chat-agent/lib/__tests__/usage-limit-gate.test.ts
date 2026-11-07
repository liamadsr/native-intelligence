import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChatSpecFetchResult } from '../spec-client'

/**
 * The usage-limit gate is the eve chat-agent's ONLY hard billing block. On
 * `turn.started` it fetches the spec and, on a real billing block, CANCELS the
 * turn with `ctx.cancel()` (eve 0.68+ logs and ignores a hook throw, so a throw
 * no longer stops anything), while returning (soft-degrade) on any transient
 * outage.
 *
 * Invariants pinned here (mirrors the persona-turn-fresh harness: mock the
 * spec-client at the module boundary, invoke the hook handler directly; the
 * helpers below return the logged stop reason when the hook cancelled, else null):
 *   1. cancels with the usage-limit copy on 429 (reason + reset date folded in)
 *   2. cancels with the fail-closed copy on 503 BILLING_UNAVAILABLE
 *   3. does NOT cancel on 200 (ok), 401, 500, a plain 503 (no BILLING_UNAVAILABLE
 *      code), a network error, or a missing run token — the turn proceeds and the
 *      existing resolver soft paths degrade it.
 *   4. never throws (a throw would be ignored by eve and let the turn run).
 */

const fetchChatSpecResult = vi.fn<(t: string, c: string) => Promise<ChatSpecFetchResult>>()
type ProbeResult = { ok: true } | { ok: false; status: number; body: unknown } | { ok: false; status: 'network' | 'no-token' }
const probeChatRunLive = vi.fn<(t: string) => Promise<ProbeResult>>()
// Default: a run token is present (so the gate actually fetches). Individual
// "missing token" test overrides this.
const runTokenFromAuth = vi.fn(() => 'tok.sig')
const turnCtxFromAuth = vi.fn(() => 'ENC_CTX')

// The REAL surfaceFromRunToken / SURFACE_RUN_ENDED (pure) — only the network
// calls are mocked, so the unverified surface decode is exercised for real.
vi.mock('../spec-client', async (importOriginal) => {
  const real = await importOriginal<typeof import('../spec-client')>()
  return {
    fetchChatSpecResult: (...a: [string, string]) => fetchChatSpecResult(...a),
    probeChatRunLive: (t: string) => probeChatRunLive(t),
    runTokenFromAuth: () => runTokenFromAuth(),
    turnCtxFromAuth: () => turnCtxFromAuth(),
    surfaceFromRunToken: real.surfaceFromRunToken,
    SURFACE_RUN_ENDED: real.SURFACE_RUN_ENDED,
  }
})

/** A token-shaped string with the given payload (signature irrelevant here). */
function tokenWith(payload: Record<string, unknown>): string {
  return `${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}.sig`
}
const DEVICE_TOKEN = tokenWith({ conversationId: 'c', workspaceId: 'w', userId: 'u', surface: 'device_ask', exp: 1 })
const BROWSER_TOKEN = tokenWith({ conversationId: 'c', workspaceId: 'w', userId: 'u', exp: 1 })
const ENDED = { ok: false as const, status: 403, body: { error: 'this run has ended', code: 'SURFACE_RUN_ENDED' } }

// NOTE: this test lives in lib/__tests__/ (NOT hooks/__tests__/) on purpose —
// eve's hook auto-discovery scans EVERY path segment under hooks/ as a hook
// name and rejects "__tests__" at dev boot (Discovery failed → child exits 1).
// The hooks/ directory is discovery-owned: hook source files ONLY.
import gate, {
  buildUsageLimitMessage,
  isRunEnded,
  RUN_ENDED_MESSAGE,
  DEVICE_ASK_MAX_STEPS,
  STEP_CAP_MESSAGE,
} from '../../hooks/usage-limit-gate'
import { DEVICE_ASK_MAX_STEPS as SERVER_DEVICE_ASK_MAX_STEPS } from '@/lib/chat/device-ask-eve'

type GateCtx = { session: { auth: unknown; id: string }; cancel: () => void }
type Handler = (e: unknown, ctx: GateCtx) => Promise<void>
type Hook = { events: Record<string, Handler> }
const hook = gate as unknown as Hook
const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

/** Run one handler; the stop reason it logged when it cancelled the turn, else null. Never a throw. */
async function run(event: 'turn.started' | 'step.started', payload: unknown = {}): Promise<string | null> {
  const cancel = vi.fn()
  warn.mockClear()
  await hook.events[event](payload, { session: { auth: {}, id: 'sess-1' }, cancel })
  if (cancel.mock.calls.length === 0) return null
  expect(cancel).toHaveBeenCalledTimes(1)
  const [message, detail] = warn.mock.calls.at(-1) as [string, { reason: string; sessionId: string }]
  expect(message).toBe('[chat-agent] usage-limit-gate: cancelling the turn')
  expect(detail.sessionId).toBe('sess-1')
  return detail.reason
}
function invoke() {
  return run('turn.started')
}
function invokeStep(payload: unknown = {}) {
  return run('step.started', payload)
}

beforeEach(() => {
  vi.clearAllMocks()
  runTokenFromAuth.mockReturnValue('tok.sig')
})

describe('usage-limit-gate hook — wiring', () => {
  it('subscribes to turn.started (fires before the soft-degrading resolvers) and step.started (the surface-run liveness stop)', () => {
    expect(Object.keys(hook.events)).toEqual(['turn.started', 'step.started'])
  })
})

describe('usage-limit-gate hook — HARD-FAIL cases', () => {
  it('throws on 429 with the usage-limit copy (reason + reset date folded in)', async () => {
    fetchChatSpecResult.mockResolvedValue({
      ok: false,
      status: 429,
      body: {
        error: 'Usage limit exceeded',
        reason: 'monthly allowance reached',
        usageResetDate: '2026-08-01',
      },
    })
    expect(await invoke()).toBe('Usage limit exceeded: monthly allowance reached. Resets 2026-08-01.')
  })

  it('throws a bare usage-limit message when the 429 body has no reason/date', async () => {
    fetchChatSpecResult.mockResolvedValue({
      ok: false,
      status: 429,
      body: { error: 'Usage limit exceeded' },
    })
    expect(await invoke()).toBe('Usage limit exceeded.')
  })

  it('throws even when the 429 body is null (uses the default headline)', async () => {
    fetchChatSpecResult.mockResolvedValue({ ok: false, status: 429, body: null })
    expect(await invoke()).toBe('Usage limit exceeded.')
  })

  it('throws the fail-closed copy on 503 BILLING_UNAVAILABLE', async () => {
    fetchChatSpecResult.mockResolvedValue({
      ok: false,
      status: 503,
      body: { error: 'Usage check unavailable', code: 'BILLING_UNAVAILABLE' },
    })
    expect(await invoke()).toBe('Usage check unavailable — please try again in a moment.')
  })

  it('a billing block cancels the turn and never throws (eve 0.68+ ignores a hook throw)', async () => {
    fetchChatSpecResult.mockResolvedValue({ ok: false, status: 429, body: { error: 'Usage limit exceeded' } })
    await expect(run('turn.started')).resolves.toBe('Usage limit exceeded.')
    fetchChatSpecResult.mockResolvedValue({ ok: false, status: 503, body: { code: 'BILLING_UNAVAILABLE' } })
    await expect(run('turn.started')).resolves.toBe('Usage check unavailable — please try again in a moment.')
  })
})

describe('usage-limit-gate hook — SOFT-DEGRADE cases (must NOT throw)', () => {
  it('does NOT throw on a 200 (spec ok)', async () => {
    fetchChatSpecResult.mockResolvedValue({
      ok: true,
      spec: {
        systemPrompt: 'p',
        model: 'm',
        ceiling: null,
        ceilingTools: [],
        coreToolNames: [],
      },
    })
    expect(await invoke()).toBeNull()
  })

  it('does NOT throw on 401 (transient auth blip → resolvers degrade)', async () => {
    fetchChatSpecResult.mockResolvedValue({ ok: false, status: 401, body: { error: 'unauthorized' } })
    expect(await invoke()).toBeNull()
  })

  it('does NOT throw on 500 (spec rebuild failure → resolvers degrade)', async () => {
    fetchChatSpecResult.mockResolvedValue({
      ok: false,
      status: 500,
      body: { error: 'boom', code: 'CHAT_SPEC_REBUILD_FAILED' },
    })
    expect(await invoke()).toBeNull()
  })

  it('does NOT throw on a plain 503 without the BILLING_UNAVAILABLE code', async () => {
    fetchChatSpecResult.mockResolvedValue({ ok: false, status: 503, body: { error: 'gateway down' } })
    expect(await invoke()).toBeNull()
  })

  it('does NOT throw on a 503 whose body is null', async () => {
    fetchChatSpecResult.mockResolvedValue({ ok: false, status: 503, body: null })
    expect(await invoke()).toBeNull()
  })

  it('does NOT throw on a network error', async () => {
    fetchChatSpecResult.mockResolvedValue({ ok: false, status: 'network' })
    expect(await invoke()).toBeNull()
  })

  it('does NOT fetch or throw when there is no run token', async () => {
    runTokenFromAuth.mockReturnValue('')
    expect(await invoke()).toBeNull()
    expect(fetchChatSpecResult).not.toHaveBeenCalled()
  })
})

describe('buildUsageLimitMessage — end-user copy (lands verbatim in the chat toast)', () => {
  it('folds reason and reset date into clean prose', () => {
    expect(
      buildUsageLimitMessage({
        error: 'Usage limit exceeded',
        reason: 'monthly allowance reached',
        usageResetDate: '2026-08-01',
      }),
    ).toBe('Usage limit exceeded: monthly allowance reached. Resets 2026-08-01.')
  })

  it('omits the reset note when no date is present', () => {
    expect(
      buildUsageLimitMessage({ error: 'Usage limit exceeded', reason: 'credits exhausted' }),
    ).toBe('Usage limit exceeded: credits exhausted.')
  })

  it('falls back to a default headline when error is absent', () => {
    expect(buildUsageLimitMessage({})).toBe('Usage limit exceeded.')
  })

  it('never emits raw JSON — headline only when reason/date missing', () => {
    const msg = buildUsageLimitMessage({ error: 'Usage limit exceeded' })
    expect(msg).toBe('Usage limit exceeded.')
    expect(msg).not.toContain('{')
  })
})

describe('usage-limit-gate hook — a SURFACE run that has ended is stopped, not soft-degraded', () => {
  it('turn.started: 403 SURFACE_RUN_ENDED cancels the turn (a late-created device session never reaches the fallback model)', async () => {
    runTokenFromAuth.mockReturnValue(DEVICE_TOKEN)
    fetchChatSpecResult.mockResolvedValue(ENDED)
    expect(await invoke()).toBe(RUN_ENDED_MESSAGE)
  })

  it('turn.started: a 401 on a SURFACE token (its short exp passed) cancels; on a browser token it stays soft', async () => {
    fetchChatSpecResult.mockResolvedValue({ ok: false, status: 401, body: { error: 'invalid or expired run token' } })
    runTokenFromAuth.mockReturnValue(DEVICE_TOKEN)
    expect(await invoke()).toBe(RUN_ENDED_MESSAGE)
    runTokenFromAuth.mockReturnValue(BROWSER_TOKEN)
    expect(await invoke()).toBeNull()
  })

  it('turn.started: a 403 with another code, or a 500, on a surface token still soft-degrades', async () => {
    runTokenFromAuth.mockReturnValue(DEVICE_TOKEN)
    fetchChatSpecResult.mockResolvedValue({ ok: false, status: 403, body: { code: 'SOMETHING_ELSE' } })
    expect(await invoke()).toBeNull()
    fetchChatSpecResult.mockResolvedValue({ ok: false, status: 500, body: null })
    expect(await invoke()).toBeNull()
  })

  it('step.started: a surface run is probed before every model step, and SURFACE_RUN_ENDED cancels (a failed cancel stops at its next model call)', async () => {
    runTokenFromAuth.mockReturnValue(DEVICE_TOKEN)
    probeChatRunLive.mockResolvedValueOnce({ ok: true })
    expect(await invokeStep()).toBeNull()
    expect(probeChatRunLive).toHaveBeenCalledWith(DEVICE_TOKEN)

    probeChatRunLive.mockResolvedValueOnce(ENDED)
    expect(await invokeStep()).toBe(RUN_ENDED_MESSAGE)

    probeChatRunLive.mockResolvedValueOnce({ ok: false, status: 401, body: null })
    expect(await invokeStep()).toBe(RUN_ENDED_MESSAGE)
    // The step gate never pays for a spec rebuild.
    expect(fetchChatSpecResult).not.toHaveBeenCalled()
  })

  it('step.started: a transient probe failure (network / 500) stays soft', async () => {
    runTokenFromAuth.mockReturnValue(DEVICE_TOKEN)
    probeChatRunLive.mockResolvedValueOnce({ ok: false, status: 'network' })
    expect(await invokeStep()).toBeNull()
    probeChatRunLive.mockResolvedValueOnce({ ok: false, status: 500, body: null })
    expect(await invokeStep()).toBeNull()
  })

  // What the internal routes answer when the ownership-row LOOKUP itself fails
  // (surface-run-guard.ts): a DB blip is not a deleted row.
  const UNVERIFIED = { ok: false as const, status: 503, body: { error: 'could not verify this run is still live', code: 'SURFACE_RUN_UNVERIFIED' } }

  it('a DB blip on the liveness lookup (503 SURFACE_RUN_UNVERIFIED) is SOFT at turn.started and step.started — the ask is not killed', async () => {
    runTokenFromAuth.mockReturnValue(DEVICE_TOKEN)
    fetchChatSpecResult.mockResolvedValue(UNVERIFIED)
    expect(await invoke()).toBeNull()
    probeChatRunLive.mockResolvedValueOnce(UNVERIFIED)
    expect(await invokeStep()).toBeNull()
    expect(isRunEnded(UNVERIFIED, 'device_ask')).toBe(false)
  })

  it('…while the genuinely ended run (403 SURFACE_RUN_ENDED) is still stopped on the same token', async () => {
    runTokenFromAuth.mockReturnValue(DEVICE_TOKEN)
    fetchChatSpecResult.mockResolvedValue(ENDED)
    expect(await invoke()).toBe(RUN_ENDED_MESSAGE)
    probeChatRunLive.mockResolvedValueOnce(ENDED)
    expect(await invokeStep()).toBe(RUN_ENDED_MESSAGE)
  })

  it('step.started: a browser token (no surface) or no token never probes', async () => {
    runTokenFromAuth.mockReturnValue(BROWSER_TOKEN)
    expect(await invokeStep()).toBeNull()
    runTokenFromAuth.mockReturnValue('tok.sig') // malformed payload → no surface
    expect(await invokeStep()).toBeNull()
    runTokenFromAuth.mockReturnValue('')
    expect(await invokeStep()).toBeNull()
    expect(probeChatRunLive).not.toHaveBeenCalled()
  })
})

describe('usage-limit-gate hook — the device ask step cap stops the 13th model call', () => {
  const stepEvent = (stepIndex: number) => ({ type: 'step.started', data: { stepIndex, modelId: 'm', sequence: 1, turnId: 't' } })

  it('matches the server read cap (main: stopWhen isStepCount(12))', () => {
    expect(DEVICE_ASK_MAX_STEPS).toBe(SERVER_DEVICE_ASK_MAX_STEPS)
    expect(DEVICE_ASK_MAX_STEPS).toBe(12)
  })

  it('steps 1-12 (stepIndex 0-11) run; the 13th (stepIndex 12) is cancelled before any model call', async () => {
    runTokenFromAuth.mockReturnValue(DEVICE_TOKEN)
    probeChatRunLive.mockResolvedValue({ ok: true })
    for (let i = 0; i < DEVICE_ASK_MAX_STEPS; i++) {
      expect(await invokeStep(stepEvent(i))).toBeNull()
    }
    probeChatRunLive.mockClear()
    expect(await invokeStep(stepEvent(12))).toBe(STEP_CAP_MESSAGE)
    // Decided locally: no liveness fetch for the capped step.
    expect(probeChatRunLive).not.toHaveBeenCalled()
  })

  it('never caps browser chat (no surface claim)', async () => {
    runTokenFromAuth.mockReturnValue(BROWSER_TOKEN)
    expect(await invokeStep(stepEvent(40))).toBeNull()
  })
})
