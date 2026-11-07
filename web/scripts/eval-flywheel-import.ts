/**
 * Import promoted flywheel cases into the repository (docs/plans/always-on-agent.md §8).
 *
 *   npx tsx scripts/eval-flywheel-import.ts <export.json>
 *
 * <export.json> is the download from /admin/evals (GET /api/admin/evals/export,
 * FlywheelCase[]). Every entry is checked with flywheelCaseSchema; a bad entry
 * stops the import and nothing is written. Cases whose candidateId is already
 * in src/lib/packs/skill-evals/cases/flywheel.json are skipped; the rest are
 * added, and the file is kept sorted by skill, then promotedAt.
 *
 * Having written the file, it runs the static test, which holds every
 * flywheel case to the code (tools exist, params fit their schemas, skills
 * shipped) and runs in every `npm run build`:
 *   npx vitest run src/lib/packs/skill-evals/__tests__/skill-evals-static.test.ts
 * If it fails, flywheel.json goes back to what it was and the script exits
 * non-zero with the test's failures, so a promoted case that would break the
 * build never lands. Fix the case at /admin/evals (reopen, edit, export again).
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mergeFlywheelExport, serializeFlywheelCases } from '../src/lib/evals/flywheel/import'

const ROOT = resolve(__dirname, '..')
const FILE = resolve(ROOT, 'src/lib/packs/skill-evals/cases/flywheel.json')
const STATIC_TEST = 'src/lib/packs/skill-evals/__tests__/skill-evals-static.test.ts'
/** The most lines of a failed test run the script prints. */
const FAILURE_LINES = 60

function readJson(path: string, label: string): unknown {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    throw new Error(`${label}: cannot read ${path} (${err instanceof Error ? err.message : String(err)})`)
  }
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new Error(`${label}: not JSON (${err instanceof Error ? err.message : String(err)})`)
  }
}

/** Run the static test on the written file: null when it passed, else its failure summary (vitest's "Failed Tests" block). */
function runStaticTest(): string | null {
  const run = spawnSync('npx', ['vitest', 'run', STATIC_TEST], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // The skill evals load every tool schema: the heap the build gives them.
    env: { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=8192', NO_COLOR: '1', FORCE_COLOR: '0' },
  })
  if (run.status === 0) return null
  const lines = `${run.stdout ?? ''}\n${run.stderr ?? ''}${run.error ? `\n${run.error.message}` : ''}`.split('\n').filter((l) => l.trim())
  const block = lines.findIndex((l) => l.includes('Failed Tests'))
  return (block === -1 ? lines.slice(-FAILURE_LINES) : lines.slice(block, block + FAILURE_LINES)).join('\n')
}

function main(): void {
  const exportPath = process.argv[2]
  if (!exportPath) {
    console.error('usage: npx tsx scripts/eval-flywheel-import.ts <export.json>')
    process.exit(1)
  }
  const previous = readFileSync(FILE, 'utf8')
  const outcome = mergeFlywheelExport(readJson(FILE, 'flywheel.json'), readJson(resolve(process.cwd(), exportPath), 'export'))
  if (!outcome.ok) {
    console.error('Nothing imported: fix these entries first.')
    for (const e of outcome.errors) console.error(`  - ${e}`)
    process.exit(1)
  }

  for (const c of outcome.added) console.log(`added    ${c.skill}  ${c.candidateId}  (${c.source})  "${c.case.request.slice(0, 70)}"`)
  for (const s of outcome.skipped) console.log(`skipped  ${s.skill}  ${s.candidateId}  (${s.why})`)
  if (outcome.added.length === 0) {
    console.log(`\nNothing added, ${outcome.skipped.length} skipped; flywheel.json holds ${outcome.cases.length}.`)
    return
  }

  writeFileSync(FILE, serializeFlywheelCases(outcome.cases))
  console.log(`\nRunning the static test on the new cases (${STATIC_TEST})…`)
  const failures = runStaticTest()
  if (failures !== null) {
    writeFileSync(FILE, previous)
    console.error('\nThe static test failed, so flywheel.json is back as it was. Nothing imported.')
    console.error(failures)
    process.exit(1)
  }
  console.log(`${outcome.added.length} added, ${outcome.skipped.length} skipped; flywheel.json holds ${outcome.cases.length}. The static test passes.`)
}

try {
  main()
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
