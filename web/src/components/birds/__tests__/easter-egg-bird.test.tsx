// @vitest-environment jsdom
/**
 * The voice bird on screen (EasterEggBird), with useWatched stubbed.
 *
 * Pinned:
 *  - away: nothing rendered, no listener, no timer;
 *  - here: one small labelled button in a fixed layer on body, the agent's
 *    bot (agent-bot.tsx; `bot-avatars` stubbed) perched on the main
 *    composer's top edge; a click sends it away (voice mode ends);
 *  - it leaves when voice mode ends;
 *  - hops: one timer at a time only while watched, none unwatched (the bot
 *    paused), none under reduced motion (it sits on the composer);
 *  - a hop goes to another perch (the top bar, the column) and lands on its
 *    transition's end;
 *  - it works while the agent thinks, and idles otherwise.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const watch = vi.hoisted(() => ({ on: true, calls: [] as unknown[][] }))
vi.mock('@/hooks/use-watched', () => ({
  useWatched: (...args: unknown[]) => {
    watch.calls.push(args)
    return watch.on
  },
}))

vi.mock('bot-avatars', async () => {
  const { createElement } = await import('react')
  return {
    BotAvatar: (p: Record<string, unknown>) =>
      createElement('canvas', { 'data-stub-bot': p.type, 'data-state': p.state, 'data-paused': String(!!p.paused) }),
  }
})

/** ResizeObserver: what it watches, its callback, and whether it was let go. */
const ro = vi.hoisted(() => ({ observed: [] as Element[], callbacks: [] as Array<() => void>, disconnects: 0 }))

import { EasterEggBird, HOP_MIN_MS, HOP_SPREAD_MS, nextPerch, VOICE_BIRD_SIZE, VOICE_BOT_BURST_MS } from '../easter-egg-bird'
import { DEFAULT_AGENT_LOOK, agentLookFeet } from '@/lib/bots/agent-look'
import { __resetAgentLookForTests, saveAgentLook } from '@/lib/bots/agent-look-store'

const FEET_Y = agentLookFeet(DEFAULT_AGENT_LOOK).y
import { VOICE_BIRD_EVENT, __resetVoiceBirdForTests, parseVoiceBirdDetail, reportMainVoice, toggleVoiceBird } from '../voice-bird'

let container: HTMLDivElement
let root: Root
let composer: HTMLDivElement
let bar: HTMLDivElement
let ends: number
const host = (e: Event) => {
  const d = parseVoiceBirdDetail((e as CustomEvent).detail)!
  if (d.action === 'end') {
    ends++
    reportMainVoice(false, null)
    return
  }
  d.take()
  reportMainVoice(true, 'listening')
  d.onResult(true)
}

function rect(el: HTMLElement, r: { left: number; top: number; width: number; height: number }) {
  el.getBoundingClientRect = () =>
    ({ ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON: () => ({}) }) as DOMRect
}

function setReducedMotion(on: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: on && q.includes('reduce'), addEventListener() {}, removeEventListener() {} }))
}

const layer = () => document.body.querySelector('[data-voice-bird]') as HTMLDivElement | null
const bird = () => document.body.querySelector('button[aria-label="Voice bird: click to send it away"]') as HTMLButtonElement | null
const translate = () => layer()!.style.transform
const bot = () => document.body.querySelector('[data-voice-bird] canvas[data-stub-bot]') as HTMLCanvasElement | null

async function mount() {
  await act(async () => root.render(h(EasterEggBird)))
}

async function hatch() {
  await act(async () => toggleVoiceBird({ canHatch: true }))
  // The bot's renderer, fetched on its first mount.
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

beforeEach(() => {
  __resetVoiceBirdForTests()
  window.localStorage.clear()
  __resetAgentLookForTests()
  // The account takes every look saved (the profile PATCH).
  vi.stubGlobal('fetch', async () => new Response('{"success":true}'))
  watch.on = true
  watch.calls = []
  ro.observed = []
  ro.callbacks = []
  ro.disconnects = 0
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: () => void) {
        ro.callbacks.push(cb)
      }
      observe(el: Element) {
        ro.observed.push(el)
      }
      unobserve() {}
      disconnect() {
        ro.disconnects++
      }
    },
  )
  ends = 0
  setReducedMotion(false)
  window.addEventListener(VOICE_BIRD_EVENT, host)
  composer = document.createElement('div')
  composer.setAttribute('data-chat-input-root', '')
  rect(composer, { left: 200, top: 600, width: 600, height: 100 })
  bar = document.createElement('div')
  bar.setAttribute('data-shell-top-bar', '')
  rect(bar, { left: 0, top: 0, width: 1000, height: 48 })
  document.body.append(composer, bar)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  composer.remove()
  bar.remove()
  window.removeEventListener(VOICE_BIRD_EVENT, host)
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('away', () => {
  it('renders nothing, and adds no listener and no timer', async () => {
    const listen = vi.spyOn(window, 'addEventListener')
    const timer = vi.spyOn(globalThis, 'setTimeout')
    await mount()
    expect(layer()).toBeNull()
    expect(listen).not.toHaveBeenCalled()
    expect(timer).not.toHaveBeenCalled()
  })
})

