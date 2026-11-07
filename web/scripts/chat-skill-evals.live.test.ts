/**
 * Live chat skill evals (docs/plans/always-on-agent.md §1b item 5). Opt-in and
 * DEV only: run with scripts/chat-skill-evals.vitest.config.ts and
 * CHAT_SKILL_EVAL=1 (see docs/evaluations/chat-skills/README.md).
 *
 * Each case's request goes through scripts/eve-chat-driver.ts in a FRESH
 * conversation (one driver process per case, so one chat turn each), and the
 * run is judged deterministically by judgeSkillEvalRun: loads, tool order,
 * params, avoided tools, tool errors. No judge model and no model call in
 * this process. A skill's flywheel cases (cases/flywheel.json) run with it.
 *
 *   CHAT_SKILL_EVAL_ONLY=my-todo-list,overdue-work   only these skills' cases
 *   CHAT_SKILL_EVAL_ONLY=instructions                the core subset: the first
 *                                                    cases of every skill, plus
 *                                                    the flywheel's instruction cases
 *   (scripts/skill-evals-changed.ts picks the list from a branch's changes)
 *   REPRO_BASE_URL=http://localhost:3001             the dev server (default :3000)
 *
 * Writes docs/evaluations/chat-skills/<date>/report[.<only>].{json,md}.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  judgeSkillEvalRun,
  selectSkillEvalSuites,
  unknownSkillEvalSlugs,
  type ObservedRun,
  type SkillEvalCase,
  type SkillEvalVerdict,
} from '../src/lib/packs/skill-evals'

const ROOT = resolve(__dirname, '..')
const ENABLED = process.env.CHAT_SKILL_EVAL === '1'
const ONLY = (process.env.CHAT_SKILL_EVAL_ONLY ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
/** The driver gives a turn 180 s; this covers sign-in and its 3 s persist grace on top. */
const CASE_TIMEOUT_MS = 240_000

interface DriverTurn {
  prompt: string
  text: string
  toolCalls: Array<{ name: string; input?: unknown; skill?: string; packs?: string[]; output?: string; ok?: boolean; code?: string; error?: string }>
  packs: string[]
  finished: boolean
  error: string | null
  ms: number
}
interface DriverSummary {
  conversationId: string | null
  turns: DriverTurn[]
}

interface CaseResult {
  skill: string
  index: number
  request: string
  expected: Pick<SkillEvalCase, 'loads' | 'tools' | 'params' | 'avoid' | 'noToolErrors'>
  /** From cases/flywheel.json, or the `instructions` core subset. */
  flywheel: boolean
  core: boolean
  verdict: SkillEvalVerdict
  conversationId: string | null
  ms: number
  reply: string
}

