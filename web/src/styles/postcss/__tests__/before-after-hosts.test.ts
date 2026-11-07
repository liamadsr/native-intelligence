/**
 * Universal ::before / ::after selectors become one :where() selector per
 * element a rule gives that pseudo-element: same rule, same declarations, same
 * specificity, and nothing else touched.
 */
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import postcss, { type PluginCreator, type Root } from 'postcss'

// The plugin is CommonJS, as postcss.config.js loads it.
const beforeAfterHosts = createRequire(import.meta.url)('../before-after-hosts.js') as PluginCreator<void>

const RUNTIME = ['q', '[data-sonner-toast]', '.ProseMirror-gapcursor', '.metal-fx-root', '[data-beam]', '[data-voice-beam]']
const where = (pseudo: string, hosts: string[]) => [...RUNTIME, ...hosts].map((h) => `:where(${h})::${pseudo}`)

async function run(css: string) {
  const result = await postcss([beforeAfterHosts()]).process(css, { from: undefined })
  return { css: result.css, root: result.root, warnings: result.warnings().map((w) => w.text) }
}

function selectorsOf(root: Root, decl: string): string[] {
  let found: string[] = []
  root.walkRules((r) => {
    if (r.nodes.some((n) => n.type === 'decl' && n.prop === decl)) found = r.selectors
  })
  return found
}

describe('before-after-hosts', () => {
  it('turns ::before / ::after in the preflight into the elements that have one, in place', async () => {
    const { root, warnings } = await run(
      '@layer base { *, ::after, ::before, ::backdrop { box-sizing: border-box; border: 0 solid } }\n' +
        '@layer utilities { .before\\:absolute::before { content: var(--tw-content); position: absolute } }\n' +
        '.card::after { content: ""; inset: 0 }',
    )
    expect(warnings).toEqual([])
    expect(selectorsOf(root, 'box-sizing')).toEqual(['*', ...where('after', ['.card']), ...where('before', ['.before\\:absolute']), '::backdrop'])
    // Still the same rule in the same layer, before the utilities.
    expect(root.first?.type === 'atrule' && root.first.params).toBe('base')
  })

  it('keeps what comes before the universal compound', async () => {
    const { root } = await run('[data-card-parked] *, [data-card-parked] *::before { animation-play-state: paused !important }\n.a::before { content: "" }')
    expect(selectorsOf(root, 'animation-play-state')).toEqual(['[data-card-parked] *', ...where('before', ['.a']).map((s) => `[data-card-parked] ${s}`)])
  })

  it('reads hosts through nesting, at-rules and the legacy one-colon form', async () => {
    const { root } = await run(
      '*, ::before, :after { border-color: red }\n' +
        '.after\\:block { &::after { content: var(--tw-content); display: block } }\n' +
        '.group-x\\:before\\:w-1 { &:is(:where(.group)[data-x] *) { &::before { width: 1px } } }\n' +
        '@media (width >= 48rem) { .md\\:after\\:hidden:after { display: none } }\n' +
        '.prose :where(blockquote p:first-of-type)::before { content: open-quote }',
    )
    expect(selectorsOf(root, 'border-color')).toEqual([
      '*',
      ...where('before', ['.group-x\\:before\\:w-1:is(:where(.group)[data-x] *)', '.prose :where(blockquote p:first-of-type)']),
      ...where('after', ['.after\\:block', '.md\\:after\\:hidden']),
    ])
  })

  it('reads escaped colons in class names as part of the name', async () => {
    const { root } = await run('*, ::before { margin: 0 }\n.hover\\:before\\:x:hover::before { content: "" }\n.a\\::before { content: "" }')
    expect(selectorsOf(root, 'margin')).toEqual(['*', ...where('before', ['.hover\\:before\\:x:hover', '.a\\:'])])
  })

  it('leaves the CSS alone when a universal rule could give every element content', async () => {
    const css = '*, ::before { box-sizing: border-box }\n::after { content: "" }\n.a::before { content: "" }'
    const { css: out, warnings } = await run(css)
    expect(out).toBe(css)
    expect(warnings[0]).toMatch(/"::after" sets content/)
  })

  it('leaves the CSS alone when a ::before / ::after is not at the end of a selector', async () => {
    const css = '*, ::before { box-sizing: border-box }\n.a::before:hover { content: "" }'
    const { css: out, warnings } = await run(css)
    expect(out).toBe(css)
    expect(warnings[0]).toMatch(/can't read/)
  })

  it('touches nothing without universal ::before / ::after', async () => {
    const css = '*, ::backdrop { box-sizing: border-box }\n.a::before { content: "" }\n::placeholder { opacity: 1 }'
    expect((await run(css)).css).toBe(css)
  })
})
