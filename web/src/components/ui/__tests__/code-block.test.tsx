// @vitest-environment jsdom
/**
 * CodeBlockCode fetches shiki on first use (see shell-heavy-deps.test.ts for
 * why). Until the highlighter arrives it shows the plain, escaped code in the
 * same wrapper, then swaps the highlighted markup into that wrapper.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const shiki = vi.hoisted(() => ({
  codeToHtml: vi.fn(async (code: string, opts: { lang: string; theme: string }) =>
    `<pre class="shiki ${opts.theme}" data-lang="${opts.lang}"><code>${code.length} chars</code></pre>`,
  ),
}))
vi.mock('shiki', () => shiki)

import { CodeBlockCode } from '../code-block'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  shiki.codeToHtml.mockClear()
})

describe('CodeBlockCode', () => {
  it('renders escaped plain code first, then the highlighted HTML in the same wrapper', async () => {
    act(() => root.render(h(CodeBlockCode, { code: 'a < b', language: 'python', className: 'extra' })))
    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.className).toContain('extra')
    expect(wrapper.innerHTML).toBe('<pre><code>a &lt; b</code></pre>')

    await act(async () => {
      await vi.dynamicImportSettled()
    })
    const highlighted = container.firstElementChild as HTMLElement
    expect(highlighted.className).toBe(wrapper.className)
    expect(highlighted.innerHTML).toBe(
      '<pre class="shiki github-light" data-lang="python"><code>5 chars</code></pre>',
    )
    expect(shiki.codeToHtml).toHaveBeenCalledWith('a < b', { lang: 'python', theme: 'github-light' })
  })

  it('falls back to plain text when the language is unknown', async () => {
    shiki.codeToHtml.mockRejectedValueOnce(new Error('unknown language'))
    await act(async () => root.render(h(CodeBlockCode, { code: 'x', language: 'nope' })))
    await act(async () => {
      await vi.dynamicImportSettled()
    })
    expect(shiki.codeToHtml).toHaveBeenLastCalledWith('x', { lang: 'text', theme: 'github-light' })
    expect(container.querySelector('pre')?.getAttribute('data-lang')).toBe('text')
  })
})
