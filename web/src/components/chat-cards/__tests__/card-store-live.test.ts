// @vitest-environment jsdom
/**
 * What a card in front says of itself when a turn is sent (card-store.ts
 * provideLive, settle, putBackForSend): read at send time only, only from the
 * card the person is looking at, and after it settled (the Studio saves its
 * edits), within a bound. Fixtures are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatCardStore } from '../card-store'
import type { CardSpec } from '@/lib/chat-cards/kinds'
import type { StudioNote } from '@/lib/chat-cards/studio-note'

const STUDIO = { kind: 'studio', title: 'Studio' } as CardSpec
const CAL = { kind: 'calendar', title: 'This week', calendar: { view: 'week', from: '2026-11-09', to: '2026-11-15' } } as CardSpec
const note = (t: number): StudioNote => ({ v: { id: 'video-1', title: 'Hello Studio' }, page: 'edit', t })

function store(opts: { opened?: boolean } = {}) {
  const s = new ChatCardStore()
  s.setCards([
    { id: 'cal', spec: CAL, opened: true },
    { id: 'studio', spec: STUDIO, ...(opts.opened ? { opened: true } : {}) },
  ])
  return s
}
const studioOf = (s: ChatCardStore) => s.contextEntries().find((e) => e.id === 'studio')?.studio

beforeEach(() => window.localStorage.clear())
afterEach(() => vi.useRealTimers())

describe('a card’s live detail', () => {
  it('is read when the turn’s cards are, never kept ahead: what changed since is what goes', () => {
    const s = store()
    let t = 0
    const read = vi.fn(() => ({ studio: note(t) }))
    s.provideLive('studio', { read })
    expect(read).not.toHaveBeenCalled()
    const version = s.getVersion()
    // The playhead moving, frame after frame: the card tells the store nothing, and nothing redraws.
    for (let frame = 0; frame < 120; frame++) t = frame / 60
    expect(read).not.toHaveBeenCalled()
    expect(s.getVersion()).toBe(version)
    t = 7.5
    expect(studioOf(s)).toEqual(note(7.5))
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('only from the card in front: full screen; with none, one open in the thread; never one put away or behind another', () => {
    const s = store({ opened: true })
    s.provideLive('studio', { read: () => ({ studio: note(1) }) })
    // An opened page not full screen is put away (the tile, or parked).
    expect(studioOf(s)).toBeUndefined()
    s.enterFullScreen('studio')
    expect(studioOf(s)).toEqual(note(1))
    s.enterFullScreen('cal')
    expect(studioOf(s)).toBeUndefined()
    s.exitFullScreen()
    expect(studioOf(s)).toBeUndefined()

    const inline = store()
    inline.provideLive('studio', { read: () => ({ studio: note(2) }) })
    expect(studioOf(inline)).toEqual(note(2))
    inline.collapse('studio')
    expect(studioOf(inline)).toBeUndefined()
  })

  it('the composer’s send puts the card back but it stays the one the turn is about, until another comes in front', () => {
    const s = store({ opened: true })
    s.provideLive('studio', { read: () => ({ studio: note(3) }) })
    s.enterFullScreen('studio')
    s.putBackForSend()
    expect(s.fullScreen()).toBeNull()
    const entry = s.contextEntries().find((e) => e.id === 'studio')!
    expect(entry.studio).toEqual(note(3))
    expect(entry.fs).toBe(true)
    s.enterFullScreen('cal')
    s.exitFullScreen()
    expect(studioOf(s)).toBeUndefined()
  })

  it('a reader that throws or a card gone says nothing, and the turn still has its cards', () => {
    const s = store()
    const stop = s.provideLive('studio', {
      read: () => {
        throw new Error('editor gone')
      },
    })
    expect(s.contextEntries()).toHaveLength(2)
    expect(studioOf(s)).toBeUndefined()
    stop()
    s.provideLive('studio', { read: () => ({ studio: note(4) }) })
    expect(studioOf(s)).toEqual(note(4))
  })
})

describe('settle before the read', () => {
  it('waits for the card in front to finish (the Studio’s save), and only that card', async () => {
    const s = store()
    let saved = false
    const settle = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      saved = true
    })
    const behind = vi.fn(async () => {})
    s.provideLive('studio', { read: () => ({ studio: { ...note(1), ...(saved ? {} : { dirty: true as const }) } }), settle })
    s.provideLive('cal', { read: () => null, settle: behind })
    await s.settle()
    expect(settle).toHaveBeenCalledTimes(1)
    expect(behind).not.toHaveBeenCalled()
    expect(studioOf(s)?.dirty).toBeUndefined()
  })

  it('is bounded: a save that hangs does not hold the send, and a failing one does not fail it', async () => {
    vi.useFakeTimers()
    const s = store()
    s.provideLive('studio', { read: () => null, settle: () => new Promise(() => {}) })
    const done = s.settle(4000)
    await vi.advanceTimersByTimeAsync(4000)
    await expect(done).resolves.toBeUndefined()
    s.provideLive('studio', { read: () => null, settle: () => Promise.reject(new Error('offline')) })
    await expect(s.settle()).resolves.toBeUndefined()
  })

  it('nothing in front to settle: returns at once', async () => {
    const s = store({ opened: true })
    const settle = vi.fn(async () => {})
    s.provideLive('studio', { read: () => null, settle })
    await s.settle()
    expect(settle).not.toHaveBeenCalled()
  })
})
