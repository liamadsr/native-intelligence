// @vitest-environment jsdom
/**
 * A meeting guest's page (../guest-meeting.tsx), up to the call:
 *   - waiting in the lobby with the tab hidden still asks the server (slowly),
 *     so a guest who looks at another tab keeps their place;
 *   - a place lost while waiting sends them back to ask again, never
 *     "The meeting ended";
 *   - let in, but the call server can't be reached: said as that, with a way
 *     to ask again; a call that is over says it ended;
 *   - the entry page's notice (notes on now, or every call starts with
 *     them; a recording running) says that asking to join is their go, and
 *     the ask tells the server what the page showed (the server decides);
 *   - a link opened early moves on by itself: one timer to its opening.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { GuestMeeting } from '../guest-meeting'
import { RefreshWhenOpen, refreshDelay } from '../refresh-when-open'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TOKEN = 'a'.repeat(32)
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

let root: Root
let el: HTMLDivElement
let visibility: DocumentVisibilityState
let lobby: () => Response
let tokenAnswer: () => Response
let lobbyAsks: number
let joinBodies: unknown[]

function setVisibility(v: DocumentVisibilityState) {
  visibility = v
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  vi.useFakeTimers()
  el = document.createElement('div')
  document.body.appendChild(el)
  root = createRoot(el)
  visibility = 'visible'
  lobbyAsks = 0
  joinBodies = []
  lobby = () => json({ state: 'waiting', open: true })
  tokenAnswer = () => json({}, 503)
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) }, sendBeacon: () => true })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/join')) {
        joinBodies.push(JSON.parse(String(init?.body ?? '{}')))
        return json({ state: 'waiting' })
      }
      if (url.endsWith('/lobby')) {
        lobbyAsks += 1
        return lobby()
      }
      if (url.endsWith('/token')) return tokenAnswer()
      return json({ ok: init?.method === 'POST' })
    }),
  )
})

afterEach(() => {
  act(() => root.unmount())
  el.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const q = (sel: string) => el.querySelector<HTMLElement>(sel)

type Props = Parameters<typeof GuestMeeting>[0]

async function render(over: Partial<Props> = {}) {
  await act(async () => {
    root.render(h(GuestMeeting, { token: TOKEN, title: 'Design review', host: 'Rosa', notes: false, recording: false, ...over }))
  })
}

async function askToJoin(over: Partial<Props> = {}) {
  await render(over)
  const input = q('[data-guest-name]') as HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Dana Lee')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    q('[data-guest-ask]')!.click()
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(q('[data-guest-waiting]')).not.toBeNull()
}

describe('a guest waiting in the lobby', () => {
  it('keeps asking while the tab is hidden, every 20 seconds, and at once when it is back', async () => {
    await askToJoin()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
    })
    const before = lobbyAsks
    expect(before).toBeGreaterThan(0)
    setVisibility('hidden')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(65_000)
    })
    // Slowly, but well inside the two minutes a waiting guest is kept for.
    expect(lobbyAsks - before).toBeGreaterThanOrEqual(3)
    expect(lobbyAsks - before).toBeLessThanOrEqual(6)
    const hidden = lobbyAsks
    await act(async () => {
      setVisibility('visible')
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(lobbyAsks).toBe(hidden + 1)
  })

  it('a place lost while waiting goes back to asking, never "The meeting ended"', async () => {
    await askToJoin()
    lobby = () => json({ state: 'left', open: true })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100)
    })
    expect(q('[data-guest-done]')).toBeNull()
    expect(q('[data-guest-error]')?.textContent).toContain('Ask to join again')
  })

  it('let in but the call server can’t be reached: said as that, not as an ended meeting', async () => {
    await askToJoin()
    lobby = () => json({ state: 'admitted', open: true })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100)
    })
    expect(q('[data-guest-done]')?.dataset.guestDone).toBe('unreachable')
    expect(el.textContent).toContain('couldn’t be reached')
  })

  it('a camera still starting when they are let in is stopped as it arrives: no stream is left running', async () => {
    await askToJoin()
    const stop = vi.fn()
    let arrive: (stream: unknown) => void = () => undefined
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => new Promise((resolve) => (arrive = resolve)) }, sendBeacon: () => true })
    // The camera's switch is theirs in the lobby too; the browser's prompt is still open.
    await act(async () => {
      q('[data-guest-camera]')!.click()
    })
    lobby = () => json({ state: 'admitted', open: true })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100)
    })
    expect(q('[data-guest-done]')).not.toBeNull()
    await act(async () => {
      arrive({ getTracks: () => [{ stop }] })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('let in to a call that is over: it ended', async () => {
    await askToJoin()
    lobby = () => json({ state: 'admitted', open: true })
    tokenAnswer = () => json({ error: 'Not let in', code: 'NOT_LET_IN' }, 409)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100)
    })
    expect(q('[data-guest-done]')?.dataset.guestDone).toBe('ended')
  })
})

describe('the entry page’s notice', () => {
  it('nothing on: no notice, and the ask says none was shown', async () => {
    await askToJoin()
    expect(joinBodies).toEqual([{ name: 'Dana Lee', notice: { notes: false, recording: false } }])
  })

  it('every call starts with notes: the notice shows before any call exists, says asking is their go, and the ask says so', async () => {
    await render({ notesAtStart: true })
    expect(q('[data-guest-notice]')?.textContent).toContain('Notes are on in this meeting')
    expect(q('[data-guest-notice-agree]')?.textContent).toContain('By asking to join, you agree to this.')
    expect(q('[data-guest-ask]')?.textContent).toBe('Ask to join')
    await askToJoin({ notesAtStart: true })
    expect(joinBodies).toEqual([{ name: 'Dana Lee', notice: { notes: true, recording: false } }])
    // Waiting: the notice stays, without the line about asking.
    expect(q('[data-guest-notice]')?.textContent).toContain('Notes are on in this meeting')
    expect(q('[data-guest-notice-agree]')).toBeNull()
  })

  it('a live call with notes and a recording: both said, both in the ask', async () => {
    await askToJoin({ notes: true, recording: true })
    expect(joinBodies).toEqual([{ name: 'Dana Lee', notice: { notes: true, recording: true } }])
  })
})

describe('a link opened before its time', () => {
  it('asks the server again once, just after the opening, by the server’s own count', async () => {
    refresh.mockClear()
    await act(async () => {
      root.render(h(RefreshWhenOpen, { inMs: 60_000 }))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_999)
    })
    expect(refresh).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(refresh).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600_000)
    })
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('a far opening waits in steps setTimeout can hold; nothing for a count that is not a number', () => {
    expect(refreshDelay(40 * 86_400_000)).toBe(2_147_483_647)
    expect(refreshDelay(-5_000)).toBe(2_000)
    expect(refreshDelay(Number.NaN)).toBeNull()
  })
})
