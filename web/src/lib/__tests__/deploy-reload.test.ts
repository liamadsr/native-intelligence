// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  BUILD_HEADER,
  RECHECK_AFTER_MS,
  RELOADED_FOR_KEY,
  __resetDeployReloadForTests,
  __setReloadForTests,
  installDeployReload,
  isStaleBundle,
  isUnsupportedStreamVersionError,
  noteResponseBuild,
  noteServerBuild,
  registerReloadBlocker,
  reloadForStaleStream,
  reloadIfIdle,
} from '../deploy-reload'

/**
 * New deploy → reload when idle (lib/deploy-reload.ts): a window on an older
 * build than the server's reloads itself at the first moment nothing registered
 * is busy, at most once per server build, with no timers.
 */

const reload = vi.fn()

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_BUILD_ID', 'dpl_OLD')
  __resetDeployReloadForTests()
  __setReloadForTests(reload)
  reload.mockReset()
  window.sessionStorage.clear()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('noticing a new deploy', () => {
  it('the same build, a malformed one, or no build of its own is not stale', () => {
    noteServerBuild('dpl_OLD')
    noteServerBuild('not a build id!')
    noteServerBuild(null)
    expect(isStaleBundle()).toBe(false)
    vi.stubEnv('NEXT_PUBLIC_BUILD_ID', '')
    noteServerBuild('dpl_NEW')
    expect(isStaleBundle()).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it('reads the build header off any response', () => {
    noteResponseBuild(new Response(null, { status: 404, headers: { [BUILD_HEADER]: 'dpl_NEW' } }))
    expect(isStaleBundle()).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
  })
})

describe('reloading only when idle, once per build', () => {
  it('a new build with nothing busy reloads at once, and only once for that build', () => {
    noteServerBuild('dpl_NEW')
    expect(reload).toHaveBeenCalledTimes(1)
    expect(window.sessionStorage.getItem(RELOADED_FOR_KEY)).toBe('dpl_NEW')
    // The reload came back on the old bundle (a CDN still serving it): no loop.
    __resetDeployReloadForTests()
    noteServerBuild('dpl_NEW')
    expect(reload).toHaveBeenCalledTimes(1)
    // A later deploy may reload again.
    noteServerBuild('dpl_NEWER')
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('waits while any blocker is busy (or unreadable), then reloads once it is idle', () => {
    let streaming = true
    const release = registerReloadBlocker(() => streaming)
    const broken = registerReloadBlocker(() => {
      throw new Error('unreadable')
    })
    noteServerBuild('dpl_NEW')
    expect(reload).not.toHaveBeenCalled()
    broken()
    expect(reloadIfIdle()).toBe(false)
    streaming = false
    expect(reloadIfIdle()).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
    release()
  })

  it('never reloads when it cannot note the build (it could loop)', () => {
    vi.spyOn(window.sessionStorage.__proto__, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    noteServerBuild('dpl_NEW')
    expect(reload).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})

describe('the visibility / focus check (no timers)', () => {
  it('a window back in view asks /api/version once, not again within the recheck window', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ buildId: 'dpl_NEW' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    installDeployReload()
    noteServerBuild('dpl_OLD', Date.now() - RECHECK_AFTER_MS - 1)
    window.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledWith('/api/version', { cache: 'no-store' })
    // Within the window: no second request.
    __resetDeployReloadForTests()
    noteServerBuild('dpl_OLD')
    window.dispatchEvent(new Event('focus'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a stale window going out of sight reloads then, if idle', () => {
    installDeployReload()
    let busy = true
    registerReloadBlocker(() => busy)
    noteServerBuild('dpl_NEW')
    expect(reload).not.toHaveBeenCalled()
    busy = false
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(reload).toHaveBeenCalledTimes(1)
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
  })
})

describe('the transport backstop: an unsupported stream version reloads instead of erroring', () => {
  it('recognises eve’s error and reloads once for that version, whatever is busy', () => {
    registerReloadBlocker(() => true)
    const err = new TypeError('Unsupported message stream version: 26.')
    expect(isUnsupportedStreamVersionError(err)).toBe(true)
    expect(reloadForStaleStream(err)).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
    // Already reloaded for it: the caller surfaces the error as usual.
    __resetDeployReloadForTests()
    expect(reloadForStaleStream(err)).toBe(false)
  })

  it('any other error is left to the caller', () => {
    expect(reloadForStaleStream(new Error('socket hang up'))).toBe(false)
    expect(reloadForStaleStream(new TypeError('Missing x-eve-stream-version response header.'))).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })
})
