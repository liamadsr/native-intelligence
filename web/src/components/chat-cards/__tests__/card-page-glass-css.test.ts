/**
 * A page full screen beside the rail draws its glass as a tint with no blur
 * (tailwind.css; Liam, 11-22: a line showed across the page as he hovered,
 * where Chromium redrew the blurred backdrop for part of it only). Inline
 * cards in the chat keep their frosted glass.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve(__dirname, '../../../styles/tailwind.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

function ruleBody(selector: string): string | null {
  for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    if (m[1].trim() === selector) return m[2]
  }
  return null
}

describe('the full-screen page’s glass', () => {
  it('has no backdrop blur beside the rail, in WebKit and Chromium alike', () => {
    const body = ruleBody('html[data-app-rail] .card-page-layer [data-card-glass]')
    expect(body).not.toBeNull()
    expect(body).toMatch(/(^|[;\s])backdrop-filter:\s*none/)
    expect(body).toMatch(/-webkit-backdrop-filter:\s*none/)
  })
})
