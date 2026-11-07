// @vitest-environment jsdom
/**
 * The agent's face (agent-bot.tsx): `bot-avatars` in the person's look (the
 * default until they pick one), fabric; its box held while the renderer
 * loads; moving only in bursts (on mount, a state or look change, a nudge)
 * and only while watched, else held; one tracker for the pointer anywhere in
 * the window, the head eased toward it frame by frame till it is there, a
 * move ending an idle burst at once; its canvas never takes the pointer;
 * decorative. The renderer is stubbed (jsdom has no canvas).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const watching = vi.hoisted(() => ({ value: true, calls: [] as unknown[][] }))
vi.mock('@/hooks/use-watched', () => ({
  useWatched: (active: boolean, opts?: unknown) => {
    watching.calls.push([active, opts])
    return active && watching.value
  },
}))
const draws = vi.hoisted(() => ({ n: 0 }))
vi.mock('bot-avatars', async () => {
  const { createElement } = await import('react')
  return {
    // Each render of the package's BotAvatar is a frame drawn (its layout effect draws on every render).
    BotAvatar: (p: Record<string, unknown>) =>
      (draws.n++,
      createElement('canvas', {
        'data-stub-bot': p.type,
        'data-state': p.state,
        'data-paused': String(!!p.paused),
        'data-pose': p.pose ? JSON.stringify(p.pose) : undefined,
        'data-props': JSON.stringify(p),
      })),
  }
})

const { AGENT_BOT_MOVE_MS, AgentBot, GAZE_FRAME_MS, GLANCE_EVERY_MS, GLANCE_HOLD_MS, GLANCE_LIMIT, GLANCE_SPREAD_MS, easeGaze, gazeToward, glanceAway } = await import('../agent-bot')
const { DEFAULT_AGENT_LOOK } = await import('@/lib/bots/agent-look')
const { __resetAgentLookForTests, saveAgentLook } = await import('@/lib/bots/agent-look-store')

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
beforeEach(() => {
  watching.value = true
  watching.calls = []
  window.localStorage.clear()
  __resetAgentLookForTests()
  // The account takes every look saved (the profile PATCH).
  vi.stubGlobal('fetch', async () => new Response('{"success":true}'))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const canvas = () => host.querySelector<HTMLCanvasElement>('canvas[data-stub-bot]')
const props = () => JSON.parse(canvas()!.getAttribute('data-props')!) as Record<string, unknown>
const paused = () => canvas()!.getAttribute('data-paused')
async function render(el: React.ReactElement) {
  await act(async () => root.render(el))
  // The renderer's module, fetched on the first mount in this file: microtask ticks (fake timers can't stall them),
  // each its own act so React commits between them.
  for (let i = 0; i < 200 && !canvas(); i++) await act(async () => void (await Promise.resolve()))
  expect(canvas()).not.toBeNull()
}

describe('the agent’s bot', () => {
  it('wears the default look in fabric, decorative, in a box of its size, its canvas never taking the pointer', async () => {
    await render(<AgentBot state="default" active size={56} className="x" />)
    const face = host.querySelector<HTMLElement>('[data-agent-bot]')!
    expect(face.getAttribute('aria-hidden')).toBe('true')
    expect(face.style.width).toBe('56px')
    expect(face.style.height).toBe('56px')
    expect(face.className).toContain('x')
    // Drawn just over twice its box (the package's top texture) and scaled into it.
    expect(props()).toMatchObject({ ...DEFAULT_AGENT_LOOK, shading: 'fabric', size: 115, state: 'default', style: { pointerEvents: 'none' } })
    const drawn = canvas()!.parentElement!
    expect(drawn.style.width).toBe('115px')
    expect(drawn.style.transform).toBe(`scale(${56 / 115})`)
    expect(drawn.className).toContain('absolute')
    expect(DEFAULT_AGENT_LOOK).toMatchObject({ type: 'flower', color: '#EAA06F', face: 'mouth', glasses: 'shades', headphones: false, shading: 'fabric' })
  })

  it('wears the material picked', async () => {
    await act(async () => void (await saveAgentLook({ ...DEFAULT_AGENT_LOOK, shading: 'plastic' })))
    await render(<AgentBot state="default" active size={56} />)
    expect(props().shading).toBe('plastic')
  })

  it('wears the person’s saved look, live, or a look it’s given (the editor’s preview)', async () => {
    await render(<AgentBot state="default" active size={56} />)
    await act(async () => void (await saveAgentLook({ ...DEFAULT_AGENT_LOOK, type: 'cat', hat: 'crown' })))
    expect(props()).toMatchObject({ type: 'cat', hat: 'crown' })
    await render(<AgentBot state="default" active size={56} look={{ ...DEFAULT_AGENT_LOOK, type: 'ghost' }} />)
    expect(props().type).toBe('ghost')
  })

  it('wears the state it’s given', async () => {
    await render(<AgentBot state="working" active size={56} />)
    expect(canvas()!.getAttribute('data-state')).toBe('working')
    expect(host.querySelector('[data-agent-bot]')!.getAttribute('data-agent-bot')).toBe('working')
    await render(<AgentBot state="sleeping" active size={56} />)
    expect(canvas()!.getAttribute('data-state')).toBe('sleeping')
  })

  it('is still while nobody watches: its surface off screen, or the person away', async () => {
    await render(<AgentBot state="default" active={false} size={56} />)
    // No minute-without-input rule by default: its motion is bounded by events.
    expect(watching.calls.at(-1)).toEqual([false, { idle: false }])
    expect(paused()).toBe('true')
    await render(<AgentBot state="default" active size={56} />)
    expect(paused()).toBe('false')
    watching.value = false
    await render(<AgentBot state="working" active size={56} />)
    expect(paused()).toBe('true')
  })

  it('takes the minute-without-input rule only when asked', async () => {
    await render(<AgentBot state="default" active size={48} watchIdle />)
    expect(watching.calls.at(-1)).toEqual([true, { idle: true }])
  })

  it('moves in a burst when it appears, then holds still facing forward, its state keeping its own rest pitch and roll', async () => {
    vi.useFakeTimers()
    await render(<AgentBot state="sleeping" active size={56} />)
    expect(paused()).toBe('false')
    expect(canvas()!.hasAttribute('data-pose')).toBe(false)
    await act(async () => vi.advanceTimersByTime(AGENT_BOT_MOVE_MS))
    expect(paused()).toBe('true')
    expect(JSON.parse(canvas()!.getAttribute('data-pose')!)).toEqual({ yaw: 0 })
    // Only the next idle glance's.
    expect(vi.getTimerCount()).toBe(1)
  })

  it('a state change, a look change or a nudge starts another burst; burstMs sets its length', async () => {
    vi.useFakeTimers()
    await render(<AgentBot state="default" active size={56} nudge={0} burstMs={1400} />)
    await act(async () => vi.advanceTimersByTime(1400))
    expect(paused()).toBe('true')
    await render(<AgentBot state="sleeping" active size={56} nudge={0} burstMs={1400} />)
    expect(paused()).toBe('false')
    await act(async () => vi.advanceTimersByTime(1400))
    expect(paused()).toBe('true')
    await render(<AgentBot state="sleeping" active size={56} nudge={1} burstMs={1400} />)
    expect(paused()).toBe('false')
    await act(async () => vi.advanceTimersByTime(1400))
    expect(paused()).toBe('true')
    await render(<AgentBot state="sleeping" active size={56} nudge={1} burstMs={1400} look={{ ...DEFAULT_AGENT_LOOK, hat: 'beret' }} />)
    expect(paused()).toBe('false')
  })

  it('never moves unwatched, burst or pointer, and holds no timer then', async () => {
    watching.value = false
    vi.useFakeTimers()
    await render(<AgentBot state="working" active size={56} />)
    expect(paused()).toBe('true')
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => void document.dispatchEvent(new PointerEvent('pointermove', { clientX: 10, clientY: 10 })))
    expect(paused()).toBe('true')
    expect(canvas()!.hasAttribute('data-pose') && JSON.parse(canvas()!.getAttribute('data-pose')!)).toEqual({ yaw: 0 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never moves under reduced motion, and holds no timer', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce'), addEventListener() {}, removeEventListener() {} }))
    vi.useFakeTimers()
    await render(<AgentBot state="default" active size={56} />)
    expect(paused()).toBe('true')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('watches the pointer anywhere in the window: a move ends the idle burst, the head eases toward it a frame at a time, then no more frames', async () => {
    vi.useFakeTimers()
    await render(<AgentBot state="default" active size={56} />)
    const face = host.querySelector<HTMLElement>('[data-agent-bot]')!
    face.getBoundingClientRect = () => ({ left: 1000, top: 40, width: 56, height: 56, right: 1056, bottom: 96, x: 1000, y: 40, toJSON: () => ({}) }) as DOMRect
    const box = face.getBoundingClientRect()
    const move = (x: number, y: number) => act(async () => void document.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y })))
    const pose = () => JSON.parse(canvas()!.getAttribute('data-pose')!) as { yaw: number; pitch: number }
    expect(paused()).toBe('false')
    // Mid idle burst, the pointer moves (down and to the left): the burst ends there and then, the head on its way.
    await move(200, 600)
    await act(async () => vi.advanceTimersByTime(0))
    expect(paused()).toBe('true')
    const goal = gazeToward(box, 200, 600)
    expect(goal.yaw).toBeLessThan(0)
    expect(goal.pitch).toBeLessThan(0)
    const first = pose()
    expect(first).toEqual(easeGaze(null, goal))
    // Frame by frame toward it, then there, then no more frames.
    for (let i = 0; i < 40; i++) await act(async () => vi.advanceTimersByTime(GAZE_FRAME_MS))
    expect(pose()).toEqual(goal)
    // No frame after that till a glance: it holds there.
    await act(async () => vi.advanceTimersByTime(GLANCE_EVERY_MS - 40 * GAZE_FRAME_MS - 1))
    expect(pose()).toEqual(goal)
    // Up and to the right: eased, not jumped.
    await move(1500, 0)
    await act(async () => vi.advanceTimersByTime(0))
    const step = pose()
    const goal2 = gazeToward(box, 1500, 0)
    expect(step.yaw).toBeGreaterThan(goal.yaw)
    expect(step.yaw).toBeLessThan(goal2.yaw)
    for (let i = 0; i < 40; i++) await act(async () => vi.advanceTimersByTime(GAZE_FRAME_MS))
    expect(pose()).toEqual(goal2)
  })

  it('the working hops play out before it watches the pointer', async () => {
    vi.useFakeTimers()
    await render(<AgentBot state="working" active size={56} />)
    host.querySelector<HTMLElement>('[data-agent-bot]')!.getBoundingClientRect = () => ({ left: 1000, top: 40, width: 56, height: 56, right: 1056, bottom: 96, x: 1000, y: 40, toJSON: () => ({}) }) as DOMRect
    await act(async () => void document.dispatchEvent(new PointerEvent('pointermove', { clientX: 200, clientY: 600 })))
    await act(async () => vi.advanceTimersByTime(GAZE_FRAME_MS))
    expect(paused()).toBe('false')
    expect(canvas()!.hasAttribute('data-pose')).toBe(false)
    await act(async () => vi.advanceTimersByTime(AGENT_BOT_MOVE_MS))
    expect(paused()).toBe('true')
    // Held now: the head sets off toward where the pointer went.
    await act(async () => vi.advanceTimersByTime(0))
    expect(JSON.parse(canvas()!.getAttribute('data-pose')!).yaw).toBeLessThan(0)
  })

  it('watches nothing unwatched: no listener, the pose unmoved', async () => {
    watching.value = false
    const add = vi.spyOn(document, 'addEventListener')
    await render(<AgentBot state="default" active size={56} />)
    expect(add.mock.calls.some(([type]) => type === 'pointermove')).toBe(false)
    add.mockRestore()
  })
})

describe('frames', () => {
  const at = { left: 1000, top: 40, width: 56, height: 56, right: 1056, bottom: 96, x: 1000, y: 40, toJSON: () => ({}) }
  it('never closer than GAZE_FRAME_MS, however fast the pointer moves (a 120 Hz mouse included)', async () => {
    vi.useFakeTimers()
    await render(<AgentBot state="default" active size={56} />)
    host.querySelector<HTMLElement>('[data-agent-bot]')!.getBoundingClientRect = () => at as DOMRect
    // The pointer passing just in front of it, 2.5 px every 8 ms (a 120 Hz mouse) for a second: each step turns the head
    // by more than can't be seen yet less than one ease covers, so each would be a frame of its own without the spacing.
    const start = draws.n
    for (let i = 0; i < 125; i++) {
      await act(async () => void document.dispatchEvent(new PointerEvent('pointermove', { clientX: 870 + i * 2.5, clientY: 68 })))
      await act(async () => vi.advanceTimersByTime(8))
    }
    const perSecond = draws.n - start
    expect(perSecond).toBeGreaterThan(10)
    expect(perSecond).toBeLessThanOrEqual(Math.ceil(1000 / GAZE_FRAME_MS) + 2)
  })

  it('a turn too small to see draws nothing', async () => {
    vi.useFakeTimers()
    await render(<AgentBot state="default" active size={56} />)
    host.querySelector<HTMLElement>('[data-agent-bot]')!.getBoundingClientRect = () => at as DOMRect
    await act(async () => void document.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, clientY: 700 })))
    await act(async () => vi.advanceTimersByTime(GAZE_FRAME_MS * 40))
    const start = draws.n
    // A pixel's nudge far from the bot turns the head by far less than GAZE_SETTLED.
    await act(async () => void document.dispatchEvent(new PointerEvent('pointermove', { clientX: 101, clientY: 700 })))
    await act(async () => vi.advanceTimersByTime(GAZE_FRAME_MS * 3))
    expect(draws.n).toBe(start)
  })
})

describe('idle glances', () => {
  it('with the pointer at rest it glances off now and then, holds it, and looks back; a move ends a glance', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    // With random 0.5: a glance GLANCE_EVERY_MS + half the spread after the last move, held 1.5 × GLANCE_HOLD_MS.
    const wait = GLANCE_EVERY_MS + GLANCE_SPREAD_MS / 2
    const hold = GLANCE_HOLD_MS * 1.5
    const settle = 600
    await render(<AgentBot state="default" active size={56} />)
    const face = host.querySelector<HTMLElement>('[data-agent-bot]')!
    face.getBoundingClientRect = () => ({ left: 1000, top: 40, width: 56, height: 56, right: 1056, bottom: 96, x: 1000, y: 40, toJSON: () => ({}) }) as DOMRect
    const pose = () => JSON.parse(canvas()!.getAttribute('data-pose')!) as { yaw: number; pitch: number }
    const advance = (ms: number) => act(async () => vi.advanceTimersByTime(ms))
    await act(async () => void document.dispatchEvent(new PointerEvent('pointermove', { clientX: 800, clientY: 300 })))
    const looking = gazeToward(face.getBoundingClientRect(), 800, 300)
    await advance(settle)
    expect(pose()).toEqual(looking)
    // The glance: off to one side, eased there.
    await advance(wait - settle + settle)
    const away = glanceAway(looking, () => 0.5)
    expect(pose()).toEqual(away)
    expect(Math.abs(away.yaw - looking.yaw)).toBeGreaterThan(0.2)
    // Held, then back.
    await advance(hold)
    await advance(settle)
    expect(pose()).toEqual(looking)
    // Mid the next glance, a move: straight to the pointer, glance over.
    await advance(wait - settle + 200)
    expect(pose()).not.toEqual(looking)
    await act(async () => void document.dispatchEvent(new PointerEvent('pointermove', { clientX: 1028, clientY: 900 })))
    await advance(settle)
    expect(pose()).toEqual(gazeToward(face.getBoundingClientRect(), 1028, 900))
  })

  it('after GLANCE_LIMIT glances with the pointer still they stop, till it moves', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    await render(<AgentBot state="default" active size={56} />)
    host.querySelector<HTMLElement>('[data-agent-bot]')!.getBoundingClientRect = () =>
      ({ left: 1000, top: 40, width: 56, height: 56, right: 1056, bottom: 96, x: 1000, y: 40, toJSON: () => ({}) }) as DOMRect
    await act(async () => vi.advanceTimersByTime(AGENT_BOT_MOVE_MS))
    const cycle = GLANCE_EVERY_MS + GLANCE_SPREAD_MS / 2 + GLANCE_HOLD_MS * 1.5
    await act(async () => vi.advanceTimersByTime(cycle * (GLANCE_LIMIT + 2)))
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => void document.dispatchEvent(new PointerEvent('pointermove', { clientX: 10, clientY: 10 })))
    await act(async () => vi.advanceTimersByTime(GAZE_FRAME_MS * 30))
    // Moving again: the next glance waits on its timer.
    expect(vi.getTimerCount()).toBe(1)
  })

  it('glances toward the side it has room on, within reach', () => {
    expect(glanceAway({ yaw: 0.5, pitch: 0 }, () => 0.5).yaw).toBeLessThan(0.5)
    expect(glanceAway({ yaw: -0.5, pitch: 0 }, () => 0.5).yaw).toBeGreaterThan(-0.5)
    for (const r of [0, 0.3, 0.7, 0.99]) {
      const g = glanceAway({ yaw: 0.1, pitch: 0.3 }, () => r)
      expect(Math.abs(g.yaw)).toBeLessThanOrEqual(0.6)
      expect(Math.abs(g.pitch)).toBeLessThanOrEqual(0.35)
    }
  })
})

describe('gazeToward and easeGaze', () => {
  const box = { left: 100, top: 100, width: 50, height: 50 }
  it('turns to the viewer’s right for a pointer to the right, tips up for one above, eases out far away, still when straight on', () => {
    expect(gazeToward(box, 125, 125)).toEqual({ yaw: 0, pitch: 0 })
    expect(gazeToward(box, 400, 125).yaw).toBeGreaterThan(0)
    expect(gazeToward(box, -200, 125).yaw).toBeLessThan(0)
    expect(gazeToward(box, 125, -200).pitch).toBeGreaterThan(0)
    expect(gazeToward(box, 125, 900).pitch).toBeLessThan(0)
    expect(gazeToward(box, 99999, 125).yaw).toBeLessThanOrEqual(0.6)
    expect(gazeToward(box, 125, -99999).pitch).toBeLessThanOrEqual(0.35)
  })

  it('eases part of the way each frame (from facing forward at first), and lands exactly once close', () => {
    const to = { yaw: 0.5, pitch: -0.2 }
    expect(easeGaze(null, to)).toEqual(easeGaze({ yaw: 0, pitch: 0 }, to))
    const one = easeGaze({ yaw: 0, pitch: 0 }, to)
    expect(one.yaw).toBeGreaterThan(0)
    expect(one.yaw).toBeLessThan(0.5)
    let at = one
    for (let i = 0; i < 30 && at !== to; i++) at = easeGaze(at, to)
    expect(at).toBe(to)
  })
})
