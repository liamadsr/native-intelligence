import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolverStepIndex } from '../resolver-step'

vi.mock('eve/context', () => ({
  defineState: <T,>(_name: string, initial: () => T) => {
    let value = initial()
    return { get: () => value, update: (fn: (v: T) => T) => void (value = fn(value)) }
  },
}))

/**
 * The browser-dispatch usage scope is built in the step.started model resolver,
 * whose stepIndex eve 0.79 reports as the PREVIOUS step past the first; the
 * meter reads by the stream's true index. resolverStepIndex corrects it.
 */

const eveRoot = dirname(createRequire(import.meta.url).resolve('eve/package.json'))

describe('resolverStepIndex', () => {
  it('turns eve’s 0, 0, 1, 2 into 0, 1, 2, 3, using the history only when eve says 0', () => {
    expect(resolverStepIndex(0, [{ role: 'user' }])).toBe(0)
    expect(resolverStepIndex(0, [{ role: 'user' }, { role: 'assistant' }, { role: 'tool' }])).toBe(1)
    expect(resolverStepIndex(1, [{ role: 'user' }])).toBe(2)
    expect(resolverStepIndex(2)).toBe(3)
    expect(resolverStepIndex(0)).toBe(0)
  })

  it('matches eve’s own projection: the resolver position reads the previous step past the first', async () => {
    type P = unknown
    const projection = (await import(pathToFileURL(join(eveRoot, 'dist/src/protocol/session-projection.js')).href)) as {
      initialSessionProjection: () => P
      foldSession: (p: P, e: unknown) => P
      turnCoordinates: (p: P) => { stepIndex: number }
    }
    const meta = (i: number) => ({ meta: { id: `e${i}`, at: '2026-10-15T00:00:00.000Z' } })
    let p = projection.initialSessionProjection()
    p = projection.foldSession(p, { type: 'turn.started', data: { turnId: 't', sequence: 1 }, ...meta(0) })
    const history: Array<{ role: string }> = [{ role: 'user' }]
    const corrected: number[] = []
    for (let step = 0; step < 4; step++) {
      corrected.push(resolverStepIndex(projection.turnCoordinates(p).stepIndex, history))
      p = projection.foldSession(p, { type: 'step.started', data: { turnId: 't', sequence: 1, stepIndex: step, modelId: 'm' }, ...meta(step * 2 + 1) })
      p = projection.foldSession(p, { type: 'step.completed', data: { turnId: 't', sequence: 1, stepIndex: step, finishReason: 'tool-calls' }, ...meta(step * 2 + 2) })
      history.push({ role: 'assistant' }, { role: 'tool' })
    }
    expect(corrected).toEqual([0, 1, 2, 3])
  })
})
