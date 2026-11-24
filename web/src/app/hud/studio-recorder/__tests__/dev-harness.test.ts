/**
 * The control's development harness (?simulate=1) is never in a production build: the page reaches it only through a
 * dynamic import inside a `process.env.NODE_ENV !== 'production'` branch, which Next's build replaces with `false`
 * and drops together with the chunk; and the harness refuses to play in production besides.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEMO, devHarnessAllowed, playTake, TAKE } from '../dev-harness'
import { indexScript, follow, START, currentLine } from '@/lib/studio/prompter/follow'
import { hear, NOTHING_HEARD } from '@/lib/studio/prompter/live-words'

const page = readFileSync(path.join(__dirname, '..', 'page.tsx'), 'utf8')

describe('the dev harness', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers() })

  it('is imported only inside the production-removed branch, and nowhere else', () => {
    // Exactly one reference: the dynamic import.
    expect(page.match(/dev-harness/g)?.length).toBe(2) // the import, and the comment at the top naming it
    expect(page).not.toMatch(/^import .*dev-harness/m)
    const at = page.indexOf("import('./dev-harness')")
    expect(at).toBeGreaterThan(0)
    const branch = page.lastIndexOf("if (process.env.NODE_ENV !== 'production' && simulate) {", at)
    expect(branch).toBeGreaterThan(0)
    // The import is inside that branch: no closing of the branch's block between them.
    const between = page.slice(branch, at)
    const opens = (between.match(/\{/g) ?? []).length, closes = (between.match(/\}/g) ?? []).length
    expect(opens).toBeGreaterThan(closes)
  })

  it('refuses to play in production', () => {
    expect(devHarnessAllowed('production')).toBe(false)
    expect(devHarnessAllowed('development')).toBe(true)
    vi.stubEnv('NODE_ENV', 'production')
    vi.useFakeTimers()
    const heard = vi.fn()
    playTake(heard, () => {})
    vi.advanceTimersByTime(120_000)
    expect(heard).not.toHaveBeenCalled()
  })

  it('plays a take the follower reads to the last line, past its ad-lib, slip and skipped line', () => {
    vi.useFakeTimers()
    const index = indexScript(DEMO.lines)
    let h = NOTHING_HEARD, place = START
    const stop = playTake((event) => { h = hear(h, event); place = follow(index, place, h.finals, h.interim) }, () => {}, 0)
    vi.advanceTimersByTime(TAKE.length * 5000)
    stop()
    expect(currentLine(index, place.confirmed)).toBe(DEMO.lines.length - 1)
  })
})
