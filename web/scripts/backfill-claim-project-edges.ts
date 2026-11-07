/**
 * One-time mechanical backfill: write the missing `about→project` entity_link
 * edge for active claims whose capture / document / attachment source carries a
 * resolvable project_id but that never got the edge (knowledge-recall plan
 * item 15 / design-scopedRecall §A4a).
 *
 * Why: document-sourced claims never got an about→project edge (a straight bug
 * in claim-extraction, fixed forward), and any capture/attachment processed
 * before its source had a project assigned also missed it. A claim with no
 * about→project edge is invisible to `list_claims entity_type='project'`, so
 * "what's new on project X" undercounts. This repairs the historical damage.
 *
 * MECHANICAL tier only — links only when a capture/document/attachment source
 * resolves to a project_id. It writes NOTHING for email/conversation/external_url
 * claims (they have no project to inherit — that's the weaver judge's job).
 * Idempotent: every edge is upserted against entity_link's unique constraint, so
 * re-running is a no-op for edges that already exist.
 *
 * DRY-RUN by default — pass --apply to write. The decision logic lives in
 * src/lib/knowledge/project-edge-backfill.ts (unit-tested); this is a thin
 * env + CLI wrapper over runProjectEdgeBackfill.
 *
 * Usage:
 *   npx tsx scripts/backfill-claim-project-edges.ts [--apply] [--workspace <id>]
 *   npx tsx --env-file=/tmp/dev.env scripts/backfill-claim-project-edges.ts --apply
 *
 * Required env vars (loaded from .env.local if present):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY   — anon key silently writes 0 rows under RLS.
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { runProjectEdgeBackfill } from '../src/lib/knowledge/project-edge-backfill'

config({ path: '.env.local' })

const APPLY = process.argv.includes('--apply')
const wsFlag = process.argv.indexOf('--workspace')
const WORKSPACE_FILTER = wsFlag >= 0 ? process.argv[wsFlag + 1] : null

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL')
if (!SUPABASE_KEY) {
  throw new Error(
    'Missing SUPABASE_SERVICE_ROLE_KEY — the anon client silently writes 0 rows under RLS. Set it before running.',
  )
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
})

async function main() {
  console.log(`Target: ${SUPABASE_URL}`)
  console.log(`Mode: ${APPLY ? 'APPLY' : 'dry-run (pass --apply to write)'}`)
  if (WORKSPACE_FILTER) console.log(`Workspace filter: ${WORKSPACE_FILTER}`)
  console.log('')

  const summary = await runProjectEdgeBackfill(supabase, {
    apply: APPLY,
    workspaceId: WORKSPACE_FILTER,
    log: (msg) => console.log(`  ${msg}`),
  })

  console.log('')
  console.log(`Scanned active claims:        ${summary.scanned}`)
  console.log(`Candidates (no project edge): ${summary.candidates}`)
  console.log(`Edges ${APPLY ? 'written' : 'to write'}:              ${APPLY ? summary.edgesWritten : summary.edgesPlanned}`)
  console.log(`Unresolved (left for judge):  ${summary.unresolved}`)
  console.log(`Ambiguous (>1 project):       ${summary.ambiguous}`)
  if (!APPLY && summary.edgesPlanned > 0) {
    console.log('\nRe-run with --apply to write these edges.')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
