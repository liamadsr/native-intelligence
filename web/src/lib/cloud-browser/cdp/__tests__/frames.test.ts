/**
 * The cloud driver's frame contract (src/lib/cloud-browser/cdp/frames.ts), the
 * twin of the desktop's browser_agent_frames.h:
 *  - snapshot: the main read is required, frames share one budget, a failed
 *    or slow frame is left out, the newest observation per frame path wins, 16 at most;
 *  - action: the caller never chooses real input, each enclosing document
 *    gates a frame action, input is delivered at the main viewport's point,
 *    and a late or undelivered input is never reported as done.
 */
import { describe, expect, it, vi } from 'vitest'
import { decisionSnapshot, framePathKey, runtimeCall, SNAPSHOT_JS, taskAction, type AgentFrames } from '../frames'

type Handler = (expression: string) => string | null | Promise<string | null>
function framesOf(handlers: Record<string, Handler>, children = Object.keys(handlers).filter(key => key !== 'main')): AgentFrames<string> & { calls: [string, string][] } {
  const calls: [string, string][] = []
  return {
    main: 'main', children, calls,
    evaluate: async (frame, expression) => {
      calls.push([frame, expression])
      const handler = handlers[frame]
      if (!handler) throw new Error('frame gone')
      return handler(expression)
    },
  }
}
const observation = (fields: Record<string, unknown>) => JSON.stringify({ elements: [], ...fields })
const never = () => new Promise<string>(() => {})

