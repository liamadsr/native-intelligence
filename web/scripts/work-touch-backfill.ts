/**
 * One-time `work_touch` backfill (Sequence step 2, plan §2.3): recover, from
 * durable history, the touches for work items that settled before the live
 * write points existed — deliverables, verdict ledgers, extraction ledgers,
 * flow-run subjects, coding-run actions and declared resources. Reads other
 * than the two the sources assert are not recoverable and are not invented.
 *
 * Idempotent on (work_item_id, entity_type, entity_id, verb): a re-run skips
 * rows an earlier run wrote (and migration 280's partial unique index backstops
 * it). The planner lives in src/lib/work/touch-backfill.ts (unit-tested); this
 * is a thin env + CLI wrapper.
 *
 * DRY-RUN by default — pass --apply to write.
 *
 * Usage:
 *   npx tsx scripts/work-touch-backfill.ts [--apply] [--workspace <id>]
 *
 * Required env vars (loaded from .env.local if present):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY   — anon key silently reads 0 rows under RLS.
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { runWorkTouchBackfill } from '../src/lib/work/touch-backfill'

config({ path: '.env.local' })

const APPLY = process.argv.includes('--apply')
const wsFlag = process.argv.indexOf('--workspace')
const WORKSPACE_FILTER = wsFlag >= 0 ? process.argv[wsFlag + 1] : null

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL')
if (!SUPABASE_KEY) {
  throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY — the anon client reads 0 rows under RLS. Set it before running.')
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })

async function main() {
  console.log(`Target: ${SUPABASE_URL}`)
  console.log(`Mode: ${APPLY ? 'APPLY' : 'dry-run (pass --apply to write)'}`)
  if (WORKSPACE_FILTER) console.log(`Workspace filter: ${WORKSPACE_FILTER}`)
  console.log('')

  const summary = await runWorkTouchBackfill(supabase, {
    apply: APPLY,
    workspaceId: WORKSPACE_FILTER,
    log: (msg) => console.log(`  ${msg}`),
  })

  console.log('')
  console.log(`Work items scanned:      ${summary.jobsScanned}`)
  console.log(`Work items with touches: ${summary.jobsWithTouches}`)
  console.log(`Touches planned:         ${summary.planned}`)
  console.log(`Already present:         ${summary.skippedExisting}`)
  console.log(`Touches ${APPLY ? 'written' : 'to write'}:        ${APPLY ? summary.written : summary.planned - summary.skippedExisting}`)
  console.log(`By verb:                 ${JSON.stringify(summary.byVerb)}`)
  console.log(`By source:               ${JSON.stringify(summary.bySource)}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
