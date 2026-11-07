/**
 * Prune orphaned eve/workflow runs from the LOCAL per-agent durable stores so
 * `eve dev` stops the boot-time "Unhandled queue" retry storm.
 *
 * ── The bug this works around ────────────────────────────────────────────────
 * Each eve dev child (agents/<name>, run via `eve.js dev --no-ui`) keeps durable
 * workflow state in the local-world data directory (gitignored). On every boot the
 * @workflow/core local world re-enqueues EVERY run whose status is `pending` or
 * `running` (its startup recovery scan, function `Lm`). It builds the queue name
 * with the DEFAULT prefix `__wkf_workflow_<workflowName>` and never consults the
 * per-agent queue namespace that eve installs
 * (deriveEveWorkflowQueuePrefix → `__eve<hex(agentName)>_wkf_workflow_`, set as
 * WORKFLOW_QUEUE_NAMESPACE). The world-local queue handler only accepts messages
 * whose name `startsWith` its registered namespaced prefix, so every re-enqueued
 * orphan is rejected with HTTP 400 `{"error":"Unhandled queue"}` and retried 256×
 * at 5s intervals. With dozens of dead runs left over from earlier sessions
 * (interrupted `ask_user` HITL turns, dev restarts killing in-flight runs), the
 * aggregate is dozens of error lines per second that bury real compile/HMR output.
 *
 * ── Store path (eve 0.24.4+) ─────────────────────────────────────────────────
 * The local-world data directory moved from agents/<name>/.workflow-data/ (≤0.23)
 * to agents/<name>/.eve/.workflow-data/ (LOCAL_WORKFLOW_WORLD_DATA_DIRECTORY_
 * RELATIVE_PATH = ".eve/.workflow-data" in
 * eve/dist/src/internal/workflow/local-world-data-directory). This script scans the
 * NEW path and ALSO sweeps the OLD path when it still exists (stale ≤0.23 / 0.22.4
 * leftovers), guarded by existence. The run-store JSON shape and dir layout are
 * unchanged in 0.27.0: runs/<id>.json with status/updatedAt/startedAt/createdAt/
 * runId/workflowName, plus steps/ events/ streams/ hooks/ subdirs (verified against
 * the 0.27.0 world-local store code). Both paths are covered by .gitignore
 * (the `/agents/<name>/.eve/` and `/agents/<name>/.workflow-data/` ignore rules).
 *
 * ── Upstream note (0.23–0.26) ────────────────────────────────────────────────
 * The 0.23–0.26 releases hardened dev-queue resume semantics: structural reloads
 * no longer interrupt admitted work, and runs resume on the AGENT-SCOPED queue
 * rather than the default prefix — so the queue-prefix "Unhandled queue" storm this
 * script exists to clean up may be fixed upstream. The script is RETAINED as a
 * safety net (and to garbage-collect pre-upgrade orphans) pending live confirmation
 * that a fresh 0.27.0 dev boot no longer produces the storm.
 *
 * A run only gets re-enqueued while its status is `pending`/`running`. Flipping it
 * to a terminal status makes the scanner skip it. The world-local store's own
 * abort path writes `status: 'cancelled'` with completedAt/updatedAt, and
 * store.list({status}) filters by reading each runs/<id>.json `status` field
 * directly — so a status flip is sufficient and is the store's canonical shape for
 * an aborted run. We keep the record (and its steps/events/hooks/streams) so the
 * dev UI history stays intact; pass --delete to remove the files instead.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   node node_modules/.bin/tsx scripts/eve-prune-stuck-runs.ts            # dry run
 *   node node_modules/.bin/tsx scripts/eve-prune-stuck-runs.ts --apply    # flip stuck runs → cancelled
 *   node node_modules/.bin/tsx scripts/eve-prune-stuck-runs.ts --apply --delete   # delete stuck run files
 *   node node_modules/.bin/tsx scripts/eve-prune-stuck-runs.ts --apply --agent chat-agent
 *
 * Flags:
 *   --apply           actually write (default is a dry run that only reports)
 *   --delete          delete the run + its steps/events/hooks/streams files
 *                     instead of flipping status to `cancelled`
 *   --agent <name>    restrict to one agent dir (repeatable); default = all
 *   --include-pending also prune `pending` runs (default: `running` only)
 *   --min-age-min <n> only prune runs older than n minutes (default: 15) so a
 *                     genuinely in-flight run is never cancelled mid-turn
 *
 * DEV-ONLY tooling. Stop `eve dev`/`next dev` before running so the children are
 * not mid-write. Only touches the gitignored local-world data dirs
 * (agents/<name>/.eve/.workflow-data/ and the legacy agents/<name>/.workflow-data/).
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { join, basename } from 'node:path'

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const DELETE = argv.includes('--delete')
const INCLUDE_PENDING = argv.includes('--include-pending')
const AGENT_FILTER = argv
  .map((a, i) => (a === '--agent' ? argv[i + 1] : null))
  .filter((v): v is string => Boolean(v))
const minAgeIdx = argv.indexOf('--min-age-min')
const MIN_AGE_MIN = minAgeIdx !== -1 ? Number(argv[minAgeIdx + 1]) : 15
const MIN_AGE_MS = (Number.isFinite(MIN_AGE_MIN) ? MIN_AGE_MIN : 15) * 60_000

const STUCK_STATUSES = INCLUDE_PENDING ? ['running', 'pending'] : ['running']
const AGENTS_DIR = join(process.cwd(), 'agents')

// Local-world data dir, relative to an agent root. eve 0.24.4+ nests it under
// .eve/; the bare .workflow-data/ is the legacy (≤0.23 / 0.22.4) location we still
// sweep so pre-upgrade orphans get cleaned. Both are gitignored.
const STORE_REL_PATHS = ['.eve/.workflow-data', '.workflow-data'] as const

// ── helpers ──────────────────────────────────────────────────────────────────
function listAgentStores(): { agent: string; dir: string; legacy: boolean }[] {
  if (!existsSync(AGENTS_DIR)) return []
  const out: { agent: string; dir: string; legacy: boolean }[] = []
  for (const d of readdirSync(AGENTS_DIR, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    if (AGENT_FILTER.length > 0 && !AGENT_FILTER.includes(d.name)) continue
    for (const rel of STORE_REL_PATHS) {
      const dir = join(AGENTS_DIR, d.name, ...rel.split('/'))
      // Only a store that actually holds a runs/ dir is a real store to scan; this
      // existence guard is what makes the legacy sweep a no-op once the old dir is
      // gone (or was never created under 0.27.0).
      if (existsSync(join(dir, 'runs'))) {
        out.push({ agent: d.name, dir, legacy: rel === '.workflow-data' })
      }
    }
  }
  return out
}

/** Files whose name starts with `wrun_<id>` (steps/events/hooks/streams are keyed by run id). */
function filesForRun(dir: string, runId: string): string[] {
  const out: string[] = []
  for (const sub of ['steps', 'events', 'streams', 'streams/runs']) {
    const d = join(dir, sub)
    if (!existsSync(d)) continue
    for (const f of readdirSync(d)) {
      if (f.startsWith(`${runId}-`) || f === `${runId}.json`) out.push(join(d, f))
    }
  }
  return out
}