describe('decisionSnapshot', () => {
  it('joins the main observation and each placed frame, as the desktop does', async () => {
    const frames = framesOf({
      main: () => observation({ documentId: 'top', observationId: 1 }),
      a: () => observation({ documentId: 'a', observationId: 3, framePath: [0] }),
      b: () => observation({ documentId: 'b', observationId: 4, framePath: [0, 1] }),
    })
    const result = await decisionSnapshot(frames, 1200, true)
    expect(JSON.parse(result!.json)).toEqual({
      main: { elements: [], documentId: 'top', observationId: 1 },
      frames: [{ elements: [], documentId: 'a', observationId: 3, framePath: [0] }, { elements: [], documentId: 'b', observationId: 4, framePath: [0, 1] }],
      inputCapable: true,
    })
    expect([...result!.paths]).toEqual([['0', 'a'], ['0.1', 'b']])
    expect(frames.calls.every(([, expression]) => expression === SNAPSHOT_JS)).toBe(true)
  })

  it('needs the main read; without it there is no snapshot', async () => {
    expect(await decisionSnapshot(framesOf({ main: () => { throw new Error('gone') }, a: () => observation({ framePath: [0], observationId: 1 }) }), 50, true)).toBeNull()
    expect(await decisionSnapshot(framesOf({ main: () => null }), 50, true)).toBeNull()
  })

  it('leaves out a frame that is slow past the budget, but waits for a slow main read', async () => {
    vi.useFakeTimers()
    try {
      let releaseMain = (_: string) => {}
      const frames = framesOf({
        main: () => new Promise<string>(resolve => { releaseMain = resolve }),
        slow: never,
        fast: () => observation({ framePath: [1], observationId: 2 }),
      })
      const pending = decisionSnapshot(frames, 100, true)
      await vi.advanceTimersByTimeAsync(5000)
      releaseMain(observation({ observationId: 1 }))
      const result = await pending
      expect(JSON.parse(result!.json).frames.map((frame: { framePath: number[] }) => frame.framePath)).toEqual([[1]])
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops frames that failed, gave no observation, or can not be placed', async () => {
    const frames = framesOf({
      main: () => observation({ observationId: 1 }),
      failed: () => { throw new Error('detached') },
      missing: () => '{"error":"agent runtime not present"}',
      unplaced: () => observation({ framePath: null, observationId: 2 }),
      deep: () => observation({ framePath: [0, 0, 0, 0, 0], observationId: 3 }),
      garbage: () => 'not json',
      ok: () => observation({ framePath: [2], observationId: 4 }),
    })
    const result = await decisionSnapshot(frames, 1200, false)
    expect(JSON.parse(result!.json)).toMatchObject({ frames: [{ framePath: [2] }], inputCapable: false })
  })

  it('keeps the newest observation of a frame read twice, and at most 16 frames', async () => {
    const handlers: Record<string, Handler> = { main: () => observation({ observationId: 1 }),
      old: () => observation({ framePath: [0], observationId: 5, documentId: 'old' }),
      fresh: () => observation({ framePath: [0], observationId: 9, documentId: 'new' }) }
    for (let i = 1; i <= 20; i++) handlers[`f${i}`] = () => observation({ framePath: [i], observationId: 1 })
    const result = await decisionSnapshot(framesOf(handlers), 1200, true)
    const kept = JSON.parse(result!.json).frames as { framePath: number[]; documentId?: string }[]
    expect(kept).toHaveLength(16)
    expect(kept[0]).toMatchObject({ framePath: [0], documentId: 'new' })
    expect(result!.paths.get('0')).toBe('fresh')
  })
})

describe('framePathKey', () => {
  it('accepts 1–4 small non-negative integers only', () => {
    expect(framePathKey([0, 3])).toBe('0.3')
    for (const bad of [[], [0, 0, 0, 0, 0], [-1], [1.5], [1000], ['0'], null, 'x']) expect(framePathKey(bad)).toBeNull()
  })
})

describe('taskAction', () => {
  const deliver = vi.fn(async () => true)
  const options = { inputCapable: true, deliver }
  const identity = { documentId: 'd', observationId: 1, interactionEpoch: 0 }

  it('acts in the main frame with real input decided here, never by the caller', async () => {
    const frames = framesOf({ main: () => '{"ok":true}' })
    const result = await taskAction(frames, new Map(), { operation: 'click', ref: 'e1', ...identity, deadline: Date.now() + 5000,
      trustedInput: false, expectedPoint: { x: 1, y: 1 } }, options)
    expect(result).toBe('{"ok":true}')
    const [frame, expression] = frames.calls[0]
    expect(frame).toBe('main')
    expect(expression.startsWith(runtimeCall('taskAction', {}).split('({')[0])).toBe(true)
    expect(JSON.parse(expression.match(/taskAction\((.*)\) :/)![1]))
      .toEqual({ operation: 'click', ref: 'e1', ...identity, deadline: expect.any(Number), trustedInput: true })
  })

  it('delivers the input the runtime asks for, and returns its answer without it', async () => {
    deliver.mockClear()
    const frames = framesOf({ main: () => '{"ok":true,"input":{"kind":"click","x":10,"y":20}}' })
    expect(await taskAction(frames, new Map(), { operation: 'click', ref: 'e1', deadline: Date.now() + 5000 }, options)).toBe('{"ok":true}')
    expect(deliver).toHaveBeenCalledWith({ kind: 'click', x: 10, y: 20 }, { x: 0, y: 0 })
  })

  it('never delivers after the deadline, and an undelivered input is an unknown outcome', async () => {
    const frames = framesOf({ main: () => '{"ok":true,"input":{"kind":"click","x":10,"y":20}}' })
    const late = vi.fn(async () => true)
    expect(JSON.parse(await taskAction(frames, new Map(), { operation: 'click', deadline: 1000 }, { inputCapable: true, deliver: late, now: () => 2000 })))
      .toEqual({ ok: false, code: 'deadline_exceeded' })
    expect(late).not.toHaveBeenCalled()
    for (const failed of [vi.fn(async () => false), vi.fn(async () => { throw new Error('socket') })])
      expect(JSON.parse(await taskAction(frames, new Map(), { operation: 'click', deadline: Date.now() + 5000 }, { inputCapable: true, deliver: failed })))
        .toEqual({ ok: false, code: 'write_outcome_unknown' })
  })

  it('passes refusals through, and a failed eval is an unknown outcome', async () => {
    expect(await taskAction(framesOf({ main: () => '{"ok":false,"code":"approval_required"}' }), new Map(), { operation: 'click' }, options))
      .toBe('{"ok":false,"code":"approval_required"}')
    expect(await taskAction(framesOf({ main: () => { throw new Error('gone') } }), new Map(), { operation: 'click' }, options))
      .toBe('{"ok":false,"code":"write_outcome_unknown"}')
  })

  it('gates a frame action in every enclosing document, then acts at the offset point', async () => {
    deliver.mockClear()
    const frames = framesOf({
      main: expression => expression.includes('frameGate') ? '{"ok":true,"x":20,"y":80}' : '{}',
      outer: expression => expression.includes('frameGate') ? '{"ok":true,"x":10,"y":30}' : '{}',
      inner: () => '{"ok":true,"input":{"kind":"click","x":5,"y":6}}',
    })
    const paths = new Map([['0', 'outer'], ['0.0', 'inner']])
    const request = { operation: 'click', ref: 'e2', documentId: 'inner-doc', observationId: 7, interactionEpoch: 0, deadline: Date.now() + 5000,
      frame: { path: [0, 0], point: { x: 35, y: 116 }, ancestors: [{ documentId: 'top', observationId: 1, interactionEpoch: 0 }, { documentId: 'outer-doc', observationId: 2, interactionEpoch: 0 }] } }
    expect(await taskAction(frames, paths, request, options)).toBe('{"ok":true}')
    const [gateTop, gateOuter, act] = frames.calls
    expect(gateTop[0]).toBe('main')
    expect(JSON.parse(gateTop[1].match(/frameGate\((.*)\) :/)![1])).toEqual({ documentId: 'top', observationId: 1, interactionEpoch: 0, index: 0, x: 35, y: 116, guardClick: true })
    expect(gateOuter[0]).toBe('outer')
    expect(JSON.parse(gateOuter[1].match(/frameGate\((.*)\) :/)![1])).toMatchObject({ documentId: 'outer-doc', index: 0, x: 15, y: 36 })
    expect(act[0]).toBe('inner')
    expect(JSON.parse(act[1].match(/taskAction\((.*)\) :/)![1])).toMatchObject({ ref: 'e2', trustedInput: true, expectedPoint: { x: 5, y: 6 } })
    expect(act[1]).not.toContain('"frame"')
    expect(deliver).toHaveBeenCalledWith({ kind: 'click', x: 5, y: 6 }, { x: 30, y: 110 })
  })

  it('only a click with real input guards the enclosing documents', async () => {
    const frames = framesOf({ main: () => '{"ok":true,"x":0,"y":0}', child: () => '{"ok":true}' })
    const frame = { path: [0], point: { x: 1, y: 1 }, ancestors: [{ documentId: 'top' }] }
    await taskAction(frames, new Map([['0', 'child']]), { operation: 'type', frame }, options)
    expect(frames.calls[0][1]).toContain('"guardClick":false')
  })

  it('is stale when the frame request is malformed, a frame is unknown, or a gate refuses', async () => {
    const gateRefuses = framesOf({ main: () => '{"ok":false,"code":"stale_observation"}', child: () => '{"ok":true}' })
    const good = { path: [0], point: { x: 1, y: 1 }, ancestors: [{ documentId: 'top' }] }
    const stale = '{"ok":false,"code":"stale_observation"}'
    for (const frame of [{ path: [], point: { x: 1, y: 1 }, ancestors: [] }, { ...good, ancestors: [] }, { ...good, point: { x: 'a', y: 1 } },
      { ...good, ancestors: ['top'] }, 'x'])
      expect(await taskAction(framesOf({ main: () => '{"ok":true,"x":0,"y":0}' }), new Map([['0', 'child']]), { operation: 'click', frame }, options)).toBe(stale)
    expect(await taskAction(framesOf({ main: () => '{"ok":true,"x":0,"y":0}' }), new Map(), { operation: 'click', frame: good }, options)).toBe(stale)
    expect(await taskAction(gateRefuses, new Map([['0', 'child']]), { operation: 'click', frame: good }, options)).toBe(stale)
    expect(gateRefuses.calls.some(([frame]) => frame === 'child')).toBe(false)
  })
})
