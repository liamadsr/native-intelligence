// @vitest-environment jsdom
/**
 * The minimized card's own flight (tile-flight.ts; Liam, 11-11: "its better
 * but the animation isnt as smooth", "it goes over the sub-menu and looks
 * clunky", "match the speed and motion to the search panel cmd+k panel",
 * "it like flikers when it goes to the bottom left", and at 160ms "so fast
 * that it feels glitch"): round the page panel, the ⌘K palette's curve over
 * MINIMIZE_FLIGHT_MS, no settle, one copy, transform and opacity only, the
 * tile shown in the very frame the copy goes. And as one sequence (Liam,
 * 11-11: "it lands at the bottom square then the borders get around", "the
 * entire open sequence needs to happen smoother"): the copy lands in the box
 * inside the tile's border wearing the tile's edge and shadow, and the card
 * changes hands half way through the flight, not after it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PALETTE_ENTRANCE_EASING } from '@/lib/motion/palette-entrance'
import { FLIGHT_GLASS_CLASS, SEARCH_FLIGHT_MS, applyCopyScroll, coverScale, reversedFrames, stillCopyOf, type FlightRect } from '../card-reply-flight'
import {
  MINIMIZE_FLIGHT_MS,
  TILE_FLIGHT_EASING,
  TILE_HANDOFF_MS,
  __resetTileFlightForTests,
  composerObstacle,
  flightCopyOf,
  flyIntoTile,
  landTileFlight,
  landTileHome,
  launchIntoTile,
  launchTileFlight,
  obstacleClip,
  outlineProgress,
  panelClip,
  scaledShadow,
  tileClipFrames,
  tileCorner,
  tileEndOf,
  tileFlightFrames,
  tileInnerBox,
  tilePathPoint,
  tileRingFrames,
  type FlightObstacle,
  type TileEnd,
} from '../tile-flight'

/** 1440×900: the frame right of the page panel, the tile under the panel's column. */
const FRAME: FlightRect = { left: 428, top: 50, width: 948, height: 730 }
const TILE: FlightRect = { left: 64, top: 703, width: 296, height: 185 }
const PANEL: FlightObstacle = { left: 64, top: 50, right: 360, bottom: 563 }
/** The tile's end of a flight: its box, its 1px edge, its 24px corners, its shadow. */
const END: TileEnd = { rect: TILE, border: 1, radius: 24, edge: 'rgb(1, 2, 3)', shadow: 'rgba(0, 0, 0, 0.08) 0px 4px 6px -1px' }
/** Where the tile draws its preview: inside its border. */
const INNER: FlightRect = { left: 65, top: 704, width: 294, height: 183 }

const parse = (transform: string) => {
  const m = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(transform)!
  return { x: Number(m[1]), y: Number(m[2]), s: Number(m[3]) }
}

