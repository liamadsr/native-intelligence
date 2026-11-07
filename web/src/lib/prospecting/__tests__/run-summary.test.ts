/**
 * `run-summary.ts` — the one place that knows how to read a list's LAST RUN
 * off a views-system row.
 *
 * Three things go wrong here without tests and none of them throw:
 *  - the embed arrives as an ARRAY (PostgREST) but as a bare object in
 *    fixtures and single-row fetches, and a row renderer that handles one
 *    shape silently shows no run chip on the other;
 *  - `spent_dollars` is a numeric, which PostgREST hands back as a STRING —
 *    `.toFixed()` on it is a TypeError in the middle of a list;
 *  - `budget_exhausted` is an OUTCOME, not a failure (§9). The run kept every
 *    partial result, so a summary that folds it into `failed` greys out a run
 *    that worked and hides the count it produced.
 */
import { describe, it, expect } from 'vitest'
import {
  embeddedRun,
  formatRunSpend,
  isRunLive,
  lastRunOf,
  runChipLabel,
  runKindOf,
  runNewCount,
  runSpend,
  runSummaryLabel,
  runTimestamp,
  summarizeRun,
  type LastRun,
} from '../run-summary'
import { PROSPECTING_RUN_STATUSES } from '../types'
import { isLive } from '../runs'

const run = (over: Partial<LastRun> = {}): LastRun => ({
  id: 'run-1',
  kind: 'discover',
  status: 'completed',
  spent_dollars: 0.42,
  progress: { new: 7 },
  started_at: '2026-09-05T10:00:00Z',
  finished_at: '2026-09-05T10:04:00Z',
  created_at: '2026-09-05T09:59:00Z',
  ...over,
})

describe('isRunLive', () => {
  it('is the SAME predicate as runs.ts isLive, over the whole vocabulary', () => {
    // run-summary duplicates the live list rather than importing runs.ts
    // (which pulls in the Inngest client and cannot be loaded by a client row
    // component). This is what stops the copy from drifting.
    for (const status of PROSPECTING_RUN_STATUSES) {
      expect(isRunLive(status), status).toBe(isLive(status))
    }
  })

  it('says live for the four in-flight statuses and nothing else', () => {
    expect(['queued', 'running', 'needs_input', 'canceling'].every(isRunLive)).toBe(true)
    expect(['completed', 'failed', 'canceled', 'budget_exhausted'].some(isRunLive)).toBe(false)
  })

  it('tolerates null / undefined / garbage', () => {
    expect(isRunLive(null)).toBe(false)
    expect(isRunLive(undefined)).toBe(false)
    expect(isRunLive('nonsense')).toBe(false)
  })
})

describe('lastRunOf', () => {
  it('unwraps the PostgREST array — index 0 IS the newest run', () => {
    // The select embeds prospecting_run ordered created_at desc, limit 1.
    const item = { id: 'l1', prospecting_run: [run({ id: 'newest' })] }
    expect(lastRunOf(item)?.id).toBe('newest')
  })

  it('accepts a bare object too — fixtures and single-row fetches', () => {
    expect(lastRunOf({ prospecting_run: run({ id: 'solo' }) })?.id).toBe('solo')
  })

  it('returns null for a list that has never run, not a throw', () => {
    // A row renderer that throws on this is a blank Prospecting page for any
    // workspace with a fresh list in it.
    expect(lastRunOf({ id: 'l1' })).toBeNull()
    expect(lastRunOf({ id: 'l1', prospecting_run: [] })).toBeNull()
    expect(lastRunOf({ id: 'l1', prospecting_run: null })).toBeNull()
    expect(lastRunOf(null)).toBeNull()
    expect(lastRunOf('nope')).toBeNull()
  })

  it('embeddedRun is the same function under the row component’s name', () => {
    expect(embeddedRun).toBe(lastRunOf)
  })
})

describe('runSpend', () => {
  it('coerces the string PostgREST returns for a numeric', () => {
    expect(runSpend(run({ spent_dollars: '0.4200' }))).toBeCloseTo(0.42)
  })

  it('falls back to 0 rather than NaN', () => {
    expect(runSpend(run({ spent_dollars: null }))).toBe(0)
    expect(runSpend(run({ spent_dollars: 'not a number' }))).toBe(0)
    expect(runSpend(null)).toBe(0)
  })

  it('formats to two decimals — this is real money', () => {
    expect(formatRunSpend(0.4)).toBe('$0.40')
    expect(formatRunSpend(12)).toBe('$12.00')
  })
})

