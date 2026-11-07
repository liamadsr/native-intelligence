/**
 * CONTRACT test for the step ceiling's one dependency on eve internals: the
 * shape of the event eve hands a `step.started` model resolver.
 *
 * stepIndexOf (../spec-client.ts) reads `event.data.stepIndex`, and
 * stepCeilingError REFUSES any step whose index it cannot read. That fails
 * closed, which is right for safety, but it means a renamed or moved field in
 * an eve bump would fail EVERY utility kind (titles, drafts, briefs, judges,
 * claim extraction, reference ingest) at step 0 in production, while every
 * mocked test (resolvers.test.ts feeds a hand-written event) stayed green.
 *
 * So this reads eve's shipped code (the installed dist, not memory) and pins:
 *   1. the installed version this was reviewed at — a bump fails here first,
 *      with instructions;
 *   2. model-call/run.js selectModel dispatches the step.started model event
 *      with `stepIndex` inside `data`, read from the turn's position BEFORE
 *      the step starts;
 *   3. that position, folded by eve's own session projection, reads 0, 0, 1
 *      for steps 0, 1, 2 (the previous step's index past the first), and
 *      stepIndexOf corrects it from ctx.messages to 0, 1, 2, so a session's
 *      first model step is index 0 and TEXT_MAX_STEPS = 1 lets exactly that one
 *      through;
 *   4. eve's own step.started event builder (protocol/message.js) produces an
 *      event our reader accepts at the right index.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { stepCeilingError, stepIndexOf, type UtilitySpec } from '../spec-client'

const eveRoot = dirname(createRequire(import.meta.url).resolve('eve/package.json'))
const distFile = (rel: string) => join(eveRoot, 'dist/src', rel)
const load = async <T>(rel: string) => (await import(pathToFileURL(distFile(rel)).href)) as T

const REVIEWED_EVE_VERSION = '0.79.1'
/** src/lib/eve/utility/spec.ts's TEXT_MAX_STEPS / STRUCTURED_MAX_STEPS (agent code can't import src/; the spec route test pins the per-kind table). */
const TEXT_MAX_STEPS = 1
const STRUCTURED_MAX_STEPS = 2

function spec(maxSteps: number): UtilitySpec {
  return { kind: 'generate_title', model: 'deepseek/deepseek-v4-flash', systemPrompt: 'x', maxSteps }
}

describe('eve step.started contract (utility step ceiling)', () => {
  it(`is reviewed against eve ${REVIEWED_EVE_VERSION}`, () => {
    const { version } = JSON.parse(readFileSync(join(eveRoot, 'package.json'), 'utf8')) as { version: string }
    expect(
      version,
      'eve was bumped: re-verify the step.started event shape stepIndexOf (agents/utility/lib/spec-client.ts) reads, then update REVIEWED_EVE_VERSION',
    ).toBe(REVIEWED_EVE_VERSION)
  })

  it('selectModel dispatches step.started to the model resolver with data.stepIndex from the turn position', () => {
    const src = readFileSync(distFile('harness/model-call/run.js'), 'utf8')
    expect(src).toContain(
      'let i=e.position();await n.dispatchDynamicModelEvent({ctx:r,event:stepStartedForResolvers({modelId:e.session.agent.modelReference?.id??`dynamic`,sequence:i.sequence,stepIndex:i.stepIndex,turnId:activeTurnId(i)})',
    )
    // …before the step itself starts (startStep runs after selectModel resolves).
    expect(src.indexOf('a=await selectModel(e,i)')).toBeGreaterThan(-1)
    expect(src.indexOf('a=await selectModel(e,i)')).toBeLessThan(src.indexOf('startStep(e.view()'))
  })

  it('the position reads the previous step past the first; stepIndexOf corrects it from the messages', async () => {
    type Projection = unknown
    const projection = await load<{
      initialSessionProjection: () => Projection
      foldSession: (p: Projection, e: unknown) => Projection
      turnCoordinates: (p: Projection) => { stepIndex: number }
    }>('protocol/session-projection.js')
    const { createStepStartedEvent } = await load<{ createStepStartedEvent: (e: object) => object }>('protocol/message.js')
    const stamp = (e: object, i: number) => ({ ...e, meta: { id: `evt_${i}`, at: '2026-10-15T00:00:00.000Z' } })
    let p = projection.initialSessionProjection()
    p = projection.foldSession(p, stamp({ type: 'turn.started', data: { turnId: 't-1', sequence: 1 } }, 0))
    const seen: number[] = []
    const corrected: unknown[] = []
    const history: Array<{ role: string }> = [{ role: 'user' }]
    for (let step = 0; step < 3; step++) {
      const position = projection.turnCoordinates(p).stepIndex
      seen.push(position)
      corrected.push(stepIndexOf({ type: 'step.started', data: { sequence: 1, stepIndex: position, turnId: 't-1' } }, history))
      p = projection.foldSession(p, stamp(createStepStartedEvent({ modelId: 'm', sequence: 1, stepIndex: step, turnId: 't-1' }), step * 2 + 1))
      p = projection.foldSession(p, stamp({ type: 'step.completed', data: { sequence: 1, stepIndex: step, turnId: 't-1', finishReason: 'tool-calls' } }, step * 2 + 2))
      history.push({ role: 'assistant' }, { role: 'tool' })
    }
    expect(seen).toEqual([0, 0, 1])
    expect(corrected).toEqual([0, 1, 2])
  })

  it('stepIndexOf takes the larger of eve\'s index and the steps the messages show, and refuses an unreadable one', () => {
    const at = (stepIndex: unknown) => ({ type: 'step.started', data: { sequence: 1, stepIndex, turnId: 't-1' } })
    expect(stepIndexOf(at(2), [{ role: 'user' }])).toBe(2)
    expect(stepIndexOf(at(0), [{ role: 'user' }, { role: 'assistant' }, { role: 'tool' }])).toBe(1)
    // Only the steps since the turn's user message count.
    expect(stepIndexOf(at(0), [{ role: 'assistant' }, { role: 'user' }])).toBe(0)
    expect(stepIndexOf(at(undefined), [{ role: 'assistant' }])).toBeUndefined()
    expect(stepIndexOf(at(-1))).toBe(-1)
  })

  it("eve's own step.started event is read at its index and gated by the ceiling", async () => {
    const { createStepStartedEvent } = await load<{
      createStepStartedEvent: (e: { modelId: string; sequence: number; stepIndex: number; turnId: string }) => unknown
    }>('protocol/message.js')
    const at = (stepIndex: number) =>
      createStepStartedEvent({ modelId: 'deepseek/deepseek-v4-flash', sequence: 1, stepIndex, turnId: 't-1' })

    expect(stepIndexOf(at(0))).toBe(0)
    expect(stepIndexOf(at(1))).toBe(1)
    // Text kinds: the first step runs, a second is refused.
    expect(stepCeilingError(spec(TEXT_MAX_STEPS), stepIndexOf(at(0)))).toBeNull()
    expect(stepCeilingError(spec(TEXT_MAX_STEPS), stepIndexOf(at(1)))).toBeInstanceOf(Error)
    // Structured kinds: the answer plus one repair, then refused.
    expect(stepCeilingError(spec(STRUCTURED_MAX_STEPS), stepIndexOf(at(1)))).toBeNull()
    expect(stepCeilingError(spec(STRUCTURED_MAX_STEPS), stepIndexOf(at(2)))).toBeInstanceOf(Error)
  })
})
