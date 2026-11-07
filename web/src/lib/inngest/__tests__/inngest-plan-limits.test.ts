import { beforeAll, describe, expect, it, vi } from 'vitest'
import { HOME_ASKS_BATCH_MAX, HOME_ASKS_BATCH_TIMEOUT } from '@/lib/attention/home-asks'

type RegisteredFunction = {
  id(): string
  opts: { concurrency?: number | { limit: number } | { limit: number }[]; batchEvents?: { maxSize: number; timeout?: string } }
}

const registered = vi.hoisted(() => ({ functions: [] as RegisteredFunction[] }))

// The serve route's list is what the hourly sync registers: capture it as passed.
vi.mock('inngest/next', () => ({
  serve: (opts: { functions: RegisteredFunction[] }) => {
    registered.functions = opts.functions
    return { GET: () => {}, POST: () => {}, PUT: () => {} }
  },
}))

/** Inngest's plan allows at most 5 for a concurrency limit and a batch size. */
const PLAN_LIMIT = 5

function concurrencyLimits(c: RegisteredFunction['opts']['concurrency']): number[] {
  if (c === undefined) return []
  if (typeof c === 'number') return [c]
  return (Array.isArray(c) ? c : [c]).map((o) => o.limit)
}

/**
 * Inngest refuses a function whose batch is larger than the plan allows (5),
 * whose batch timeout is longer than 30 s, or whose concurrency limit is above 5,
 * and that refusal fails the whole app sync: every function's changes stay
 * unregistered. On 2026-10-20 home-asks shipped with 25 and the hourly
 * /api/cron/inngest-sync logged "The batch size for function 'home-asks'
 * cannot be larger than 5". On 2026-10-27 email-auto-archive shipped with an
 * overall concurrency of 10 and the sync logged "The function
 * 'email-auto-archive' has higher concurrency limits (10) than your plan limit of 5".
 */
describe('Inngest plan limits', () => {
  let fns: RegisteredFunction[] = []
  // The route imports every function module, which takes several seconds to transform.
  beforeAll(async () => {
    await import('@/app/api/inngest/route')
    fns = registered.functions
  }, 120_000)

  it('home-asks batches at most 5 events', () => {
    expect(HOME_ASKS_BATCH_MAX).toBeLessThanOrEqual(5)
  })

  it('home-asks closes a batch within 30 seconds', () => {
    const m = /^(\d+)s$/.exec(HOME_ASKS_BATCH_TIMEOUT)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBeLessThanOrEqual(30)
  })

  it('every registered function keeps each concurrency limit at or under the plan limit', () => {
    expect(fns.length).toBeGreaterThan(0)
    const over = fns.flatMap((fn) =>
      concurrencyLimits(fn.opts.concurrency)
        .filter((limit) => limit > PLAN_LIMIT)
        .map((limit) => `${fn.id()}: ${limit}`),
    )
    expect(over).toEqual([])
  })

  it('every registered function batches at most 5 events within 30 seconds', () => {
    const over = fns.flatMap((fn) => {
      const batch = fn.opts.batchEvents
      if (!batch) return []
      const timeout = batch.timeout === undefined ? null : /^(\d+)s$/.exec(batch.timeout)
      const bad: string[] = []
      if (batch.maxSize > PLAN_LIMIT) bad.push(`${fn.id()}: maxSize ${batch.maxSize}`)
      if (batch.timeout !== undefined && (!timeout || Number(timeout[1]) > 30)) bad.push(`${fn.id()}: timeout ${batch.timeout}`)
      return bad
    })
    expect(over).toEqual([])
  })
})