describe('here', () => {
  it('hatches on the composer’s top edge: a small labelled button on body', async () => {
    await mount()
    await hatch()
    expect(bird()).not.toBeNull()
    expect(layer()!.parentElement).toBe(document.body)
    expect(layer()!.dataset.perch).toBe('composer')
    expect(layer()!.style.width).toBe(`${VOICE_BIRD_SIZE}px`)
    // Feet on the composer's top edge (top 600, a hair in), within its width.
    const [, x, y] = translate().match(/translate3d\((-?\d+)px, (-?\d+)px/)!.map(Number)
    expect(Math.abs(y + VOICE_BIRD_SIZE * FEET_Y - 605)).toBeLessThan(1)
    expect(x).toBeGreaterThan(200)
    expect(x + VOICE_BIRD_SIZE).toBeLessThan(800)
    // Only the bird takes the pointer.
    expect(layer()!.className).toContain('pointer-events-none')
    expect(bird()!.className).toContain('pointer-events-auto')
    // The agent's bot, moving while watched.
    expect(bot()!.getAttribute('data-stub-bot')).toBe(DEFAULT_AGENT_LOOK.type)
    expect(bot()!.getAttribute('data-paused')).toBe('false')
  })

  it('stands on its look’s own base: another shape, other feet', async () => {
    await mount()
    await hatch()
    await act(async () => void (await saveAgentLook({ ...DEFAULT_AGENT_LOOK, type: 'pill' })))
    const [, , y] = translate().match(/translate3d\((-?\d+)px, (-?\d+)px/)!.map(Number)
    expect(Math.abs(y + VOICE_BIRD_SIZE * agentLookFeet({ type: 'pill' }).y - 605)).toBeLessThan(1)
    expect(bot()!.getAttribute('data-stub-bot')).toBe('pill')
  })

  it('a click sends it away and ends voice mode', async () => {
    await mount()
    await hatch()
    await act(async () => bird()!.click())
    expect(ends).toBe(1)
    expect(layer()).toBeNull()
  })

  it('leaves when voice mode ends', async () => {
    await mount()
    await hatch()
    await act(async () => reportMainVoice(false, null))
    expect(layer()).toBeNull()
    expect(ends).toBe(0)
  })

  it('is watched without the input rule: hands-free voice never puts it to sleep', async () => {
    await mount()
    await hatch()
    expect(watch.calls.length).toBeGreaterThan(0)
    for (const call of watch.calls) expect(call).toEqual([true, { idle: false }])
  })

  it('a layout shift of the composer or the top bar re-measures its perch; let go when it leaves', async () => {
    await mount()
    await hatch()
    expect(ro.observed).toEqual(expect.arrayContaining([composer, bar]))
    const before = translate()
    rect(composer, { left: 200, top: 400, width: 600, height: 100 })
    await act(async () => ro.callbacks.at(-1)!())
    expect(translate()).not.toBe(before)
    const [, , y] = translate().match(/translate3d\((-?\d+)px, (-?\d+)px/)!.map(Number)
    expect(Math.abs(y + VOICE_BIRD_SIZE * FEET_Y - 405)).toBeLessThan(1)
    await act(async () => reportMainVoice(false, null))
    expect(ro.disconnects).toBeGreaterThan(0)
  })

  it('reacts to voice mode: at work while the agent thinks, idle while it listens or speaks', async () => {
    await mount()
    await hatch()
    expect(bot()!.getAttribute('data-state')).toBe('default')
    await act(async () => reportMainVoice(true, 'thinking'))
    expect(bot()!.getAttribute('data-state')).toBe('working')
    await act(async () => reportMainVoice(true, 'speaking'))
    expect(bot()!.getAttribute('data-state')).toBe('default')
  })
})

describe('hops', () => {
  it('only while watched: one timer, a hop to another perch, a landing on the transition’s end', async () => {
    vi.useFakeTimers()
    await mount()
    await hatch()
    const before = translate()
    await act(async () => vi.advanceTimersByTime(HOP_MIN_MS + HOP_SPREAD_MS))
    expect(layer()!.dataset.perch).not.toBe('composer')
    expect(translate()).not.toBe(before)
    expect(layer()!.hasAttribute('data-flying')).toBe(true)
    await act(async () => {
      const ev = new Event('transitionend', { bubbles: true }) as Event & { propertyName: string }
      Object.defineProperty(ev, 'propertyName', { value: 'transform' })
      layer()!.dispatchEvent(ev)
    })
    expect(layer()!.hasAttribute('data-flying')).toBe(false)
    // The bot's short burst for the hop it made (agent-bot.tsx), then still.
    expect(bot()!.getAttribute('data-paused')).toBe('false')
    await act(async () => vi.advanceTimersByTime(VOICE_BOT_BURST_MS))
    expect(bot()!.getAttribute('data-paused')).toBe('true')
    // The next hop comes on its own timer: another perch.
    const was = layer()!.dataset.perch
    await act(async () => vi.advanceTimersByTime(HOP_MIN_MS + HOP_SPREAD_MS))
    expect(layer()!.dataset.perch).not.toBe(was)
  })

  it('unwatched: no timer, the bot paused', async () => {
    watch.on = false
    vi.useFakeTimers()
    await mount()
    await hatch()
    expect(vi.getTimerCount()).toBe(0)
    expect(bot()!.getAttribute('data-paused')).toBe('true')
    await act(async () => vi.advanceTimersByTime(60_000))
    expect(layer()!.dataset.perch).toBe('composer')
  })

  it('reduced motion: sits still on the composer, no timer, no transition', async () => {
    setReducedMotion(true)
    vi.useFakeTimers()
    await mount()
    await hatch()
    expect(vi.getTimerCount()).toBe(0)
    expect(layer()!.style.transition).toBe('none')
    await act(async () => vi.advanceTimersByTime(60_000))
    expect(layer()!.dataset.perch).toBe('composer')
  })

  it('nextPerch never picks the perch it is on', () => {
    for (const r of [0, 0.3, 0.6, 0.99]) {
      expect(nextPerch('composer', () => r).kind).not.toBe('composer')
      expect(nextPerch('topBar', () => r).kind).not.toBe('topBar')
    }
  })
})
