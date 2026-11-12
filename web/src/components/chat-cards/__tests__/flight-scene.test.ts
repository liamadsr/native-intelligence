// @vitest-environment jsdom
/**
 * What moves with a card's flight to and from its tile (flight-scene.ts;
 * Liam, 11-11: "it's not a fliker now but the panel is transparent and you
 * see thorugh it and looks broken, the over all transition even with the
 * sub-nav needs to be updated to be smoother the entire open sequence needs
 * to happen smoother"): home leaves before the growing window is over it and
 * arrives as it lands, the page panel that is about to change hands leaves
 * with the window's first move, and every fade is given back to the app's
 * own rules.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { holdFrontCard } from '../front-card'
import { SCENE_ARRIVE_MS, SCENE_GIVE_UP_MS, SCENE_LEAVE_MS, UNDER_CARD_SELECTORS, homeArrives, homeLeaves, pagePanelOnScreen, panelLeaves } from '../flight-scene'
import type { CardSpec } from '@/lib/chat-cards/kinds'

const SPEC = { kind: 'list', title: 'Due this week' } as unknown as CardSpec

interface Played {
  el: Element
  keyframes: Keyframe[]
  options: KeyframeAnimationOptions
  cancel: ReturnType<typeof vi.fn>
}
let played: Played[]
let reduced: boolean
let releases: Array<() => void>

beforeEach(() => {
  vi.useFakeTimers()
  played = []
  releases = []
  reduced = false
  window.matchMedia = ((q: string) => ({ matches: q.includes('reduce') ? reduced : false })) as unknown as typeof window.matchMedia
  ;(HTMLElement.prototype as unknown as { animate: unknown }).animate = function (this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
    const cancel = vi.fn()
    played.push({ el: this, keyframes, options, cancel })
    return { cancel, finished: new Promise(() => {}) }
  }
  // The shell as dashboard-shell.tsx and chat-panel.tsx draw it.
  document.body.innerHTML = `
    <div data-shell-top-bar id="top-bar"></div>
    <div data-windows-row>
      <div data-fading-blur="down" id="row-blur"></div>
      <div id="ni-chat-strip-slot">
        <div data-chat-thread-stage id="thread"></div>
        <div data-chat-composer-dock id="dock"><div data-fading-blur id="blur"></div><div data-chat-composer id="composer"></div></div>
      </div>
      <aside data-page-panel="home" data-page-panel-mode="off" id="home-panel"><div data-page-panel-card id="home-card"></div></aside>
      <aside data-page-panel="team-chat" data-page-panel-mode="room" id="team-panel"><div data-page-panel-card id="team-card"></div></aside>
      <aside data-side-panel id="side-panel"></aside>
    </div>`
})

afterEach(() => {
  for (const release of releases) release()
  vi.useRealTimers()
  document.body.innerHTML = ''
  delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate
})

const hold = () => {
  const release = holdFrontCard({ id: 'card', spec: SPEC, close: () => {} })
  releases.push(release)
  return release
}
const ids = () => played.map((p) => p.el.id).sort()
/** What an open card hides: the top bar, the thread, the row's other children. Never the composer, its frosted strip, the page panels or the strip itself. */
const UNDER = ['side-panel', 'thread', 'top-bar']