// ── main ─────────────────────────────────────────────────────────────────────
let totalStuck = 0
const nowIso = new Date().toISOString()

for (const { agent, dir, legacy } of listAgentStores()) {
  const runsDir = join(dir, 'runs')
  const runFiles = readdirSync(runsDir).filter((f) => f.endsWith('.json'))
  const stuck: { file: string; runId: string; status: string; workflowName: string; createdAt?: string }[] = []
  const now = Date.now()
  let skippedRecent = 0

  for (const f of runFiles) {
    let run: Record<string, unknown>
    try {
      run = JSON.parse(readFileSync(join(runsDir, f), 'utf8'))
    } catch {
      continue
    }
    const status = String(run.status ?? '')
    if (!STUCK_STATUSES.includes(status)) continue

    // Never touch a run that could still be in flight. Use the freshest of the
    // run's own timestamps; fall back to the file mtime.
    const stamp = String(run.updatedAt ?? run.startedAt ?? run.createdAt ?? '')
    const ageMs = stamp ? now - Date.parse(stamp) : now - statSync(join(runsDir, f)).mtimeMs
    if (Number.isFinite(ageMs) && ageMs < MIN_AGE_MS) {
      skippedRecent++
      continue
    }

    stuck.push({
      file: join(runsDir, f),
      runId: String(run.runId ?? basename(f, '.json')),
      status,
      workflowName: String(run.workflowName ?? '?'),
      createdAt: run.createdAt ? String(run.createdAt) : undefined,
    })
  }

  totalStuck += stuck.length
  const verb = DELETE ? 'delete' : 'cancel'
  const recentNote = skippedRecent
    ? ` (kept ${skippedRecent} < ${MIN_AGE_MIN}min old — possibly in flight)`
    : ''
  const storeLabel = legacy ? `${agent} (legacy .workflow-data)` : agent
  console.log(
    `\n[${storeLabel}] ${stuck.length} stuck run(s) [${STUCK_STATUSES.join('|')}] of ${runFiles.length} total${recentNote}` +
      (stuck.length ? ` — will ${APPLY ? verb : `${verb} (dry-run)`}` : ''),
  )

  for (const s of stuck) {
    const when = s.createdAt ? ` @ ${s.createdAt}` : ''
    console.log(`  - ${s.runId} [${s.status}] ${s.workflowName}${when}`)
    if (!APPLY) continue

    if (DELETE) {
      const extra = filesForRun(dir, s.runId)
      for (const p of [s.file, ...extra]) rmSync(p, { force: true })
      console.log(`      deleted run + ${extra.length} associated file(s)`)
    } else {
      const run = JSON.parse(readFileSync(s.file, 'utf8'))
      run.status = 'cancelled'
      run.completedAt = run.completedAt ?? nowIso
      run.updatedAt = nowIso
      writeFileSync(s.file, JSON.stringify(run), 'utf8')
      console.log(`      status → cancelled`)
    }
  }
}

console.log(
  `\n${APPLY ? 'Pruned' : 'Would prune'} ${totalStuck} stuck run(s)` +
    (APPLY ? '' : ' — re-run with --apply to write.'),
)
if (APPLY && totalStuck > 0) {
  console.log('Restart `next dev` so the eve dev children re-scan the cleaned stores.')
}
