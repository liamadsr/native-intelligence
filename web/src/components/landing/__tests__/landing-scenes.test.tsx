/**
 * The landing page's scenes below the hero: what the server sends for each
 * (which is also what a visitor without motion sees) is the finished
 * picture, never a blank waiting for a script.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentTextThread } from '../agent-text-thread'
import { HeroDay } from '../hero-day'
import { ProductShowcase } from '../product-showcase'
import { IN, MOVE, OUT } from '../motion'

describe('the agent’s text thread', () => {
  it('is the whole conversation, with the yes and no typing dots', () => {
    const markup = renderToStaticMarkup(createElement(AgentTextThread))
    expect(markup).toContain('Reply yes or no.')
    expect(markup).toContain('>Yes<')
    expect(markup).toContain('Text Message')
    expect(markup).toContain('Done. The invite is with Lena')
    expect(markup).not.toContain('ni-thread-dot block')
  })
})

describe('the real app’s screens', () => {
  it('has every screen in the markup, sized, with files that exist and words for the one showing, and the rest of the product around it', () => {
    const markup = renderToStaticMarkup(createElement(ProductShowcase))
    const sources = markup
      .split('<img')
      .slice(1)
      .map((tag) => tag.split('src="')[1]?.split('"')[0] ?? '')
    // The four screens in the window, and the three around it (call window, phone, watch).
    expect(sources).toHaveLength(7)
    for (const src of sources) {
      expect(src.startsWith('/screens/')).toBe(true)
      expect(existsSync(join(process.cwd(), 'public', src)), src).toBe(true)
    }
    // The window's four are the recorder's pictures of the app's own screens (scripts/record-demo-screens.ts),
    // and the app itself goes over them in a frame that is not in the server's markup.
    expect(sources.filter((src) => src.startsWith('/screens/demo/'))).toHaveLength(4)
    expect(markup.split('width="2880"').length - 1).toBe(4)
    expect(markup).not.toContain('<iframe')
    expect(markup.split('role="tab"').length - 1).toBe(4)
    expect(markup).toContain('alt="Asked for the open tasks')
  })
})

describe('the page’s motion', () => {
  it('uses the same three curves as the hero', () => {
    const hero = renderToStaticMarkup(createElement(HeroDay))
    for (const curve of [MOVE, IN, OUT]) expect(hero).toContain(`cubic-bezier(${curve.join(', ')})`)
  })
})