describe('the path round the page panel', () => {
  it('drops in the card’s column first, rounds a corner below the panel and runs left into the tile, arriving level', () => {
    const from = { x: FRAME.left, y: FRAME.top }
    const to = { x: TILE.left, y: TILE.top }
    const r = tileCorner(from, to, PANEL)
    expect(r).toBeGreaterThan(0)
    expect(tilePathPoint(from, to, r, 0)).toEqual(from)
    const end = tilePathPoint(from, to, r, 1)
    expect(end.x).toBeCloseTo(to.x, 6)
    expect(end.y).toBeCloseTo(to.y, 6)
    // Straight down at first, straight across at the end.
    expect(tilePathPoint(from, to, r, 0.2).x).toBe(from.x)
    expect(tilePathPoint(from, to, r, 0.95).y).toBeCloseTo(to.y, 6)
    // Never over the panel: right of it until below it.
    for (let i = 0; i <= 200; i++) {
      const p = tilePathPoint(from, to, r, i / 200)
      expect(p.x >= PANEL.right || p.y >= PANEL.bottom, `q=${i / 200}`).toBe(true)
    }
  })

  it('takes a softer corner where there is room, a tighter one where the panel comes close', () => {
    const from = { x: FRAME.left, y: FRAME.top }
    const to = { x: TILE.left, y: TILE.top }
    const free = tileCorner(from, to, null)
    expect(free).toBeCloseTo(0.6 * (FRAME.left - TILE.left), 6)
    // The room below the panel (140px) or right of it (68px): the larger.
    expect(tileCorner(from, to, PANEL)).toBe(140)
    // A panel down to just above the tile and close on the right: 20px of room, a 20px corner.
    expect(tileCorner(from, to, { ...PANEL, bottom: TILE.top - 10, right: FRAME.left - 20 })).toBe(20)
  })

  it('minimize: keyframes from the frame at scale 1 to the preview’s rectangle in the tile, every one right of the panel or below it', () => {
    const frames = tileFlightFrames(FRAME, TILE, PANEL)
    expect(frames[0]).toEqual({ offset: 0, transform: `translate(${FRAME.left}px, ${FRAME.top}px) scale(1)` })
    const s = coverScale(FRAME.width, FRAME.height, TILE.width, TILE.height)
    const last = parse(frames.at(-1)!.transform)
    expect(frames.at(-1)!.offset).toBe(1)
    expect(last.x).toBeCloseTo(TILE.left + (TILE.width - FRAME.width * s) / 2, 1)
    expect(last.y).toBeCloseTo(TILE.top, 1)
    expect(last.s).toBeCloseTo(s, 4)
    for (const f of frames) {
      const { x, y } = parse(f.transform)
      expect(x >= PANEL.right || y >= PANEL.bottom, f.transform).toBe(true)
    }
    // It shrinks as it goes.
    const scales = frames.map((f) => parse(f.transform).s)
    expect(scales.every((v, i) => i === 0 || v <= scales[i - 1])).toBe(true)
    // Transform only: no opacity beside it (a second opacity effect would take both off the compositor).
    expect(frames.every((f) => Object.keys(f).sort().join() === 'offset,transform')).toBe(true)
  })

  it('restore: the same keyframes backwards (out of the tile along the bottom, then up into place)', () => {
    const frames = reversedFrames(tileFlightFrames(FRAME, TILE, PANEL))
    expect(parse(frames[0].transform).y).toBeCloseTo(TILE.top, 1)
    expect(frames.at(-1)!.transform).toBe(`translate(${FRAME.left}px, ${FRAME.top}px) scale(1)`)
    // Along the bottom first: the second keyframe is still level with the tile, further right.
    expect(parse(frames[1].transform).y).toBeCloseTo(TILE.top, 1)
    expect(parse(frames[1].transform).x).toBeGreaterThan(parse(frames[0].transform).x)
  })

  it('the outline: leaves with the frame’s box and corners, lands with the tile’s (24px on screen all the way, cut at the foot)', () => {
    const s = coverScale(FRAME.width, FRAME.height, TILE.width, TILE.height)
    const clips = tileClipFrames(FRAME, TILE, { frame: 24, tile: 24 })
    expect(clips[0]).toEqual({ offset: 0, clipPath: 'inset(0px 0px 0px 0px round 24px)' })
    const end = /inset\(0px ([\d.]+)px ([\d.]+)px [\d.]+px round ([\d.]+)px\)/.exec(clips.at(-1)!.clipPath)!.slice(1).map(Number)
    // On screen: the tile's height (the foot cut), its width (no side cut here), its 24px corners.
    expect((FRAME.height - end[1]) * s).toBeCloseTo(TILE.height, 0)
    expect(end[0]).toBe(0)
    expect(end[2] * s).toBeCloseTo(24, 1)
    // Same offsets as the move, so one clock.
    expect(clips.map((c) => c.offset)).toEqual(tileFlightFrames(FRAME, TILE, PANEL).map((f) => f.offset))
    for (const [i, c] of clips.entries()) {
      const q = i / (clips.length - 1)
      const r = Number(/round ([\d.]+)px/.exec(c.clipPath)![1])
      expect(r * (1 + (s - 1) * q)).toBeCloseTo(24, 1)
    }
  })

  it('the flyer’s clip leaves out the panel (everything but its rectangle)', () => {
    const clip = panelClip(PANEL)
    expect(clip.startsWith('polygon(evenodd,')).toBe(true)
    expect(clip).toContain('64px 50px, 360px 50px, 360px 563px, 64px 563px, 64px 50px')
  })

  it('and whatever else the window passes behind (the composer): one closed path, back to the outer corner after each hole; none, no clip', () => {
    const composer: FlightObstacle = { left: 470, top: 830, right: 1090, bottom: 880 }
    const clip = obstacleClip([PANEL, composer])
    expect(clip).toContain('64px 50px, 360px 50px, 360px 563px, 64px 563px, 64px 50px, -100000px -100000px, 470px 830px, 1090px 830px, 1090px 880px, 470px 880px, 470px 830px, -100000px -100000px)')
    expect(obstacleClip([])).toBe('none')
    expect(panelClip(PANEL)).toBe(obstacleClip([PANEL]))
  })

  it('lands inside the tile’s border, where the tile draws its preview', () => {
    expect(tileInnerBox(END)).toEqual(INNER)
    expect(tileInnerBox({ ...END, border: 0 })).toEqual(TILE)
    const s = coverScale(FRAME.width, FRAME.height, INNER.width, INNER.height)
    const last = parse(tileFlightFrames(FRAME, INNER, PANEL).at(-1)!.transform)
    expect(last.x).toBeCloseTo(INNER.left + (INNER.width - FRAME.width * s) / 2, 1)
    expect(last.y).toBeCloseTo(INNER.top, 1)
  })

  it('the tile’s edge rides with it: round the clip at every step, 1px and 24px on screen all the way, on the tile’s own border box as it lands (Liam, 11-11: "it lands at the bottom square then the borders get around")', () => {
    const s = coverScale(FRAME.width, FRAME.height, INNER.width, INNER.height)
    const rings = tileRingFrames(FRAME, INNER, { width: END.border, radius: END.radius })
    const clips = tileClipFrames(FRAME, INNER, { frame: 24, tile: 23 })
    const moves = tileFlightFrames(FRAME, INNER, PANEL)
    expect(rings.map((r) => r.offset)).toEqual(clips.map((c) => c.offset))
    const n = (v: string) => parseFloat(v)
    for (const [i, ring] of rings.entries()) {
      const q = i / (rings.length - 1)
      const scale = 1 + (s - 1) * q
      // On screen: 1px thick, 24px round.
      expect(n(ring.borderWidth) * scale).toBeCloseTo(1, 1)
      expect(n(ring.borderRadius) * scale).toBeCloseTo(24, 1)
      // Round the clip: its box, out by its own thickness on every side.
      const [side, foot] = /inset\(0px ([\d.]+)px ([\d.]+)px/.exec(clips[i].clipPath)!.slice(1).map(Number)
      expect(n(ring.left)).toBeCloseTo(side - n(ring.borderWidth), 1)
      expect(n(ring.top)).toBeCloseTo(-n(ring.borderWidth), 1)
      expect(n(ring.width)).toBeCloseTo(FRAME.width - 2 * side + 2 * n(ring.borderWidth), 1)
      expect(n(ring.height)).toBeCloseTo(FRAME.height - foot + 2 * n(ring.borderWidth), 1)
    }
    // Landed: on screen it is the tile's border box, to the pixel.
    const at = parse(moves.at(-1)!.transform)
    const last = rings.at(-1)!
    expect(at.x + n(last.left) * at.s).toBeCloseTo(TILE.left, 0)
    expect(at.y + n(last.top) * at.s).toBeCloseTo(TILE.top, 0)
    expect(n(last.width) * at.s).toBeCloseTo(TILE.width, 0)
    expect(n(last.height) * at.s).toBeCloseTo(TILE.height, 0)
    // Leaving: round the frame (it is clear there: the frame's own border is the copy's).
    expect(n(rings[0].left)).toBe(-1)
    expect(n(rings[0].width)).toBe(FRAME.width + 2)
  })

  it('the outline keeps step with the window and is done by the hand-over: where the window is on its curve at each moment, over where it is then', () => {
    const at = outlineProgress()
    expect(at[0]).toBe(0)
    expect(at.at(-1)).toBe(1)
    expect(at.every((p, i) => i === 0 || p >= at[i - 1])).toBe(true)
    // The palette's fast out: most of the way in the first third of that time.
    expect(at[Math.round(at.length / 3)]).toBeGreaterThan(0.65)
    // Offsets evenly through the moments, the shapes those of each moment's place on the way.
    const clips = tileClipFrames(FRAME, INNER, { frame: 24, tile: 23 }, at)
    expect(clips).toHaveLength(at.length)
    expect(clips[0]).toEqual({ offset: 0, clipPath: 'inset(0px 0px 0px 0px round 24px)' })
    expect(clips.at(-1)!.offset).toBe(1)
    expect(clips.at(-1)!.clipPath).toBe(tileClipFrames(FRAME, INNER, { frame: 24, tile: 23 }).at(-1)!.clipPath)
    expect(clips[6].offset).toBeCloseTo(6 / (at.length - 1), 4)
    expect(tileRingFrames(FRAME, INNER, { width: 1, radius: 24 }, at).at(-1)).toEqual({ ...tileRingFrames(FRAME, INNER, { width: 1, radius: 24 }).at(-1)!, offset: 1 })
  })

  it('the tile’s shadow in the copy’s units: every length over the scale, its colours as they are', () => {
    expect(scaledShadow('rgba(0, 0, 0, 0.08) 0px 4px 6px -1px, rgba(0, 0, 0, 0.08) 0px 2px 4px -2px', 2)).toBe('rgba(0, 0, 0, 0.08) 0px 8px 12px -2px, rgba(0, 0, 0, 0.08) 0px 4px 8px -4px')
    expect(scaledShadow('none', 3)).toBe('none')
    expect(scaledShadow('', 3)).toBe('none')
  })
})

describe('the flights', () => {
  const realRect = HTMLElement.prototype.getBoundingClientRect
  let animate: ReturnType<typeof vi.fn>
  let finish: Map<Element, Array<() => void>>
  let reduced: boolean

  function box(rect: FlightRect, attrs: Record<string, string> = {}): HTMLElement {
    const el = document.createElement('div')
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
    ;(el as unknown as { __rect: FlightRect }).__rect = rect
    document.body.append(el)
    return el
  }

  /** A frame like a card's: its glass, its header, its page. */
  function frameEl(): HTMLElement {
    const frame = box(FRAME, { 'data-chat-card-frame': '' })
    frame.className = 'relative flex rounded-3xl shadow-2xl'
    frame.innerHTML = `<div data-card-glass class="absolute inset-0 bg-background/70 backdrop-blur-md"></div><header class="sticky bg-background/80 backdrop-blur-sm" id="h">Team chat</header><p tabindex="0">Row</p>`
    return frame
  }

  /** A tile as drawn: its box, its 1px edge, its corners, its shadow. */
  function tileEl(attrs: Record<string, string> = {}): HTMLElement {
    const tile = box(TILE, attrs)
    Object.assign(tile.style, { borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: END.edge, borderTopLeftRadius: '24px', boxShadow: END.shadow })
    return tile
  }

  const flyer = () => document.querySelector<HTMLElement>('[data-tile-flight]')
  const part = (name: 'window' | 'shade' | 'edge') => document.querySelector<HTMLElement>(`[data-tile-flight-${name}]`)!
  const settle = async () => {
    await Promise.resolve()
    await Promise.resolve()
  }

  beforeEach(() => {
    __resetTileFlightForTests()
    vi.useFakeTimers()
    reduced = false
    window.matchMedia = ((q: string) => ({ matches: q.includes('reduce') ? reduced : false })) as unknown as typeof window.matchMedia
    finish = new Map()
    animate = vi.fn(function (this: Element) {
      let resolve!: () => void
      let reject!: (e: unknown) => void
      const finished = new Promise<void>((res, rej) => {
        resolve = res
        reject = rej
      })
      finished.catch(() => {})
      finish.set(this, [...(finish.get(this) ?? []), resolve])
      return { finished, currentTime: 0, cancel: vi.fn(() => reject(new Error('cancelled'))) }
    })
    ;(HTMLElement.prototype as unknown as { animate: unknown }).animate = animate
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const r = (this as unknown as { __rect?: FlightRect }).__rect
      if (!r) return realRect.call(this)
      return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => ({}) } as DOMRect
    }
    Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true })
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
    delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate
    HTMLElement.prototype.getBoundingClientRect = realRect
    __resetTileFlightForTests()
  })

  it('the copies: no backdrop blur but the card’s glass (see-through in the tile, glass again in flight), one stripped copy cloned for the flight, promoted only while it flies', () => {
    const still = stillCopyOf(frameEl())!
    const glass = still.copy.firstElementChild as HTMLElement
    expect(glass.classList.contains(FLIGHT_GLASS_CLASS)).toBe(true)
    // In the tile, the tile's skin is the glass.
    expect(glass.style.background).toContain('transparent')
    expect(still.copy.querySelector('header')!.className).not.toContain('backdrop-')
    // The kept preview is never promoted.
    expect(still.copy.style.willChange).toBe('auto')
    const snap = flightCopyOf(still)!
    expect(snap.copy).not.toBe(still.copy)
    expect(snap.copy.textContent).toBe(still.copy.textContent)
    expect(snap.copy.querySelector('[tabindex], [id], [data-card-glass]')).toBeNull()
    // A layer of its own (its clip a mask over it); the move is its window's, not its own.
    expect(snap.copy.style.willChange).toBe('transform')
    expect(snap.copy.style.transform).toBe('none')
    expect(snap.rect).toEqual(FRAME)
    // In flight its glass is the frame's own again (the same look the frame hands over to).
    const flying = snap.copy.querySelector<HTMLElement>(`.${FLIGHT_GLASS_CLASS}`)!
    expect(flying.className).toContain('backdrop-blur-md')
    expect(flying.style.background).toBe('')
  })

  it('the copies keep the page where it was read: each scroller’s place marked as the copy is taken, put back once it is drawn, in a clone too', () => {
    const frame = frameEl()
    const list = document.createElement('div')
    list.innerHTML = '<p>One</p><p>Two</p>'
    frame.append(list)
    list.scrollTop = 420
    const still = stillCopyOf(frame)!
    const copied = still.copy.lastElementChild as HTMLElement
    expect(copied.getAttribute('ni-scroll')).toBe('420,0')
    // Nothing else is marked.
    expect(still.copy.querySelectorAll('[ni-scroll]')).toHaveLength(1)
    document.body.append(still.copy)
    applyCopyScroll(still.copy)
    expect(copied.scrollTop).toBe(420)
    const snap = flightCopyOf(still)!
    document.body.append(snap.copy)
    applyCopyScroll(snap.copy)
    expect((snap.copy.lastElementChild as HTMLElement).scrollTop).toBe(420)
  })

  it('the tile’s end is read off the tile (or its slot, which wears the same): its box, edge, corners and shadow', () => {
    expect(tileEndOf(tileEl())).toEqual(END)
    expect(tileEndOf(null)).toBeNull()
    // No box on screen: none.
    expect(tileEndOf(document.createElement('div'))).toBeNull()
  })

  it('the composer’s box is one of the things the window passes behind: its reading column inside that column’s padding', () => {
    expect(composerObstacle()).toBeNull()
    const zone = document.createElement('div')
    zone.setAttribute('data-chat-composer', '')
    const col = box({ left: 460, top: 820, width: 640, height: 72 })
    col.className = 'chat-reading-col'
    Object.assign(col.style, { paddingLeft: '10px', paddingRight: '10px', paddingTop: '8px', paddingBottom: '8px' })
    zone.append(col)
    document.body.append(zone)
    expect(composerObstacle()).toEqual({ left: 470, top: 828, right: 1090, bottom: 884 })
    // Hidden (a bot's page is up): nothing to pass behind.
    zone.hidden = true
    expect(composerObstacle()).toBeNull()
  })

  it('minimize: the window in one flyer (its shade, its copy, the tile’s edge), round the panel and behind it, the ⌘K palette’s curve over MINIMIZE_FLIGHT_MS; the card changes hands half way; landed, the tile whole in the frame the copy goes, nothing coming in after', async () => {
    box({ left: PANEL.left, top: PANEL.top, width: PANEL.right - PANEL.left, height: PANEL.bottom - PANEL.top }, { 'data-page-panel': '' })
    const frame = frameEl()
    const tile = tileEl({ 'data-minimized-card': 'team' })
    const handoff = vi.fn()
    const cancelled = vi.fn()
    const snap = flightCopyOf(stillCopyOf(frame))!
    expect(launchIntoTile('minimize:team', snap, END, frame, { handoff, cancelled })).toBe(true)
    const f = flyer()!
    expect(f.getAttribute('data-tile-flight')).toBe('into')
    // One window in it: the frame's shade under the copy, the tile's edge over it.
    expect(f.children).toHaveLength(1)
    const mover = part('window')
    expect([...mover.children]).toEqual([part('shade'), snap.copy, part('edge')])
    expect(f.style.clipPath).toBe(panelClip(PANEL))
    // Under the tile (z-52): the tile takes over from its copy.
    expect(Number(f.style.zIndex)).toBeLessThan(52)
    // The frame is hidden while its copy is over it.
    expect(frame.style.opacity).toBe('0')
    // On one clock: the window's move (transform only: the compositor's), the copy's outline, the edge's box, and the two fades.
    expect(animate.mock.contexts).toEqual([mover, snap.copy, part('edge'), part('edge'), part('shade')])
    const timing = { duration: MINIMIZE_FLIGHT_MS, easing: PALETTE_ENTRANCE_EASING, fill: 'forwards' }
    // The outline (the main thread's) is done by the hand-over, on its own moments (outlineProgress), and held.
    const outlineTiming = { duration: TILE_HANDOFF_MS, easing: 'linear', fill: 'forwards' }
    expect(animate.mock.calls.map((call) => call[1])).toEqual([timing, outlineTiming, outlineTiming, timing, timing])
    expect(TILE_FLIGHT_EASING).toBe(PALETTE_ENTRANCE_EASING)
    expect(MINIMIZE_FLIGHT_MS).toBeGreaterThanOrEqual(SEARCH_FLIGHT_MS)
    // To the box inside the tile's border, where the tile draws its preview.
    expect(animate.mock.calls[0][0]).toEqual(tileFlightFrames(FRAME, INNER, PANEL))
    // (No CSS here: the frame's radius reads 0.) The tile's inner corners: its radius less its border.
    expect(animate.mock.calls[1][0]).toEqual(tileClipFrames(FRAME, INNER, { frame: 0, tile: 23 }, outlineProgress()))
    expect(animate.mock.calls[2][0]).toEqual(tileRingFrames(FRAME, INNER, { width: 1, radius: 24 }, outlineProgress()))
    // Landing shapes: exactly the tile's, whatever the clock.
    expect((animate.mock.calls[1][0] as Array<{ clipPath: string }>).at(-1)!.clipPath).toBe(tileClipFrames(FRAME, INNER, { frame: 0, tile: 23 }).at(-1)!.clipPath)
    // The tile's edge fades in toward the tile, in its colour and (in the copy's units) its shadow; the frame's shade fades out.
    expect(animate.mock.calls[3][0]).toEqual([{ offset: 0, opacity: 0 }, { offset: 1, opacity: 1 }])
    expect(animate.mock.calls[4][0]).toEqual([{ offset: 0, opacity: 1 }, { offset: 1, opacity: 0 }])
    expect(part('edge').style.borderColor).toBe(END.edge)
    expect(part('edge').style.boxShadow).toBe(scaledShadow(END.shadow, 1 / coverScale(FRAME.width, FRAME.height, INNER.width, INNER.height)))
    // The copy and its window stay whole: nothing fades them (never a see-through window).
    for (const [i, call] of animate.mock.calls.entries()) {
      if (animate.mock.contexts[i] === mover || animate.mock.contexts[i] === snap.copy) expect((call[0] as Keyframe[]).some((k) => 'opacity' in k)).toBe(false)
    }
    expect(snap.copy.style.opacity).toBe('1')

    // The tile draws: hidden at once, with no opacity transition.
    const records: MutationRecord[] = []
    const watch = new MutationObserver((list) => records.push(...list))
    watch.observe(tile, { attributes: true, attributeFilter: ['style'], attributeOldValue: true })
    landTileHome('minimize:team', tile)
    expect(tile.style.opacity).toBe('0')
    expect(tile.style.transitionProperty).toBe('none')

    // Half way through: the card is put away (its render in the flight's soft tail), the copy still flying.
    vi.advanceTimersByTime(TILE_HANDOFF_MS - 1)
    expect(handoff).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(handoff).toHaveBeenCalledTimes(1)
    expect(flyer()).not.toBeNull()
    expect(tile.style.opacity).toBe('0')

    // Landed: the flyer goes and the tile shows in one go, whole, never through a transition.
    finish.get(mover)![0]()
    await settle()
    expect(flyer()).toBeNull()
    expect(tile.style.opacity).toBe('')
    expect(tile.style.transitionProperty).toBe('')
    expect(tile.style.boxShadow).toBe(END.shadow)
    expect(handoff).toHaveBeenCalledTimes(1)
    expect(cancelled).not.toHaveBeenCalled()
    // A frame still there stays hidden (it is going); only one that never went shows again.
    expect(frame.style.opacity).toBe('0')
    vi.advanceTimersByTime(2000)
    expect(frame.style.opacity).toBe('')
    records.push(...watch.takeRecords())
    watch.disconnect()
    const values = [...records.slice(1).map((r) => r.oldValue ?? ''), tile.getAttribute('style') ?? '']
    const hiddenAt = values.findIndex((v) => v.includes('opacity: 0'))
    const shownAt = values.findIndex((v, i) => i > hiddenAt && !v.includes('opacity'))
    expect(hiddenAt).toBeGreaterThanOrEqual(0)
    // Shown while no opacity transition is on: nothing fades in after the copy goes.
    expect(values[shownAt]).toContain('transition-property: none')
    // No settle (no squash or spring after it): nothing more animated.
    expect(animate.mock.calls).toHaveLength(5)
  })

  it('minimize: a hand-over held back (a timer in a background tab) runs as the copy lands at the latest', async () => {
    const frame = frameEl()
    const handoff = vi.fn()
    const snap = flightCopyOf(stillCopyOf(frame))!
    launchIntoTile('minimize:team', snap, END, frame, { handoff })
    landTileHome('minimize:team', tileEl())
    finish.get(part('window'))![0]()
    await settle()
    expect(handoff).toHaveBeenCalledTimes(1)
    expect(flyer()).toBeNull()
    vi.advanceTimersByTime(TILE_HANDOFF_MS * 2)
    expect(handoff).toHaveBeenCalledTimes(1)
  })

  it('a flight ended before its hand-over changed nothing: its frame shown again, `cancelled` told, the hand-over never run', () => {
    const frame = frameEl()
    const handoff = vi.fn()
    const cancelled = vi.fn()
    launchIntoTile('minimize:team', flightCopyOf(stillCopyOf(frame)), END, frame, { handoff, cancelled })
    expect(frame.style.opacity).toBe('0')
    // Another tile flight takes over.
    flyIntoTile(flightCopyOf(stillCopyOf(frame)), tileEl())
    expect(cancelled).toHaveBeenCalledTimes(1)
    expect(frame.style.opacity).toBe('')
    expect(document.querySelectorAll('[data-tile-flight]')).toHaveLength(1)
    vi.advanceTimersByTime(TILE_HANDOFF_MS * 2)
    expect(handoff).not.toHaveBeenCalled()
  })

  it('passes behind the composer too, and never has a hole where the window stands or lands', () => {
    const zone = document.createElement('div')
    zone.setAttribute('data-chat-composer', '')
    const col = box({ left: 470, top: 830, width: 620, height: 50 })
    col.className = 'chat-reading-col'
    zone.append(col)
    document.body.append(zone)
    const frame = frameEl()
    launchIntoTile('k', flightCopyOf(stillCopyOf(frame)), END, frame)
    expect(flyer()!.style.clipPath).toBe(obstacleClip([{ left: 470, top: 830, right: 1090, bottom: 880 }]))
    // A composer under the tile (a narrow window): the tile is whole, so no hole.
    ;(col as unknown as { __rect: FlightRect }).__rect = { left: 300, top: 830, width: 620, height: 50 }
    launchIntoTile('k', flightCopyOf(stillCopyOf(frame)), END, frame)
    expect(flyer()!.style.clipPath).toBe('')
  })

  it('minimize starting as the tile draws (flyIntoTile): the same, landed at once on the tile', () => {
    const tile = tileEl()
    expect(flyIntoTile(flightCopyOf(stillCopyOf(frameEl())), tile)).toBe(true)
    expect(flyer()).not.toBeNull()
    // No panel on screen: no clip.
    expect(flyer()!.style.clipPath).toBe('')
    expect(tile.style.opacity).toBe('0')
    // To the tile's own inner box and edge, read off it.
    expect(animate.mock.calls[0][0]).toEqual(tileFlightFrames(FRAME, INNER, null))
    expect(flyIntoTile(null, tile)).toBe(false)
  })

  it('restore: out of the tile at once looking like it (its box, edge and shadow; the tile gone in that frame), back the same way; the card brought back half way, its frame mounting under the copy and shown in the frame the copy goes; no settle', async () => {
    const tile = tileEl()
    const snap = flightCopyOf(stillCopyOf(frameEl()))!
    document.querySelector('[data-chat-card-frame]')!.remove()
    const handoff = vi.fn()
    expect(launchTileFlight('minimized:team', tile, snap, { handoff })).toBe(true)
    expect(flyer()!.getAttribute('data-tile-flight')).toBe('out')
    expect(tile.style.opacity).toBe('0')
    expect(tile.style.transitionProperty).toBe('none')
    const timing = { duration: MINIMIZE_FLIGHT_MS, easing: PALETTE_ENTRANCE_EASING, fill: 'forwards' }
    const outlineTiming = { duration: TILE_HANDOFF_MS, easing: 'linear', fill: 'forwards' }
    expect(animate.mock.calls.map((call) => call[1])).toEqual([timing, outlineTiming, outlineTiming, timing, timing])
    // The same path backwards: it starts as the tile.
    expect(animate.mock.calls[0][0]).toEqual(reversedFrames(tileFlightFrames(FRAME, INNER, null)))
    // Its outline from the tile's to the frame's, the frame's by the hand-over.
    const back = outlineProgress().map((p) => 1 - p)
    const clips = animate.mock.calls[1][0] as Array<{ offset: number; clipPath: string }>
    expect(clips).toEqual(tileClipFrames(FRAME, INNER, { frame: 0, tile: 23 }, back))
    expect(clips[0].clipPath).toBe(tileClipFrames(FRAME, INNER, { frame: 0, tile: 23 }).at(-1)!.clipPath)
    expect(clips.at(-1)).toEqual({ offset: 1, clipPath: 'inset(0px 0px 0px 0px round 0px)' })
    expect(animate.mock.calls[2][0]).toEqual(tileRingFrames(FRAME, INNER, { width: 1, radius: 24 }, back))
    // The tile's edge is whole on the first frame and fades as the window grows; the frame's shade comes in.
    expect(animate.mock.calls[3][0]).toEqual([{ offset: 0, opacity: 1 }, { offset: 1, opacity: 0 }])
    expect(animate.mock.calls[4][0]).toEqual([{ offset: 0, opacity: 0 }, { offset: 1, opacity: 1 }])
    const edge = part('edge')
    const last = tileRingFrames(FRAME, INNER, { width: 1, radius: 24 }).at(-1)!
    expect(edge.style.opacity).toBe('1')
    expect(edge.style.width).toBe(last.width)
    expect(edge.style.borderRadius).toBe(last.borderRadius)
    expect(part('shade').style.opacity).toBe('0')
    expect(part('window').style.transform).toBe(tileFlightFrames(FRAME, INNER, null).at(-1)!.transform)
    expect(animate.mock.calls).toHaveLength(5)

    // Half way: the card is brought back; its frame mounts hidden under the copy.
    vi.advanceTimersByTime(TILE_HANDOFF_MS)
    expect(handoff).toHaveBeenCalledTimes(1)
    const frame = box(FRAME)
    const off = landTileFlight('minimized:team', frame)
    expect(frame.style.opacity).toBe('0')
    expect(flyer()).not.toBeNull()
    // React's development double mount: taken off, shown; mounted again, hidden again.
    off()
    expect(frame.style.opacity).toBe('')
    landTileFlight('minimized:team', frame)
    expect(frame.style.opacity).toBe('0')
    // Landed: the copy goes and the frame shows, in one go.
    finish.get(part('window'))![0]()
    await settle()
    expect(flyer()).toBeNull()
    expect(frame.style.opacity).toBe('')
    expect(animate.mock.calls).toHaveLength(5)
  })

  it('restore: a frame that mounts after the copy has arrived takes over before it paints', async () => {
    const snap = flightCopyOf(stillCopyOf(frameEl()))!
    document.querySelector('[data-chat-card-frame]')!.remove()
    const handoff = vi.fn()
    launchTileFlight('minimized:team', tileEl(), snap, { handoff })
    finish.get(part('window'))![0]()
    await settle()
    // The hand-over at the latest; the copy waits on its place for the frame.
    expect(handoff).toHaveBeenCalledTimes(1)
    expect(flyer()).not.toBeNull()
    const frame = box(FRAME)
    landTileFlight('minimized:team', frame)
    expect(flyer()).toBeNull()
    expect(frame.style.opacity).toBe('')
  })

  it('nothing under reduced motion or without the API', () => {
    reduced = true
    expect(flightCopyOf(stillCopyOf(frameEl()))).toBeNull()
    reduced = false
    const snap = flightCopyOf(stillCopyOf(frameEl()))
    delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate
    expect(launchTileFlight('k', tileEl(), snap)).toBe(false)
    expect(flyer()).toBeNull()
  })
})
