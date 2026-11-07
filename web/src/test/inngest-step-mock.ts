/**
 * Shared Inngest `step` mock for the createFunction-capture test pattern.
 *
 * Inngest function tests in this repo grab the handler passed to
 * `inngest.createFunction(config, handler)` and call it directly with a fake
 * `step`. Every test file used to hand-roll that fake:
 *
 *   const step = { run: vi.fn(async (_id, fn) => fn()), sendEvent: vi.fn(...) }
 *
 * which is fine until it isn't — see the TRIPWIRE below.
 *
 * Usage:
 *   import { createStepMock } from '@/test/inngest-step-mock'
 *   const step = createStepMock()
 *   const out = await handler({ event, step })
 *   expect(step.sendEvent).toHaveBeenCalledWith('continue', expect.anything())
 *
 * Every method is a `vi.fn`, so `.mock.calls` / `toHaveBeenCalledWith` work as
 * before. Pass overrides to change what a method resolves to:
 *   createStepMock({ waitForEvent: async () => ({ name: 'x', data: {} }) })
 *
 * ---------------------------------------------------------------------------
 * TRIPWIRE — illegal nested step tooling
 * ---------------------------------------------------------------------------
 * Calling any step tool (`step.sendEvent`, `step.run`, `step.sleep`, ...) from
 * INSIDE a `step.run` callback is illegal in the Inngest TS SDK. It does not
 * throw in production: the request hangs (for minutes) and the run completes
 * having performed NOTHING of the nested call. hubspot-push-sweep shipped with
 * exactly that shape — `step.sendEvent` nested in the per-page `step.run` —
 * and swept thousands of contacts while emitting zero events. The hand-rolled
 * mocks all happily allowed the nesting, so every test passed.
 *
 * This mock closes that hole: `run` executes its callback inside an
 * AsyncLocalStorage context, and every step method throws
 * NESTED_STEP_ERROR when invoked while that context is active — including
 * after `await`s inside the callback, and inside helper functions it calls.
 *
 * Parallel steps (`await Promise.all([step.run(a), step.run(b)])`) are legal
 * Inngest and are NOT flagged: the sibling call is made from the handler's own
 * async context, not from inside a running callback.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { vi, type Mock } from 'vitest'

export const NESTED_STEP_ERROR =
  'Illegal nested step.* call inside step.run — this deadlocks in production'

/** Active for the duration (including awaits) of a `step.run` callback. */
const insideStepRun = new AsyncLocalStorage<true>()

/** Throw if we're currently executing inside a `step.run` callback. */
function assertNotNested(method: string): void {
  if (insideStepRun.getStore()) {
    throw new Error(`${NESTED_STEP_ERROR} (step.${method})`)
  }
}

/** The step tools this mock exposes. Add more as functions start using them. */
const STEP_METHODS = [
  'run',
  'sendEvent',
  'sleep',
  'sleepUntil',
  'waitForEvent',
  'invoke',
  'sendSignal',
  'waitForSignal',
] as const

type StepMethod = (typeof STEP_METHODS)[number]

type AnyFn = (...args: never[]) => unknown

export type StepMockOverrides = Partial<Record<StepMethod, AnyFn>>

export type StepMock = Record<StepMethod, Mock> & {
  run: Mock
  sendEvent: Mock
}

/** Default implementations — overridable per test. */
const defaults: Record<StepMethod, AnyFn> = {
  // `run` is special-cased in createStepMock (it has to open the context);
  // this entry only supplies the "what does the callback result become" part.
  run: (async () => undefined) as AnyFn,
  sendEvent: (async () => ({ ids: ['evt-1'] })) as AnyFn,
  sleep: (async () => undefined) as AnyFn,
  sleepUntil: (async () => undefined) as AnyFn,
  waitForEvent: (async () => null) as AnyFn,
  invoke: (async () => undefined) as AnyFn,
  sendSignal: (async () => ({ ids: ['sig-1'] })) as AnyFn,
  waitForSignal: (async () => null) as AnyFn,
}

/**
 * Build a fake Inngest `step` object whose methods are `vi.fn`s and which
 * refuses illegal nesting (see TRIPWIRE above).
 *
 * `run(id, fn)` invokes `fn` immediately (no memoization/replay simulation —
 * these are unit tests of one invocation) and resolves to its return value,
 * unless a `run` override is supplied.
 */
export function createStepMock(overrides: StepMockOverrides = {}): StepMock {
  const step = {} as Record<StepMethod, Mock>

  step.run = vi.fn(async (id: string, fn: () => unknown) => {
    assertNotNested('run')
    const override = overrides.run
    if (override) {
      return (override as (id: string, fn: () => unknown) => unknown)(id, fn)
    }
    // Run the callback inside the tripwire context so any step.* call it makes
    // — directly or through a helper, before or after an await — throws.
    return insideStepRun.run(true, async () => fn())
  })

  for (const method of STEP_METHODS) {
    if (method === 'run') continue
    const impl = (overrides[method] ?? defaults[method]) as (
      ...args: unknown[]
    ) => unknown
    step[method] = vi.fn((...args: unknown[]) => {
      assertNotNested(method)
      return impl(...args)
    })
  }

  return step as StepMock
}