describe('runNewCount', () => {
  it('reads progress.new — the number the run already recorded', () => {
    expect(runNewCount(run({ progress: { new: 12 } }))).toBe(12)
  })

  it('is 0 for a missing / malformed progress blob', () => {
    expect(runNewCount(run({ progress: null }))).toBe(0)
    expect(runNewCount(run({ progress: [] }))).toBe(0)
    expect(runNewCount(run({ progress: { new: 'lots' } }))).toBe(0)
    expect(runNewCount(null)).toBe(0)
  })
})

describe('runTimestamp', () => {
  it('prefers finished, then started, then created', () => {
    expect(runTimestamp(run())).toBe('2026-09-05T10:04:00Z')
    expect(runTimestamp(run({ finished_at: null }))).toBe('2026-09-05T10:00:00Z')
    expect(runTimestamp(run({ finished_at: null, started_at: null }))).toBe('2026-09-05T09:59:00Z')
    expect(runTimestamp(null)).toBeNull()
  })
})

describe('summarizeRun', () => {
  it('is null with no run — the row shows NO chip, not a "never run" one', () => {
    expect(summarizeRun(null)).toBeNull()
  })

  it('separates budget_exhausted from failure', () => {
    // §9: the run kept every partial result. A summary that greys it out like
    // a failure lies about a run that worked.
    const capped = summarizeRun(run({ status: 'budget_exhausted', progress: { new: 5 } }))!
    expect(capped.budgetExhausted).toBe(true)
    expect(capped.failed).toBe(false)
    expect(capped.newCount).toBe(5)
  })

  it('counts failed and canceled as failed, live as live', () => {
    expect(summarizeRun(run({ status: 'failed' }))!.failed).toBe(true)
    expect(summarizeRun(run({ status: 'canceled' }))!.failed).toBe(true)
    expect(summarizeRun(run({ status: 'running' }))!.live).toBe(true)
    expect(summarizeRun(run({ status: 'running' }))!.failed).toBe(false)
  })

  it('nulls a status it does not recognise instead of passing it through', () => {
    const s = summarizeRun(run({ status: 'pr_open' }))!
    expect(s.status).toBeNull()
    expect(s.live).toBe(false)
    expect(s.failed).toBe(false)
  })

  it('narrows the kind, or nulls it', () => {
    expect(runKindOf(run({ kind: 'people' }))).toBe('people')
    expect(runKindOf(run({ kind: 'wat' }))).toBeNull()
    expect(runKindOf(null)).toBeNull()
  })
})

describe('runChipLabel', () => {
  it('says Finding… while live, and owns no spend figure', () => {
    expect(runChipLabel(summarizeRun(run({ status: 'running' })))).toBe('Finding…')
  })

  it('shows the count AND the cost when a run found something', () => {
    expect(runChipLabel(summarizeRun(run({ progress: { new: 7 }, spent_dollars: 0.42 }))))
      .toBe('7 new')
  })

  it('still shows the cost when a run found nothing', () => {
    // A run that disappointed still cost money, and hiding the spend on
    // exactly those runs is the dishonest half of the pair.
    expect(runChipLabel(summarizeRun(run({ progress: { new: 0 }, spent_dollars: 0.18 }))))
      .toBe('Nothing new')
  })

  it('keeps the count on a capped run — the cap is a separate chip', () => {
    expect(runChipLabel(summarizeRun(run({ status: 'budget_exhausted', progress: { new: 3 } }))))
      .toBe('3 new')
  })

  it('says Failed / Canceled plainly', () => {
    expect(runChipLabel(summarizeRun(run({ status: 'failed' })))).toBe('Failed')
    expect(runChipLabel(summarizeRun(run({ status: 'canceled' })))).toBe('Canceled')
  })

  it('is null with no summary', () => {
    expect(runChipLabel(null)).toBeNull()
  })
})

describe('runSummaryLabel', () => {
  it('is the one-shot form: raw run in, chip text out', () => {
    expect(runSummaryLabel(run({ progress: { new: 2 }, spent_dollars: 1 }))).toBe('2 new')
    expect(runSummaryLabel(run({ status: 'running' }))).toBe('Finding…')
    expect(runSummaryLabel(null)).toBeNull()
  })

  it('names the cap, because it has no second chip to lean on', () => {
    expect(runSummaryLabel(run({ status: 'budget_exhausted', spent_dollars: 2 })))
      .toBe('Stopped early')
  })
})
