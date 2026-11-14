// @vitest-environment jsdom
/**
 * A call's audio in its capture's properties (src/components/capture/call-audio.tsx):
 * a capture a call's recorder did not fill asks nothing and draws nothing; a
 * kept file has Play and Download and says the day it will be deleted, and no
 * link is asked for before Play or Download is pressed; a deleted file says
 * the day it was, with nothing to play; one on its way says so; several are
 * named by part, each with its own day when their days differ; a link that
 * runs out while it plays is renewed and the sound goes on where it was, as
 * often as that happens; a link that never comes gives the control back, and
 * Pause drops a wait.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const opened = vi.hoisted(() => ({ urls: [] as string[] }))
const toastMock = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: toastMock }))
vi.mock('@/lib/open-external', () => ({ openExternalUrl: async (url: string) => void opened.urls.push(url) }))

import { CallAudioRow, audioDay, clock } from '../call-audio'

const CAPTURE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const team = { source: 'team_call', team_call_id: '77777777-7777-4777-8777-777777777777' }
const ready = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', part: 0, state: 'ready', durationMs: 2_525_000, expiresAt: '2026-12-13T10:00:00.000Z', deletedAt: null }

let container: HTMLDivElement
let root: Root
let requests: string[]
let files: unknown[]
/** How long the next play links last (seconds); the route's `expiresIn`. */
let playLinkSeconds = 3600

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  requests = []
  opened.urls = []
  files = []
  playLinkSeconds = 3600
  vi.stubGlobal('fetch', async (url: string) => {
    requests.push(url)
    if (url.includes('as=download')) return new Response(JSON.stringify({ url: 'https://sb.example.test/storage/v1/object/sign/x?token=t&download=Call%20audio.m4a' }))
    if (url.includes('as=play')) return new Response(JSON.stringify({ url: `https://sb.example.test/storage/v1/object/sign/x?token=link-${requests.filter((r) => r.includes('as=play')).length}`, expiresIn: playLinkSeconds }))
    return new Response(JSON.stringify({ files }))
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  toastMock.mockClear()
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function mount(metadata: Record<string, unknown> | null) {
  await act(async () => {
    root.render(<CallAudioRow captureId={CAPTURE} metadata={metadata} />)
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

describe('CallAudioRow', () => {
  it('a capture no call recorder filled: no request, nothing drawn', async () => {
    await mount({ source: 'desktop' })
    await mount(null)
    expect(requests).toEqual([])
    expect(container.innerHTML).toBe('')
  })

  it('a call with no audio: nothing drawn', async () => {
    await mount(team)
    expect(requests).toEqual([`/api/account/captures/${CAPTURE}/audio`])
    expect(container.innerHTML).toBe('')
  })

  it('kept: Play, its length, Download, and the day it will be deleted; no link asked for until pressed', async () => {
    files = [ready]
    await mount(team)
    const row = container.querySelector('[data-capture-call-audio="ready"]')!
    expect(row.textContent).toContain('Call audio')
    expect(row.textContent).toContain('42:05')
    expect(row.querySelector('[data-capture-call-audio-expires]')!.textContent).toBe(`Will be deleted on ${audioDay(ready.expiresAt)}. Download it to keep a copy.`)
    expect(row.querySelector('[data-capture-call-audio-play]')).not.toBeNull()
    expect(requests).toHaveLength(1)
    await act(async () => {
      row.querySelector('[data-capture-call-audio-download]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(requests[1]).toBe(`/api/account/captures/${CAPTURE}/audio?file=${ready.id}&as=download`)
    expect(opened.urls).toEqual(['https://sb.example.test/storage/v1/object/sign/x?token=t&download=Call%20audio.m4a'])
  })

  it('deleted: the day it was, nothing to play or download', async () => {
    files = [{ ...ready, state: 'deleted', deletedAt: '2026-12-14T04:17:00.000Z' }]
    await mount(team)
    const row = container.querySelector('[data-capture-call-audio="deleted"]')!
    expect(row.textContent).toBe(`Call audio was deleted on ${audioDay('2026-12-14T04:17:00.000Z')}.`)
    expect(container.querySelector('button')).toBeNull()
    expect(container.querySelector('audio')).toBeNull()
  })

  it('on its way: says it is being saved', async () => {
    files = [{ ...ready, state: 'saving' }]
    await mount(team)
    expect(container.querySelector('[data-capture-call-audio="saving"]')!.textContent).toBe('Saving call audio…')
  })

  it('several on one day: named by part, the day said once under the last', async () => {
    files = [ready, { ...ready, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', part: 1 }]
    await mount(team)
    const labels = [...container.querySelectorAll('[data-capture-call-audio="ready"]')].map((r) => r.textContent)
    expect(labels[0]).toContain('Call audio, part 1')
    expect(labels[1]).toContain('Call audio, part 2')
    const notes = [...container.querySelectorAll('[data-capture-call-audio-expires]')].map((n) => n.textContent)
    expect(notes).toEqual([`These will be deleted on ${audioDay(ready.expiresAt)}. Download them to keep a copy.`])
  })

  it('several on different days (rounds days apart): each says its own day', async () => {
    files = [ready, { ...ready, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', part: 1, expiresAt: '2026-12-15T10:00:00.000Z' }]
    await mount(team)
    const notes = [...container.querySelectorAll('[data-capture-call-audio-expires]')].map((n) => n.textContent)
    expect(notes).toEqual([
      `Will be deleted on ${audioDay('2026-12-13T10:00:00.000Z')}. Download it to keep a copy.`,
      `Will be deleted on ${audioDay('2026-12-15T10:00:00.000Z')}. Download it to keep a copy.`,
    ])
  })

  it('a link that runs out while it plays: a fresh one, on from the same place, and again an hour later', async () => {
    files = [ready]
    await mount(team)
    const el = container.querySelector('audio')!
    // The media element, as a browser's: play and load, and where it is.
    let position = 0
    const plays: number[] = []
    Object.defineProperty(el, 'currentTime', { get: () => position, set: (v: number) => void (position = v), configurable: true })
    el.play = vi.fn(async () => {
      plays.push(position)
      el.dispatchEvent(new Event('play'))
    })
    el.pause = vi.fn(() => void el.dispatchEvent(new Event('pause')))
    el.load = vi.fn()
    const fire = (type: string) => act(async () => void el.dispatchEvent(new Event(type)))
    const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))))

    await act(async () => container.querySelector('[data-capture-call-audio-play]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await settle()
    expect(el.getAttribute('src')).toBe('https://sb.example.test/storage/v1/object/sign/x?token=link-1')
    expect(plays).toEqual([0])
    await fire('loadedmetadata')

    // 40 minutes in, the hour's link runs out.
    position = 2400
    await fire('error')
    await settle()
    expect(el.getAttribute('src')).toBe('https://sb.example.test/storage/v1/object/sign/x?token=link-2')
    await fire('loadedmetadata')
    expect(position).toBe(2400)
    expect(plays).toEqual([0, 2400])

    // An hour later, again.
    position = 6000
    await fire('error')
    await settle()
    expect(el.getAttribute('src')).toBe('https://sb.example.test/storage/v1/object/sign/x?token=link-3')
    await fire('loadedmetadata')
    expect(position).toBe(6000)
    expect(plays).toEqual([0, 2400, 6000])
    expect(container.querySelector('[data-capture-call-audio-play]')!.getAttribute('aria-label')).toBe('Pause call audio')
  })

  it('paused when the link runs out: renewed in place, and stays paused', async () => {
    files = [ready]
    await mount(team)
    const el = container.querySelector('audio')!
    let position = 0
    const plays: number[] = []
    Object.defineProperty(el, 'currentTime', { get: () => position, set: (v: number) => void (position = v), configurable: true })
    el.play = vi.fn(async () => void (plays.push(position), el.dispatchEvent(new Event('play'))))
    el.pause = vi.fn(() => void el.dispatchEvent(new Event('pause')))
    el.load = vi.fn()
    const play = container.querySelector('[data-capture-call-audio-play]')!
    await act(async () => play.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))))
    await act(async () => void el.dispatchEvent(new Event('loadedmetadata')))
    position = 900
    await act(async () => play.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await act(async () => void el.dispatchEvent(new Event('error')))
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))))
    await act(async () => void el.dispatchEvent(new Event('loadedmetadata')))
    expect(position).toBe(900)
    expect(plays).toEqual([0])
  })

  /** Both of the player's clocks (the wall's and the page's steady one) move on by `ms`. */
  function later(ms: number) {
    const wall = Date.now
    const steady = performance.now.bind(performance)
    vi.spyOn(Date, 'now').mockImplementation(() => wall() + ms)
    vi.spyOn(performance, 'now').mockImplementation(() => steady() + ms)
  }

  /** The player's media element, as a browser's, with where it is and what was played from. */
  function media() {
    const el = container.querySelector('audio')!
    const m = { el, position: 0, plays: [] as number[] }
    Object.defineProperty(el, 'currentTime', { get: () => m.position, set: (v: number) => void (m.position = v), configurable: true })
    el.play = vi.fn(async () => void (m.plays.push(m.position), el.dispatchEvent(new Event('play'))))
    el.pause = vi.fn(() => void el.dispatchEvent(new Event('pause')))
    el.load = vi.fn()
    return m
  }
  const tick = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))))
  const fire = (el: HTMLElement, type: string) => act(async () => void el.dispatchEvent(new Event(type)))
  const press = () => act(async () => container.querySelector('[data-capture-call-audio-play]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  const moveTo = async (seconds: number) => {
    const bar = container.querySelector('input[type=range]') as HTMLInputElement
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      set.call(bar, String(Math.round((seconds * 1000 * 1000) / ready.durationMs)))
      bar.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('a move along the bar on a link about to run out: a fresh link first, then on from there (a dead one would stall in WebKit, never failing)', async () => {
    files = [ready]
    await mount(team)
    const m = media()
    await press()
    await tick()
    await fire(m.el, 'loadedmetadata')
    m.position = 100
    later(3_550_000) // 50 s left of its hour: inside the minute's margin
    await moveTo(1200)
    await tick()
    expect(m.el.getAttribute('src')).toContain('token=link-2')
    await fire(m.el, 'loadedmetadata')
    // The bar moves in thousandths of the file (2.5 s here).
    expect(Math.abs(m.position - 1200)).toBeLessThan(3)
    expect(Math.abs(m.plays.at(-1)! - 1200)).toBeLessThan(3)
  })

  it('a move along the bar on a good link just moves (no new link)', async () => {
    files = [ready]
    await mount(team)
    const m = media()
    await press()
    await tick()
    await fire(m.el, 'loadedmetadata')
    await moveTo(600)
    expect(Math.abs(m.position - 600)).toBeLessThan(3)
    expect(requests.filter((r) => r.includes('as=play'))).toHaveLength(1)
  })

  it('Play after a pause past the link’s hour: a fresh link, on from the same place', async () => {
    files = [ready]
    await mount(team)
    const m = media()
    await press()
    await tick()
    await fire(m.el, 'loadedmetadata')
    m.position = 754
    await press() // pause
    later(3_600_000) // paused for its whole hour
    await press() // play again, the link run out meanwhile
    await tick()
    expect(m.el.getAttribute('src')).toContain('token=link-2')
    await fire(m.el, 'loadedmetadata')
    expect(m.position).toBe(754)
    expect(m.plays).toEqual([0, 754])
  })

  it('waiting on a link that ran out (WebKit stalls instead of failing): renewed, on from where it was', async () => {
    files = [ready]
    await mount(team)
    const m = media()
    await press()
    await tick()
    await fire(m.el, 'loadedmetadata')
    m.position = 3000
    later(3_600_000)
    await fire(m.el, 'stalled')
    await tick()
    expect(m.el.getAttribute('src')).toContain('token=link-2')
    await fire(m.el, 'loadedmetadata')
    expect(m.plays.at(-1)).toBe(3000)
  })

  it('a renewed link that never loads: after its wait the control is the person’s again, with a line, and Play goes on from the same place', async () => {
    files = [ready]
    await mount(team)
    const m = media()
    await press()
    await tick()
    await fire(m.el, 'loadedmetadata')
    m.position = 1500
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await fire(m.el, 'error') // the link failed: renewed, and the new one never answers
      await act(async () => void (await vi.advanceTimersByTimeAsync(0)))
      const button = container.querySelector('[data-capture-call-audio-play]') as HTMLButtonElement
      // Waiting: the button says Pause (and would drop the wait).
      expect(button.getAttribute('aria-label')).toBe('Pause call audio')
      await act(async () => void (await vi.advanceTimersByTimeAsync(15_000)))
      expect(button.disabled).toBe(false)
      expect(button.getAttribute('aria-label')).toBe('Play call audio')
      expect(toastMock).toHaveBeenCalledWith('The audio is slow to load. Press play to try again.')
      await press()
      await fire(m.el, 'loadedmetadata')
      expect(m.plays.at(-1)).toBe(1500)
    } finally {
      vi.useRealTimers()
    }
  })

  it('two stall signals during one renewal (WebKit says stalled and waiting together): one fresh link, and it plays on', async () => {
    files = [ready]
    await mount(team)
    const m = media()
    await press()
    await tick()
    await fire(m.el, 'loadedmetadata')
    m.position = 3000
    later(3_600_000)
    // Both arrive before the fresh link's fetch has answered.
    await act(async () => {
      m.el.dispatchEvent(new Event('waiting'))
      m.el.dispatchEvent(new Event('stalled'))
      m.el.dispatchEvent(new Event('error'))
    })
    await tick()
    expect(requests.filter((r) => r.includes('as=play'))).toHaveLength(2)
    await fire(m.el, 'loadedmetadata')
    expect(m.plays.at(-1)).toBe(3000)
    expect(toastMock).not.toHaveBeenCalled()
    expect(container.querySelector('[data-capture-call-audio-play]')!.getAttribute('aria-label')).toBe('Pause call audio')
  })

  it('a link with under a minute of life (a file in its last minute) is fetched once and plays, not renewed in a loop', async () => {
    files = [ready]
    playLinkSeconds = 30
    await mount(team)
    const m = media()
    await press()
    await tick()
    await fire(m.el, 'loadedmetadata')
    for (let i = 0; i < 5; i++) {
      await fire(m.el, 'waiting')
      await fire(m.el, 'stalled')
    }
    expect(requests.filter((r) => r.includes('as=play'))).toHaveLength(1)
    expect(m.plays).toEqual([0])
  })

  it('the device clock set back an hour: the link is still seen to run out (the page’s steady clock)', async () => {
    files = [ready]
    await mount(team)
    const m = media()
    await press()
    await tick()
    await fire(m.el, 'loadedmetadata')
    m.position = 500
    const wall = Date.now
    const steady = performance.now.bind(performance)
    vi.spyOn(Date, 'now').mockImplementation(() => wall() - 3_600_000)
    vi.spyOn(performance, 'now').mockImplementation(() => steady() + 3_600_000)
    await fire(m.el, 'stalled')
    await tick()
    expect(m.el.getAttribute('src')).toContain('token=link-2')
  })

  it('after a give-up, Play fetches a fresh link and plays again, from where it stopped', async () => {
    files = [ready]
    await mount(team)
    const m = media()
    await press()
    await tick()
    await fire(m.el, 'loadedmetadata')
    m.position = 900
    await fire(m.el, 'error') // the link failed: renewal with link 2
    await tick()
    await fire(m.el, 'error') // link 2 failed as well: give up
    expect(toastMock).toHaveBeenCalledWith('That audio can’t be played.')
    expect(m.el.getAttribute('src')).toBeNull()
    const button = container.querySelector('[data-capture-call-audio-play]') as HTMLButtonElement
    expect(button.disabled).toBe(false)
    await press()
    await tick()
    expect(m.el.getAttribute('src')).toContain('token=link-3')
    await fire(m.el, 'loadedmetadata')
    expect(m.plays.at(-1)).toBe(900)
    expect(button.getAttribute('aria-label')).toBe('Pause call audio')
  })

  it('gone while a renewal’s link is being fetched: no line said later, nothing left loading', async () => {
    files = [ready]
    let answer: (r: Response) => void = () => undefined
    await mount(team)
    const m = media()
    await press()
    await tick()
    await fire(m.el, 'loadedmetadata')
    vi.stubGlobal('fetch', (url: string) => {
      requests.push(url)
      return new Promise<Response>((r) => (answer = r))
    })
    later(3_600_000)
    await fire(m.el, 'stalled')
    await act(async () => root.render(<div />))
    expect(m.el.getAttribute('src')).toBeNull()
    expect(m.el.load).toHaveBeenCalled()
    answer(new Response(JSON.stringify({ url: 'https://sb.example.test/x?token=late', expiresIn: 3600 })))
    await tick()
    expect(m.el.getAttribute('src')).toBeNull()
    expect(toastMock).not.toHaveBeenCalled()
  })

  it('a fresh link that fails as well: it gives up and says so, nothing loops', async () => {
    files = [ready]
    await mount(team)
    const el = container.querySelector('audio')!
    el.play = vi.fn(async () => void el.dispatchEvent(new Event('play')))
    el.load = vi.fn()
    await act(async () => container.querySelector('[data-capture-call-audio-play]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))))
    for (let i = 0; i < 2; i++) {
      await act(async () => void el.dispatchEvent(new Event('error')))
      await act(async () => void (await new Promise((r) => setTimeout(r, 0))))
    }
    expect(requests.filter((r) => r.includes('as=play'))).toHaveLength(2)
    expect(toastMock).toHaveBeenCalledWith('That audio can’t be played.')
    expect(container.querySelector('[data-capture-call-audio-play]')!.getAttribute('aria-label')).toBe('Play call audio')
  })

  /** Play links from now on: each one's answer waits until `answers[n]` is called (n from 0). */
  function heldPlayLinks() {
    const answers: Array<() => void> = []
    vi.stubGlobal('fetch', (url: string) => {
      requests.push(url)
      if (!url.includes('as=play')) return Promise.resolve(new Response(JSON.stringify({ files })))
      const n = requests.filter((r) => r.includes('as=play')).length
      return new Promise<Response>((resolve) => {
        answers.push(() => resolve(new Response(JSON.stringify({ url: `https://sb.example.test/x?token=held-${n}`, expiresIn: 3600 }))))
      })
    })
    return answers
  }
  const button = () => container.querySelector('[data-capture-call-audio-play]') as HTMLButtonElement
  const shown = () => container.querySelector('[data-capture-call-audio="ready"] .tabular-nums')!.textContent

  it('the first Play’s link never comes: after the wait the control is the person’s again, with a line, and a late answer changes nothing', async () => {
    files = [ready]
    await mount(team)
    const m = media()
    const answers = heldPlayLinks()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await press()
      expect(button().disabled).toBe(false)
      expect(button().getAttribute('aria-label')).toBe('Pause call audio')
      await act(async () => void (await vi.advanceTimersByTimeAsync(15_000)))
      expect(button().getAttribute('aria-label')).toBe('Play call audio')
      expect(toastMock).toHaveBeenCalledWith('The audio is slow to load. Press play to try again.')
      answers[0]() // the answer comes at last
      await act(async () => void (await vi.advanceTimersByTimeAsync(0)))
      expect(m.el.getAttribute('src')).toBeNull()
      expect(m.plays).toEqual([])
      expect(button().getAttribute('aria-label')).toBe('Play call audio')
      expect(toastMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
    // Play again: a new link, and it plays.
    vi.stubGlobal('fetch', async (url: string) => {
      requests.push(url)
      return new Response(JSON.stringify({ url: 'https://sb.example.test/x?token=again', expiresIn: 3600 }))
    })
    await press()
    await tick()
    expect(m.el.getAttribute('src')).toContain('token=again')
    expect(m.plays).toEqual([0])
  })

  it('a renewal’s link never comes: after the wait the control is back, the place kept and shown, a late answer changes nothing, and Play goes on from there', async () => {
    files = [ready]
    await mount(team)
    const m = media()
    await press()
    await tick()
    await fire(m.el, 'loadedmetadata')
    m.position = 1200
    const answers = heldPlayLinks()
    later(3_600_000)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await fire(m.el, 'stalled') // a dead link: renewal, and its link never comes
      expect(button().getAttribute('aria-label')).toBe('Pause call audio')
      await act(async () => void (await vi.advanceTimersByTimeAsync(15_000)))
      expect(button().getAttribute('aria-label')).toBe('Play call audio')
      expect(toastMock).toHaveBeenCalledWith('The audio is slow to load. Press play to try again.')
      expect(m.el.getAttribute('src')).toBeNull()
      // The element now says 0; the row says where it stopped.
      m.position = 0
      await fire(m.el, 'timeupdate')
      expect(shown()).toBe('20:00 / 42:05')
      answers[0]()
      await act(async () => void (await vi.advanceTimersByTimeAsync(0)))
      expect(m.el.getAttribute('src')).toBeNull()
      expect(button().getAttribute('aria-label')).toBe('Play call audio')
      await press() // Play: a fresh link, held too
      expect(requests.filter((r) => r.includes('as=play'))).toHaveLength(3)
      answers[1]()
      await act(async () => void (await vi.advanceTimersByTimeAsync(0)))
      expect(m.el.getAttribute('src')).toContain('token=held-3')
      await fire(m.el, 'loadedmetadata')
      expect(m.plays.at(-1)).toBe(1200)
      expect(button().getAttribute('aria-label')).toBe('Pause call audio')
    } finally {
      vi.useRealTimers()
    }
  })

  it('two give-ups in a row keep the place: Play goes on from it, and it is shown meanwhile', async () => {
    files = [ready]
    await mount(team)
    const m = media()
    await press()
    await tick()
    await fire(m.el, 'loadedmetadata')
    m.position = 1200
    // Links 2 and 3 are refused.
    vi.stubGlobal('fetch', async (url: string) => {
      requests.push(url)
      const n = requests.filter((r) => r.includes('as=play')).length
      if (n === 2 || n === 3) return new Response('{}', { status: 500 })
      return new Response(JSON.stringify({ url: `https://sb.example.test/x?token=link-${n}`, expiresIn: 3600 }))
    })
    await fire(m.el, 'error') // link 1 failed: renewal, refused
    await tick()
    expect(toastMock).toHaveBeenCalledTimes(1)
    m.position = 0 // the source removed
    await fire(m.el, 'timeupdate')
    expect(shown()).toBe('20:00 / 42:05')
    await press() // Play: renewal from 20:00, refused again
    await tick()
    expect(toastMock).toHaveBeenCalledTimes(2)
    expect(button().getAttribute('aria-label')).toBe('Play call audio')
    expect(shown()).toBe('20:00 / 42:05')
    await press() // Play: link 4 works
    await tick()
    expect(m.el.getAttribute('src')).toContain('token=link-4')
    await fire(m.el, 'loadedmetadata')
    expect(m.plays.at(-1)).toBe(1200)
  })

  it('Pause while a renewal’s link is on its way: the wait is dropped, no line, the place kept; the late answer changes nothing', async () => {
    files = [ready]
    await mount(team)
    const m = media()
    await press()
    await tick()
    await fire(m.el, 'loadedmetadata')
    m.position = 1800
    const answers = heldPlayLinks()
    later(3_600_000)
    await fire(m.el, 'stalled')
    expect(button().getAttribute('aria-label')).toBe('Pause call audio')
    await press() // Pause
    expect(button().getAttribute('aria-label')).toBe('Play call audio')
    expect(toastMock).not.toHaveBeenCalled()
    expect(shown()).toBe('30:00 / 42:05')
    answers[0]()
    await tick()
    expect(m.el.getAttribute('src')).toBeNull()
    expect(button().getAttribute('aria-label')).toBe('Play call audio')
    await press() // Play: a fresh link, on from the same place
    answers[1]()
    await tick()
    expect(m.el.getAttribute('src')).toContain('token=held-3')
    await fire(m.el, 'loadedmetadata')
    expect(m.plays.at(-1)).toBe(1800)
  })

  it('a move along the bar on a dead link, then WebKit’s stall from the old place while the fresh link comes: on from where it was moved to', async () => {
    files = [ready]
    await mount(team)
    const m = media()
    await press()
    await tick()
    await fire(m.el, 'loadedmetadata')
    m.position = 3
    const answers = heldPlayLinks()
    later(3_600_000)
    await moveTo(1200) // a renewal from 20:00; the element still says 3 s
    await fire(m.el, 'stalled')
    await fire(m.el, 'waiting')
    answers[0]()
    await tick()
    expect(m.el.getAttribute('src')).toContain('token=held-2')
    await fire(m.el, 'loadedmetadata')
    expect(Math.abs(m.plays.at(-1)! - 1200)).toBeLessThan(3)
    expect(requests.filter((r) => r.includes('as=play'))).toHaveLength(2)
  })

  it('clock: minutes and seconds, hours when there are any', () => {
    expect(clock(0)).toBe('0:00')
    expect(clock(65_000)).toBe('1:05')
    expect(clock(3_725_000)).toBe('1:02:05')
  })
})
