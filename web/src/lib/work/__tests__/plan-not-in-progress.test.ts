/**
 * A job's plan lives in its own column (`tracked_job.plan`, migration 331),
 * never inside `progress` (A4, src/lib/work/plan.ts header). The recorder, the
 * agent-run mirror, the reaper and resolve each rewrite `progress` whole from
 * what they hold, so a plan written into it would be lost to the next such
 * write. This pins the split from both sides:
 *   - none of those writers names the plan at all (they leave the column be,
 *     so their whole-object `progress` writes can't drop it);
 *   - nothing in the ledger code puts a `plan` key into a `progress` object;
 *   - the one writer (setWorkPlan) writes the `plan` column and never names
 *     `progress`.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const WORK = join(process.cwd(), 'src/lib/work')
const read = (file: string) => readFileSync(join(WORK, file), 'utf8')
/** Code only: line and block comments out (a header may mention the plan). */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const WHOLE_PROGRESS_WRITERS = ['recorder.ts', 'agent-run-mirror.ts', 'reaper.ts', 'resolve.ts']

describe('the plan is never written into progress', () => {
  it.each(WHOLE_PROGRESS_WRITERS)('%s never names the plan', (file) => {
    expect(code(read(file))).not.toMatch(/\bplan\b/i)
  })

  it('no ledger file puts a plan key into a progress object', () => {
    const files = readdirSync(WORK).filter((f) => f.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(10)
    for (const file of files) {
      const src = code(read(file))
      // `progress: { …plan… }` or `progress.plan` / `progress['plan']` / `progress?.plan`.
      expect(src, file).not.toMatch(/progress\s*:\s*\{[^}]*\bplan\b/)
      expect(src, file).not.toMatch(/progress\??\.plan\b|progress\??\.?\[\s*['"]plan['"]\s*\]/)
    }
  })

  it('setWorkPlan writes the plan column and never names progress', () => {
    const src = code(read('plan.ts'))
    expect(src).toContain('.update({ plan })')
    expect(src).not.toMatch(/\bprogress\b/)
  })

  it('the event route and the skill-run route write the plan only through setWorkPlan', () => {
    for (const route of ['src/app/api/internal/agent-run/event/route.ts', 'src/app/api/internal/skill-run/tool/route.ts']) {
      const src = code(readFileSync(join(process.cwd(), route), 'utf8'))
      expect(src, route).toContain('setWorkPlan(')
      expect(src, route).not.toMatch(/update\(\s*\{\s*plan\b/)
      expect(src, route).not.toMatch(/progress\s*:\s*\{[^}]*\bplan\b/)
    }
  })
})
