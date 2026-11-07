/**
 * The call glow's stylesheet (styles/tailwind.css). Node env, since it reads
 * the file (a jsdom file gets node:fs stubbed under NODE_ENV=production).
 * Pinned: the old static .hud-call-glow is gone (the glow is the main chat's
 * audio-reactive beam now: ./call-glow.test.tsx), and the reduced-motion tint
 * that replaces the beam never animates.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('the call glow in the stylesheet', () => {
  const css = readFileSync(resolve(__dirname, '../../../styles/tailwind.css'), 'utf8')

  it('no longer has the static .hud-call-glow', () => {
    expect(css).not.toContain('hud-call-glow')
  })

  it("has the reduced-motion tint, which never animates", () => {
    const rules = css.match(/\.hud-audio-glow-still[^{]*\{[^}]*\}/g) ?? []
    expect(rules.length).toBeGreaterThan(0)
    for (const rule of rules) {
      expect(rule).not.toMatch(/animation|transition|will-change|filter|blur/)
    }
  })
})
