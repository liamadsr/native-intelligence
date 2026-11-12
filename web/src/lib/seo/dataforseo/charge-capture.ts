/**
 * What the provider charged during one metered call, read off the raw
 * response before any of its result is parsed.
 *
 * Every metered call runs inside runCapturingCharges (client.ts,
 * execForMeter). The transport (core.ts) and the one fetcher that reads its
 * own body (lighthouse.ts) hand each parsed response to
 * noteDataforseoCharges, which adds up the cost of every task in it. When
 * the call then throws for ANY reason (a result whose shape changed, a
 * classified task error, a fetcher's own check), the error leaves the
 * choke point as a DataforseoChargedTaskError carrying what was charged, so
 * the meter writes the ledger row. A failure before anything was charged (no
 * response, a timeout, a task the provider did not bill) leaves unchanged and
 * writes nothing.
 *
 * Outside a metered call (free task collection, reference lists, the
 * sandbox) noting does nothing.
 */
import 'server-only'

import { AsyncLocalStorage } from 'node:async_hooks'

import { DataforseoChargedTaskError, SeoError } from '@/lib/seo/errors'

import type { DataforseoApiCallCost } from './envelope'

interface ChargeTally {
  path: string[] | null
  costUsd: number
}

const tallies = new AsyncLocalStorage<ChargeTally>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isPath(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((part) => typeof part === 'string')
  )
}

/**
 * Adds the cost of every task in a parsed provider response to the metered
 * call in progress. Call it as soon as the body is parsed, before anything
 * reads the result. `requestPath` names the endpoint when no task does.
 */
export function noteDataforseoCharges(
  response: unknown,
  requestPath: string,
): void {
  const tally = tallies.getStore()
  if (!tally || !isRecord(response) || !Array.isArray(response.tasks)) return
  for (const task of response.tasks) {
    if (!isRecord(task)) continue
    const cost = task.cost
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost <= 0)
      continue
    tally.costUsd += cost
    tally.path ??= isPath(task.path)
      ? task.path
      : requestPath.split('?')[0].split('/').filter(Boolean)
  }
}

/** The billing a failed call must carry: what was charged, when that is more than the error already says. */
function chargedFailure(error: unknown, tally: ChargeTally): unknown {
  if (tally.costUsd <= 0 || !tally.path) return error
  if (
    error instanceof DataforseoChargedTaskError &&
    error.billing.costUsd >= tally.costUsd
  )
    return error
  const billing: DataforseoApiCallCost = {
    path: tally.path,
    costUsd: tally.costUsd,
  }
  const charged = new DataforseoChargedTaskError(
    error instanceof Error ? error.message : String(error),
    billing,
    error instanceof DataforseoChargedTaskError && error.isInvalidField,
    error instanceof SeoError ? error.code : 'INTERNAL_ERROR',
  )
  charged.cause = error
  return charged
}

/**
 * Runs one metered call and makes any throw after the provider charged for it
 * carry that charge (as a DataforseoChargedTaskError, keeping the original
 * code and message, the original as `cause`).
 */
export async function runCapturingCharges<T>(
  exec: () => Promise<T>,
): Promise<T> {
  const tally: ChargeTally = { path: null, costUsd: 0 }
  try {
    return await tallies.run(tally, exec)
  } catch (error) {
    throw chargedFailure(error, tally)
  }
}
