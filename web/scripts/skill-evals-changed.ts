/**
 * Which chat skill evals a change should run (docs/plans/always-on-agent.md §8).
 *
 *   npx tsx scripts/skill-evals-changed.ts [--base origin/main] [--run]
 *
 * Reads `git diff --name-only <base>...HEAD` and the changed lines of the
 * migrations and cases/flywheel.json, maps them to skills
 * (src/lib/packs/skill-evals/changed.ts) and prints the CHAT_SKILL_EVAL_ONLY
 * list. `instructions` in it is the core subset: the first cases of every
 * skill plus the flywheel's instruction cases.
 *
 * --run then runs the live evals for exactly those (DEV only, one paid chat
 * turn per case; needs `npm run dev` and .env.development.local):
 *   CHAT_SKILL_EVAL=1 CHAT_SKILL_EVAL_ONLY=… npx vitest run -c scripts/chat-skill-evals.vitest.config.ts
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { INSTRUCTIONS_CORE_CASES_PER_SKILL, selectSkillEvalSuites, skillEvalSuites } from '../src/lib/packs/skill-evals'
import { changedLinesFromDiff, onlyList, skillEvalsForChange } from '../src/lib/packs/skill-evals/changed'

const ROOT = resolve(__dirname, '..')

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function main(): void {
  const args = process.argv.slice(2)
  const baseIdx = args.indexOf('--base')
  const base = baseIdx !== -1 && args[baseIdx + 1] ? args[baseIdx + 1] : 'origin/main'
  const run = args.includes('--run')

  const range = `${base}...HEAD`
  const files = git(['diff', '--name-only', range]).split('\n').map((f) => f.trim()).filter(Boolean)
  const diff = git(['diff', '-U0', range, '--', 'supabase/migrations', 'src/lib/packs/skill-evals/cases/flywheel.json'])
  const changed = skillEvalsForChange(files, changedLinesFromDiff(diff), skillEvalSuites().map((s) => s.slug))
  const only = onlyList(changed)

  console.log(`${files.length} files changed since ${base}.`)
  if (!only) {
    console.log('No skill evals to run: nothing changed a skill, its cases or the instructions.')
    return
  }
  for (const r of changed.reasons) console.log(`  ${r.selects.padEnd(24)} ← ${r.file}`)
  const suites = selectSkillEvalSuites(only.split(','))
  const total = suites.reduce((n, s) => n + s.cases.length, 0)
  const flywheel = suites.reduce((n, s) => n + s.flywheel, 0)
  console.log(
    `\n${total} cases (${flywheel} from the flywheel)` +
      (changed.instructions ? `; instructions = the core subset (the first ${INSTRUCTIONS_CORE_CASES_PER_SKILL} cases of every skill, plus the flywheel's instruction cases)` : '') +
      '.',
  )
  console.log(`\nCHAT_SKILL_EVAL_ONLY=${only}`)

  if (!run) return
  const result = spawnSync('npx', ['vitest', 'run', '-c', 'scripts/chat-skill-evals.vitest.config.ts'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, CHAT_SKILL_EVAL: '1', CHAT_SKILL_EVAL_ONLY: only },
  })
  process.exit(result.status ?? 1)
}

main()
