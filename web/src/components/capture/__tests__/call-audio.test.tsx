// @vitest-environment jsdom
/**
 * A call's audio in its capture's properties (src/components/capture/call-audio.tsx):
 * a capture a call's recorder did not fill asks nothing and draws nothing; a
 * kept file has Play and Download and says the day it will be deleted, and no
 * link is asked for before Play or Download is pressed; a deleted file says
 * the day it was, with nothing to play; one on its way says so; several are
 * named by part, each with its own day when their days differ; a link that
 * runs out while it plays is renewed and the sound goes on where it was, as
 * often as that happens.
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

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  requests = []
  opened.urls = []
  files = []
  vi.stubGlobal('fetch', async (url: string) => {
    requests.push(url)
    if (url.includes('as=download')) return new Response(JSON.stringify({ url: 'https://sb.example.test/storage/v1/object/sign/x?token=t&download=Call%20audio.m4a' }))
    if (url.includes('as=play')) return new Response(JSON.stringify({ url: `https://sb.example.test/storage/v1/object/sign/x?token=link-${requests.filter((r) => r.includes('as=play')).length}` }))
    return new Response(JSON.stringify({ files }))
  })
})
afterEach(() => {
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

  it('clock: minutes and seconds, hours when there are any', () => {
    expect(clock(0)).toBe('0:00')
    expect(clock(65_000)).toBe('1:05')
    expect(clock(3_725_000)).toBe('1:02:05')
  })
})