describe('what an open card hides', () => {
  it('is what tailwind.css stops painting under a card beside the rail, selector for selector', () => {
    const css = readFileSync(resolve(__dirname, '../../../styles/tailwind.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const hidden: string[] = []
    for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      if (!/visibility:\s*hidden/.test(m[2]) || !/opacity:\s*0\s*;/.test(m[2])) continue
      for (const sel of m[1].split(',')) {
        const s = sel.trim()
        if (s.startsWith('html[data-app-rail][data-card-front] ')) hidden.push(s.slice('html[data-app-rail][data-card-front] '.length))
      }
    }
    expect(hidden.sort()).toEqual([...UNDER_CARD_SELECTORS].sort())
  })
})

describe('opening: home leaves with the window’s first move', () => {
  it('fades out what the card will hide, fast, and holds it out until the card is in front; then lets go (its CSS hides it from there)', () => {
    homeLeaves()
    expect(ids()).toEqual(UNDER)
    for (const p of played) {
      // To clear from wherever it stands, and held there.
      expect(p.keyframes).toEqual([{ opacity: 0, offset: 1 }])
      expect(p.options).toMatchObject({ duration: SCENE_LEAVE_MS, fill: 'forwards' })
      expect(p.cancel).not.toHaveBeenCalled()
    }
    // Gone before the growing window is over it.
    expect(SCENE_LEAVE_MS).toBeLessThanOrEqual(120)
    hold()
    for (const p of played) expect(p.cancel).toHaveBeenCalledTimes(1)
    // Not let go twice.
    vi.advanceTimersByTime(SCENE_GIVE_UP_MS * 2)
    for (const p of played) expect(p.cancel).toHaveBeenCalledTimes(1)
  })

  it('a card that never came (it was no more): home is given back, by its release or by itself', () => {
    const release = homeLeaves()
    release()
    for (const p of played) expect(p.cancel).toHaveBeenCalledTimes(1)
    played = []
    homeLeaves()
    vi.advanceTimersByTime(SCENE_GIVE_UP_MS)
    expect(played.length).toBeGreaterThan(0)
    for (const p of played) expect(p.cancel).toHaveBeenCalledTimes(1)
  })

  it('nothing with a card already in front, or under reduced motion', () => {
    hold()
    homeLeaves()
    expect(played).toHaveLength(0)
    releases.pop()!()
    reduced = true
    homeLeaves()
    homeArrives()
    panelLeaves()
    expect(played).toHaveLength(0)
  })
})

describe('closing: home arrives as the window lands', () => {
  it('waits for the card to leave full screen, then fades in from clear in that same commit, to each thing’s own opacity, nothing kept after', () => {
    const release = hold()
    homeArrives()
    // Hidden by CSS until the card leaves: nothing to fade yet.
    expect(played).toHaveLength(0)
    release()
    expect(ids()).toEqual(UNDER)
    for (const p of played) {
      // From clear to its own opacity (no end keyframe: nothing is forced visible), and nothing held after.
      expect(p.keyframes).toEqual([{ opacity: 0, offset: 0 }])
      expect(p.options).toMatchObject({ duration: SCENE_ARRIVE_MS, delay: 0, fill: 'backwards' })
    }
    // Once: a later card coming and going starts nothing.
    hold()()
    expect(played).toHaveLength(UNDER.length)
  })

  it('at once with no card in front (a card that left before its flight began), held clear for `delay` while the window flies off it', () => {
    homeArrives({ delay: 90 })
    expect(ids()).toEqual(UNDER)
    for (const p of played) expect(p.options).toMatchObject({ delay: 90, fill: 'backwards' })
  })

  it('a card that never left: the wait is given up', () => {
    const release = hold()
    homeArrives()
    vi.advanceTimersByTime(SCENE_GIVE_UP_MS)
    release()
    expect(played).toHaveLength(0)
  })
})

describe('the page panel changing hands', () => {
  it('knows the panel on screen', () => {
    expect(pagePanelOnScreen()).toBe('team-chat')
    document.getElementById('team-panel')!.setAttribute('data-page-panel-mode', 'off')
    expect(pagePanelOnScreen()).toBeNull()
  })

  it('its card fades out with the window’s first move, and is let go the moment its frame is off (the swap)', async () => {
    panelLeaves()
    expect(played).toHaveLength(1)
    expect(played[0].el.id).toBe('team-card')
    expect(played[0].keyframes).toEqual([{ opacity: 0, offset: 1 }])
    expect(played[0].options).toMatchObject({ duration: SCENE_LEAVE_MS, fill: 'forwards' })
    document.getElementById('team-panel')!.setAttribute('data-page-panel-mode', 'off')
    await Promise.resolve()
    expect(played[0].cancel).toHaveBeenCalledTimes(1)
  })

  it('a swap that never came: it shows again', () => {
    panelLeaves()
    vi.advanceTimersByTime(SCENE_GIVE_UP_MS)
    expect(played[0].cancel).toHaveBeenCalledTimes(1)
    // No panel on screen: nothing to fade.
    played = []
    document.getElementById('team-panel')!.setAttribute('data-page-panel-mode', 'off')
    panelLeaves()
    expect(played).toHaveLength(0)
  })
})
