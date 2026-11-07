/**
 * startLiveTurnSession — the live turn's create POST can be abandoned (client
 * gone, wall clock) without orphaning the durable session the eve create route
 * may already have dispatched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Client } from 'eve/client'

const h = vi.hoisted(() => ({
  /** The create POST's own signal, as the route handed it over. */
  createSignal: null as AbortSignal | null,
  /** The stream's signal. */
  signal: null as AbortSignal | null,
  settle: null as null | { resolve: (v: { sessionId: string }) => void; reject: (e: unknown) => void },
  cancels: [] as string[],
  /** What the next cancelTaskSession reports (false = the cancel POST failed). */
  cancelOk: true,
}))

vi.mock('@/lib/eve/task-session', () => ({
  createTaskSession: (_c: unknown, opts: { signal?: AbortSignal; createSignal?: AbortSignal }) => {
    h.createSignal = opts.createSignal ?? null
    h.signal = opts.signal ?? null
    return new Promise((resolve, reject) => {
      h.settle = { resolve, reject }
      // Like fetch: the POST rejects when ITS signal aborts.
      opts.createSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
        once: true,
      })
    })
  },
  cancelTaskSession: async (_c: unknown, id: string) => {
    h.cancels.push(id)
    return h.cancelOk
  },
}))

const { CREATE_CANCEL_GRACE_MS, LiveTurnAbandonedError, startLiveTurnSession } = await import('../eve-turn')

const client = {} as Client

beforeEach(() => {
  h.createSignal = null
  h.signal = null
  h.settle = null
  h.cancels = []
  h.cancelOk = true
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('startLiveTurnSession', () => {
  it('the create POST never runs on the abandon signal; the stream does', async () => {
    const wall = new AbortController()
    const p = startLiveTurnSession(client, { message: 'm', signal: wall.signal })
    expect(h.signal).toBe(wall.signal)
    expect(h.createSignal).not.toBe(wall.signal)
    h.settle!.resolve({ sessionId: 's-1' })
    await expect(p).resolves.toEqual({ sessionId: 's-1' })
    expect(h.cancels).toEqual([])
  })

  it('abandoned mid-create → waits for the id, cancels that session, throws LiveTurnAbandonedError', async () => {
    const wall = new AbortController()
    const p = startLiveTurnSession(client, { message: 'm', signal: wall.signal })
    wall.abort()
    await Promise.resolve()
    expect(h.createSignal!.aborted).toBe(false)
    h.settle!.resolve({ sessionId: 's-late' })
    await expect(p).rejects.toBeInstanceOf(LiveTurnAbandonedError)
    expect(h.cancels).toEqual(['s-late'])
  })

  it('already abandoned before the call → still cancels whatever the create starts', async () => {
    const wall = new AbortController()
    wall.abort()
    const p = startLiveTurnSession(client, { message: 'm', signal: wall.signal })
    h.settle!.resolve({ sessionId: 's-pre' })
    await expect(p).rejects.toBeInstanceOf(LiveTurnAbandonedError)
    expect(h.cancels).toEqual(['s-pre'])
  })

  it('abandoned, then the create fails on its own → nothing started, nothing to cancel', async () => {
    const wall = new AbortController()
    const p = startLiveTurnSession(client, { message: 'm', signal: wall.signal })
    wall.abort()
    h.settle!.reject(new Error('eve task-session create failed (503)'))
    await expect(p).rejects.toBeInstanceOf(LiveTurnAbandonedError)
    expect(h.cancels).toEqual([])
  })

  it('abandoned and the create is still pending after the grace → the POST is aborted, with a warning', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const wall = new AbortController()
    const p = startLiveTurnSession(client, { message: 'm', signal: wall.signal })
    const settled = p.catch((e) => e)
    wall.abort()
    await vi.advanceTimersByTimeAsync(CREATE_CANCEL_GRACE_MS)
    expect(await settled).toBeInstanceOf(LiveTurnAbandonedError)
    expect(h.createSignal!.aborted).toBe(true)
    expect(h.cancels).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('was not cancelled'))
  })

  it('a failed cancel of a known session id is not silent: the warning names the session', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.cancelOk = false
    const wall = new AbortController()
    const p = startLiveTurnSession(client, { message: 'm', signal: wall.signal })
    wall.abort()
    h.settle!.resolve({ sessionId: 's-stuck' })
    await expect(p).rejects.toBeInstanceOf(LiveTurnAbandonedError)
    expect(h.cancels).toEqual(['s-stuck'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('s-stuck'))
  })

  describe('with a deferral (the route hands the pending create to after())', () => {
    it('still pending after the grace → NOT aborted; the deferred work cancels the session whenever its id arrives', async () => {
      vi.useFakeTimers()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const deferred: Promise<void>[] = []
      const wall = new AbortController()
      const p = startLiveTurnSession(client, {
        message: 'm',
        signal: wall.signal,
        defer: { run: (w) => deferred.push(w), until: Date.now() + 120_000 },
      })
      const settled = p.catch((e) => e)
      wall.abort()
      await vi.advanceTimersByTimeAsync(CREATE_CANCEL_GRACE_MS)
      // The turn is released at once (nothing ran that we observed)…
      expect(await settled).toBeInstanceOf(LiveTurnAbandonedError)
      expect(deferred).toHaveLength(1)
      // …but the cold create keeps going, past the grace, on the function's budget.
      expect(h.createSignal!.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(30_000)
      h.settle!.resolve({ sessionId: 's-cold' })
      await deferred[0]
      expect(h.cancels).toEqual(['s-cold'])
      expect(h.createSignal!.aborted).toBe(false)
      expect(warn).not.toHaveBeenCalled()
    })

    it('the function deadline comes first → the POST is aborted then, with the warning', async () => {
      vi.useFakeTimers()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const deferred: Promise<void>[] = []
      const wall = new AbortController()
      const p = startLiveTurnSession(client, {
        message: 'm',
        signal: wall.signal,
        defer: { run: (w) => deferred.push(w), until: Date.now() + 20_000 },
      })
      const settled = p.catch((e) => e)
      wall.abort()
      await vi.advanceTimersByTimeAsync(CREATE_CANCEL_GRACE_MS)
      expect(await settled).toBeInstanceOf(LiveTurnAbandonedError)
      expect(h.createSignal!.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(20_000)
      await deferred[0]
      expect(h.createSignal!.aborted).toBe(true)
      expect(h.cancels).toEqual([])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('was not cancelled'))
    })

    it('no budget left past the grace → aborted at once, nothing deferred', async () => {
      vi.useFakeTimers()
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const deferred: Promise<void>[] = []
      const wall = new AbortController()
      const p = startLiveTurnSession(client, {
        message: 'm',
        signal: wall.signal,
        defer: { run: (w) => deferred.push(w), until: Date.now() + CREATE_CANCEL_GRACE_MS },
      })
      const settled = p.catch((e) => e)
      wall.abort()
      await vi.advanceTimersByTimeAsync(CREATE_CANCEL_GRACE_MS)
      expect(await settled).toBeInstanceOf(LiveTurnAbandonedError)
      expect(deferred).toHaveLength(0)
      expect(h.createSignal!.aborted).toBe(true)
    })
  })

  it('a create that fails before any abandon rejects with its own error', async () => {
    const wall = new AbortController()
    const p = startLiveTurnSession(client, { message: 'm', signal: wall.signal })
    h.settle!.reject(new Error('eve task-session create failed (500)'))
    await expect(p).rejects.toThrow('create failed (500)')
    expect(h.cancels).toEqual([])
  })
})
