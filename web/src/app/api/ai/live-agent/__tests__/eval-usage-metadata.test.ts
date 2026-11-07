/**
 * Guard test: the usage row an EVAL turn writes must carry the capture id.
 *
 * `readBackUsage` (src/lib/evals/run-trial.ts) sums a trial's token spend out of
 * `ai_usage_logs`, narrowed by `metadata.eval` and a time window. That table has
 * no workspace_id, and the run token's identity is a plain user id — so one user
 * with eval runs in two workspaces has each trial summing the other's rows, and
 * the inflated total is what `max_cost_usd` and the monthly cap then read.
 * `metadata.captureId` is the only per-trial discriminator, and the reader is
 * null-safe, so a producer that stops stamping it fails SILENTLY: the numbers
 * just go wrong. That is what this reads the source to prevent.
 *
 * Source-scan rather than execution, matching ./no-act-literal.test.ts: the
 * route pulls in the whole server import graph, and the invariant is textual —
 * "the eval branch of the usage metadata names captureId".
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROUTE_DIR = join(process.cwd(), 'src/app/api/ai/live-agent')

/** The `...(isEvalCapture ? { ... } : {})` spread inside the metadata object.
 *  `[^}]` already spans newlines, so no `s` flag is needed (nor available at
 *  this tsconfig target). */
const EVAL_METADATA_BRANCH = /isEvalCapture\s*\?\s*\{\s*eval:\s*true[^}]*\}/

describe('live-agent eval usage metadata', () => {
  const src = readFileSync(join(ROUTE_DIR, 'route.ts'), 'utf8')

  it('stamps captureId on the eval branch of the usage metadata', () => {
    const match = src.match(EVAL_METADATA_BRANCH)
    expect(match, 'the eval usage metadata branch moved or was renamed').not.toBeNull()
    expect(match![0]).toContain('realCostUsd')
    expect(match![0]).toMatch(/captureId:\s*capture_id/)
  })

  it('readBackUsage still narrows on metadata.captureId', () => {
    // The other half of the contract: a reader that stopped filtering would make
    // the stamp above dead weight and the cross-workspace inflation would return.
    const reader = readFileSync(join(process.cwd(), 'src/lib/evals/run-trial.ts'), 'utf8')
    expect(reader).toMatch(/metadata\.captureId/)
  })
})