/** One case through the driver, in its own process and conversation. */
async function drive(request: string): Promise<DriverSummary> {
  const out = join(tmpdir(), `chat-skill-eval-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
  // The driver is not a test process: it runs as the dev stack does, not under vitest's NODE_ENV.
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'development' }
  try {
    await new Promise<void>((done, fail) => {
      execFile(
        join(ROOT, 'node_modules/.bin/tsx'),
        // --answer: an ask_user picker takes its first option, so the turn ends.
        ['scripts/eve-chat-driver.ts', '--prompt', request, '--answer', '--json', '--out', out],
        { cwd: ROOT, env, timeout: CASE_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
        (err, _stdout, stderr) => (err ? fail(new Error(`driver failed: ${err.message}\n${String(stderr).slice(-2000)}`)) : done()),
      )
    })
    return JSON.parse(await readFile(out, 'utf8')) as DriverSummary
  } finally {
    await rm(out, { force: true })
  }
}

function markdownReport(results: CaseResult[], startedAt: string): string {
  const skills = [...new Set(results.map((r) => r.skill))]
  const passed = results.filter((r) => r.verdict.pass).length
  const lines = [
    `# Chat skill evals: ${startedAt}`,
    '',
    `${passed}/${results.length} cases passed${ONLY.length ? ` (only: ${ONLY.join(', ')})` : ''}.`,
    '',
    '| Skill | Passed | Cases |',
    '| --- | --- | --- |',
    ...skills.map((s) => {
      const rs = results.filter((r) => r.skill === s)
      return `| ${s} | ${rs.filter((r) => r.verdict.pass).length} | ${rs.length} |`
    }),
    '',
  ]
  for (const s of skills) {
    lines.push(`## ${s}`, '')
    for (const r of results.filter((x) => x.skill === s)) {
      lines.push(`- ${r.verdict.pass ? 'PASS' : 'FAIL'}${r.flywheel ? ' (flywheel)' : ''}${r.core ? ' (core)' : ''} — "${r.request}"`)
      lines.push(`  - loads seen: ${r.verdict.loadsSeen.join(', ') || '(none)'}; tools seen: ${r.verdict.toolsSeen.join(', ') || '(none)'}`)
      for (const f of r.verdict.failures) lines.push(`  - ${f}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

describe.skipIf(!ENABLED)('live chat skill evals (DEV)', () => {
  if (process.env.REPRO_ALLOW_PROD === '1') {
    throw new Error('chat skill evals run against DEV only: unset REPRO_ALLOW_PROD')
  }
  const startedAt = new Date().toISOString()
  const suites = selectSkillEvalSuites(ONLY)
  const unknown = unknownSkillEvalSlugs(ONLY)
  const results: CaseResult[] = []

  it('has cases to run', () => {
    expect(unknown, 'CHAT_SKILL_EVAL_ONLY names a skill with no case file').toEqual([])
    expect(suites.length).toBeGreaterThan(0)
  })

  for (const suite of suites) {
    describe(suite.core ? `${suite.slug} (core)` : suite.slug, () => {
      suite.cases.forEach((c, index) => {
        const flywheel = index >= suite.cases.length - suite.flywheel
        it(
          `case ${index + 1}${flywheel ? ' (flywheel)' : ''}: ${c.request.slice(0, 60)}`,
          async () => {
            const started = Date.now()
            let run: ObservedRun
            let conversationId: string | null = null
            let reply = ''
            try {
              const summary = await drive(c.request)
              const turn = summary.turns[0]
              conversationId = summary.conversationId
              reply = turn?.text ?? ''
              run = turn
                ? { toolCalls: turn.toolCalls, finished: turn.finished, error: turn.error }
                : { toolCalls: [], finished: false, error: 'driver returned no turn' }
            } catch (err) {
              run = { toolCalls: [], finished: false, error: err instanceof Error ? err.message : String(err) }
            }
            const verdict = judgeSkillEvalRun(c, run)
            results.push({
              skill: suite.slug,
              index,
              request: c.request,
              expected: { loads: c.loads, tools: c.tools, params: c.params, avoid: c.avoid, noToolErrors: c.noToolErrors },
              flywheel,
              core: suite.core === true,
              verdict,
              conversationId,
              ms: Date.now() - started,
              reply: reply.slice(0, 1000),
            })
            expect(verdict.failures).toEqual([])
          },
          CASE_TIMEOUT_MS + 30_000,
        )
      })
    })
  }

  afterAll(async () => {
    if (results.length === 0) return
    const dir = join(ROOT, 'docs/evaluations/chat-skills', startedAt.slice(0, 10))
    const base = ONLY.length ? `report.${ONLY.join('+')}` : 'report'
    const bySkill = Object.fromEntries(
      [...new Set(results.map((r) => r.skill))].map((s) => {
        const rs = results.filter((r) => r.skill === s)
        return [s, { passed: rs.filter((r) => r.verdict.pass).length, total: rs.length }]
      }),
    )
    const report = {
      startedAt,
      baseUrl: process.env.REPRO_BASE_URL || 'http://localhost:3000',
      only: ONLY,
      passed: results.filter((r) => r.verdict.pass).length,
      total: results.length,
      bySkill,
      cases: results,
    }
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${base}.json`), `${JSON.stringify(report, null, 2)}\n`)
    await writeFile(join(dir, `${base}.md`), `${markdownReport(results, startedAt)}\n`)
  })
})
