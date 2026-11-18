/** The flag read every demo gate shares (src/lib/demo/demo-mode.ts). */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  made: 0,
}))
vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => {
    h.made++
    return { rpc: h.rpc }
  },
}))

import {
  clearDemoWorkspaceCache,
  demoCacheSizesForTests,
  demoVisitorOutside,
  isDemoWorkspace,
  isDemoWorkspaceDbRefusal,
  READ_TIMEOUT_MS,
  readDemoWorkspace,
  setDemoWorkspaceLookupForTests,
} from '../demo-mode'

const answers = (answer: (id: string) => { data: unknown; error: { message: string; code?: string } | null }) =>
  h.rpc.mockImplementation(async (_name: string, args: { p_workspace_id: string }) => answer(args.p_workspace_id))

beforeEach(() => {
  // The real read, not the suite's "nothing is a demo" answer.
  setDemoWorkspaceLookupForTests(null)
  clearDemoWorkspaceCache()
  h.rpc.mockReset()
  h.made = 0
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('isDemoWorkspace', () => {
  it('asks is_demo_workspace() as the service role and remembers the answer for a while', async () => {
    answers((id) => ({ data: id === 'demo', error: null }))
    expect(await isDemoWorkspace('demo')).toBe(true)
    expect(await isDemoWorkspace('demo')).toBe(true)
    expect(await isDemoWorkspace('real')).toBe(false)
    expect(h.rpc).toHaveBeenCalledTimes(2)
    expect(h.rpc).toHaveBeenCalledWith('is_demo_workspace', { p_workspace_id: 'demo' })
  })

  it('no workspace is not a demo, and reads nothing', async () => {
    answers(() => ({ data: true, error: null }))
    expect(await isDemoWorkspace(null)).toBe(false)
    expect(h.made).toBe(0)
  })

  it('only `true` is a demo', async () => {
    answers(() => ({ data: 'yes', error: null }))
    expect(await isDemoWorkspace('w')).toBe(false)
  })

  it('an unreadable flag is "not a demo": never thrown, logged once, and stands for ten seconds only', async () => {
    vi.useFakeTimers()
    try {
      let fail = true
      answers(() => (fail ? { data: null, error: { message: 'timeout' } } : { data: true, error: null }))
      expect(await isDemoWorkspace('w')).toBe(false)
      expect(await readDemoWorkspace('w')).toBeNull()
      // A database blip is one read and one log line, not one per request.
      expect(h.rpc).toHaveBeenCalledTimes(1)
      expect(console.error).toHaveBeenCalledTimes(1)
      fail = false
      vi.advanceTimersByTime(9_000)
      expect(await isDemoWorkspace('w')).toBe(false)
      vi.advanceTimersByTime(2_000)
      expect(await isDemoWorkspace('w')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('everyone asking at once shares one read', async () => {
    let release: (v: { data: unknown; error: null }) => void = () => undefined
    h.rpc.mockImplementation(() => new Promise((resolve) => { release = resolve }))
    const asked = [isDemoWorkspace('w'), isDemoWorkspace('w'), isDemoWorkspace('w')]
    await vi.waitFor(() => expect(h.rpc).toHaveBeenCalled())
    release({ data: true, error: null })
    expect(await Promise.all(asked)).toEqual([true, true, true])
    expect(h.rpc).toHaveBeenCalledTimes(1)
  })

  it('a read that never answers is given up on: everyone waiting on it is let go, and the next read goes through', async () => {
    vi.useFakeTimers()
    try {
      h.rpc.mockImplementation(() => new Promise(() => undefined))
      const asked = [isDemoWorkspace('w'), isDemoWorkspace('w'), readDemoWorkspace('w')]
      await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS - 1)
      let settled = false
      void Promise.all(asked).then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      // Unreadable, as any failed read is: "not a demo", one read, one log line.
      expect(await Promise.all(asked)).toEqual([false, false, null])
      expect(h.rpc).toHaveBeenCalledTimes(1)
      expect(console.error).toHaveBeenCalledTimes(1)
      answers(() => ({ data: true, error: null }))
      await vi.advanceTimersByTimeAsync(10_001)
      expect(await isDemoWorkspace('w')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('giving up cancels the request where the client can, and an answer in time cancels nothing', async () => {
    vi.useFakeTimers()
    try {
      const signals: AbortSignal[] = []
      const builder = (answer: Promise<unknown>) => ({
        abortSignal: (signal: AbortSignal) => {
          signals.push(signal)
          return answer
        },
      })
      h.rpc.mockImplementation(() => builder(new Promise(() => undefined)))
      const stalled = isDemoWorkspace('stalled')
      await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS)
      expect(await stalled).toBe(false)
      expect(signals[0].aborted).toBe(true)
      h.rpc.mockImplementation(() => builder(Promise.resolve({ data: true, error: null })))
      expect(await isDemoWorkspace('quick')).toBe(true)
      await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS * 2)
      expect(signals[1].aborted).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('the cache is bounded: the oldest answers go', async () => {
    answers(() => ({ data: false, error: null }))
    const { max } = demoCacheSizesForTests()
    for (let i = 0; i < max + 50; i += 500) {
      await Promise.all(Array.from({ length: 500 }, (_, j) => isDemoWorkspace(`w-${i + j}`)))
    }
    expect(demoCacheSizesForTests().flags).toBe(max)
  })

  it('a client that throws is unreadable too', async () => {
    h.rpc.mockRejectedValue(new Error('socket hang up'))
    expect(await readDemoWorkspace('w')).toBeNull()
    expect(await isDemoWorkspace('w')).toBe(false)
  })

  it('before migration 669 (no such function) nothing is a demo', async () => {
    answers(() => ({ data: null, error: { message: 'not found', code: 'PGRST202' } }))
    expect(await readDemoWorkspace('w')).toBe(false)
  })
})

describe('demoVisitorOutside', () => {
  const visitor = { reason: 'demo_workspace' }

  it('a visitor’s work in the demo workspace is inside; in a workspace known not to be one, outside', async () => {
    answers((id) => ({ data: id === 'demo', error: null }))
    expect(await demoVisitorOutside(visitor, 'demo')).toBe(false)
    expect(await demoVisitorOutside(visitor, 'own')).toBe(true)
  })

  it('refuses when it cannot tell: no workspace named, or a flag that cannot be read, is outside', async () => {
    answers(() => ({ data: null, error: { message: 'down' } }))
    expect(await demoVisitorOutside(visitor, null)).toBe(true)
    expect(await demoVisitorOutside(visitor, undefined)).toBe(true)
    expect(await demoVisitorOutside(visitor, 'demo')).toBe(true)
  })

  it('anyone let in another way is never asked about', async () => {
    answers(() => ({ data: false, error: null }))
    expect(await demoVisitorOutside({ reason: 'within_limits' }, 'own')).toBe(false)
    expect(await demoVisitorOutside(null, 'own')).toBe(false)
    expect(h.rpc).not.toHaveBeenCalled()
  })
})

describe('isDemoWorkspaceDbRefusal', () => {
  it('knows the trigger’s refusal by its hint or its message', () => {
    expect(isDemoWorkspaceDbRefusal({ message: 'x', hint: 'DEMO_WORKSPACE' })).toBe(true)
    expect(isDemoWorkspaceDbRefusal({ message: 'demo_workspace: connected_account_workspace cannot be connected to or shared into a demo workspace' })).toBe(true)
    expect(isDemoWorkspaceDbRefusal({ message: 'duplicate key value' })).toBe(false)
    expect(isDemoWorkspaceDbRefusal(null)).toBe(false)
  })
})
