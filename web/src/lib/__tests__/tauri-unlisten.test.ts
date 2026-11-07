import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  UNLISTEN_RETRY_DELAYS_MS,
  disposeAll,
  isMissingListenerError,
  listenScoped,
  safeUnlisten,
  toSafeUnlisten,
  unlistenEach,
} from '../tauri-unlisten'

/** What WebKit says when the webview's listener entry isn't there yet. */
const missing = () => new TypeError("undefined is not an object (evaluating 'listeners[eventId].handlerId')")

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const unhandled: unknown[] = []
const onUnhandled = (reason: unknown) => unhandled.push(reason)

beforeEach(() => {
  vi.useFakeTimers()
  unhandled.length = 0
  process.on('unhandledRejection', onUnhandled)
  vi.spyOn(console, 'debug').mockImplementation(() => {})
})

afterEach(() => {
  process.off('unhandledRejection', onUnhandled)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('isMissingListenerError', () => {
  it('knows the WebKit and Chromium wording, and nothing else', () => {
    expect(isMissingListenerError(missing())).toBe(true)
    expect(isMissingListenerError(new TypeError("Cannot read properties of undefined (reading 'handlerId')"))).toBe(true)
    expect(isMissingListenerError(new Error('command not found'))).toBe(false)
    expect(isMissingListenerError(undefined)).toBe(false)
  })
})

describe('safeUnlisten', () => {
  it('calls the unlisten once', () => {
    const fn = vi.fn()
    safeUnlisten(fn)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('ignores null and undefined', () => {
    expect(() => safeUnlisten(null)).not.toThrow()
    expect(() => safeUnlisten(undefined)).not.toThrow()
  })

  it('swallows a sync throw', () => {
    const fn = vi.fn(() => {
      throw new Error('boom')
    })
    expect(() => safeUnlisten(fn)).not.toThrow()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('swallows an async rejection', async () => {
    const fn = vi.fn(() => Promise.reject(new Error('boom')))
    safeUnlisten(fn)
    await vi.runAllTimersAsync()
    expect(fn).toHaveBeenCalledTimes(1)
    expect(unhandled).toEqual([])
  })

  it('retries after the missing-listener error until the unlisten lands', async () => {
    let calls = 0
    const rustUnlisten = vi.fn()
    // Like Tauri's _unlisten: unregisterListener throws until the
    // registration script lands, and only then does the Rust unlisten run.
    const fn = vi.fn(async () => {
      calls += 1
      if (calls < 3) throw missing()
      rustUnlisten()
    })
    safeUnlisten(fn)
    await vi.advanceTimersByTimeAsync(0)
    expect(fn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(UNLISTEN_RETRY_DELAYS_MS[0])
    expect(fn).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(UNLISTEN_RETRY_DELAYS_MS[1])
    expect(fn).toHaveBeenCalledTimes(3)
    expect(rustUnlisten).toHaveBeenCalledTimes(1)
    await vi.runAllTimersAsync()
    expect(fn).toHaveBeenCalledTimes(3)
    expect(unhandled).toEqual([])
  })

  it('retries a sync missing-listener throw too', async () => {
    let calls = 0
    const fn = vi.fn(() => {
      calls += 1
      if (calls === 1) throw missing()
    })
    safeUnlisten(fn)
    await vi.runAllTimersAsync()
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('gives up after its retries, within ~300 ms, without throwing', async () => {
    const fn = vi.fn(() => Promise.reject(missing()))
    safeUnlisten(fn)
    const total = UNLISTEN_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)
    expect(total).toBeLessThanOrEqual(300)
    await vi.advanceTimersByTimeAsync(total)
    expect(fn).toHaveBeenCalledTimes(UNLISTEN_RETRY_DELAYS_MS.length + 1)
    await vi.runAllTimersAsync()
    expect(fn).toHaveBeenCalledTimes(UNLISTEN_RETRY_DELAYS_MS.length + 1)
    expect(unhandled).toEqual([])
  })

  it('does not retry other errors', async () => {
    const fn = vi.fn(() => Promise.reject(new Error('command not found')))
    safeUnlisten(fn)
    await vi.runAllTimersAsync()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('toSafeUnlisten wraps a function the same way', async () => {
    const fn = vi.fn(() => Promise.reject(new Error('boom')))
    const safe = toSafeUnlisten(fn)
    expect(() => safe()).not.toThrow()
    await vi.runAllTimersAsync()
    expect(fn).toHaveBeenCalledTimes(1)
    expect(unhandled).toEqual([])
  })
})

describe('listenScoped', () => {
  it('dispose after resolve unlistens straight away', async () => {
    const un = vi.fn()
    const dispose = listenScoped(() => Promise.resolve(un))
    await vi.advanceTimersByTimeAsync(0)
    expect(un).not.toHaveBeenCalled()
    dispose()
    expect(un).toHaveBeenCalledTimes(1)
  })

  it('dispose before resolve unlistens once it resolves, a macrotask later', async () => {
    const un = vi.fn()
    const sub = deferred<() => void>()
    const dispose = listenScoped(() => sub.promise)
    dispose()
    sub.resolve(un)
    // The resolution alone (microtasks) must not unlisten yet: the webview's
    // registration script may still be on its way.
    await Promise.resolve()
    await Promise.resolve()
    expect(un).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(0)
    expect(un).toHaveBeenCalledTimes(1)
  })

  it('double dispose unlistens once', async () => {
    const un = vi.fn()
    const dispose = listenScoped(() => Promise.resolve(un))
    await vi.advanceTimersByTimeAsync(0)
    dispose()
    dispose()
    expect(un).toHaveBeenCalledTimes(1)
  })

  it('double dispose before resolve unlistens once', async () => {
    const un = vi.fn()
    const sub = deferred<() => void>()
    const dispose = listenScoped(() => sub.promise)
    dispose()
    dispose()
    sub.resolve(un)
    await vi.runAllTimersAsync()
    expect(un).toHaveBeenCalledTimes(1)
  })

  it('swallows a subscribe that rejects or throws', async () => {
    const rejected = listenScoped(() => Promise.reject(new Error('no event bridge')))
    const thrown = listenScoped(() => {
      throw new Error('no event bridge')
    })
    await vi.runAllTimersAsync()
    expect(() => {
      rejected()
      thrown()
    }).not.toThrow()
    expect(unhandled).toEqual([])
  })

  it('swallows an unlisten that throws or rejects', async () => {
    const sync = listenScoped(() =>
      Promise.resolve(() => {
        throw new Error('boom')
      }),
    )
    const async = listenScoped(() => Promise.resolve(() => Promise.reject(new Error('boom'))))
    await vi.advanceTimersByTimeAsync(0)
    expect(() => {
      sync()
      async()
    }).not.toThrow()
    await vi.runAllTimersAsync()
    expect(unhandled).toEqual([])
  })

  it('retries the unlisten when it hits the missing-listener error (StrictMode mount)', async () => {
    let entryLanded = false
    const rustUnlisten = vi.fn()
    const un = vi.fn(async () => {
      if (!entryLanded) throw missing()
      rustUnlisten()
    })
    const dispose = listenScoped(() => Promise.resolve(un))
    dispose()
    await vi.advanceTimersByTimeAsync(0)
    expect(un).toHaveBeenCalledTimes(1)
    entryLanded = true
    await vi.runAllTimersAsync()
    expect(un).toHaveBeenCalledTimes(2)
    expect(rustUnlisten).toHaveBeenCalledTimes(1)
    expect(unhandled).toEqual([])
  })

  it('gates the handler from the moment of dispose', async () => {
    const seen: number[] = []
    let emit: (n: number) => void = () => {}
    const un = vi.fn()
    const dispose = listenScoped((gate) => {
      const handler = gate((n: number) => {
        seen.push(n)
      })
      emit = handler
      return Promise.resolve(un)
    })
    await vi.advanceTimersByTimeAsync(0)
    emit(1)
    dispose()
    emit(2)
    expect(seen).toEqual([1])
  })

  it('gates the handler disposed before the subscription resolved', async () => {
    const seen: string[] = []
    let emit: (s: string) => void = () => {}
    const sub = deferred<() => void>()
    const dispose = listenScoped((gate) => {
      emit = gate((s: string) => {
        seen.push(s)
      })
      return sub.promise
    })
    dispose()
    emit('late')
    sub.resolve(vi.fn())
    await vi.runAllTimersAsync()
    expect(seen).toEqual([])
  })

  it('accepts a synchronous unlisten and a nullish one', () => {
    const un = vi.fn()
    listenScoped(() => un)()
    expect(un).toHaveBeenCalledTimes(1)
    expect(() => listenScoped(() => undefined)()).not.toThrow()
  })
})

describe('unlistenEach and disposeAll', () => {
  it('unlistenEach runs each fulfilled unlisten safely, once', async () => {
    const a = vi.fn()
    const b = vi.fn(() => Promise.reject(new Error('boom')))
    const settled = await Promise.allSettled([Promise.resolve(a), Promise.reject(new Error('x')), Promise.resolve(b)])
    const off = unlistenEach(settled)
    off()
    off()
    await vi.runAllTimersAsync()
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    expect(unhandled).toEqual([])
  })

  it('disposeAll runs each disposer once and never throws', () => {
    const a = vi.fn()
    const b = vi.fn(() => {
      throw new Error('boom')
    })
    const c = vi.fn()
    const off = disposeAll(a, b, null, c)
    expect(() => off()).not.toThrow()
    off()
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    expect(c).toHaveBeenCalledTimes(1)
  })
})
