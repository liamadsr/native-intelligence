// @vitest-environment jsdom
/**
 * The typography plugin's not-prose check, as a class selector: same elements,
 * same (zero) specificity, and nothing else touched.
 */
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import postcss, { type PluginCreator } from 'postcss'

// The plugin is CommonJS, as postcss.config.js loads it.
const notProseClass = createRequire(import.meta.url)('../not-prose-class.js') as PluginCreator<void>

async function run(css: string): Promise<string> {
  return (await postcss([notProseClass()]).process(css, { from: undefined })).css
}

describe('not-prose-class', () => {
  it('writes the attribute check as a class selector, quoted or not', async () => {
    const out = await run(
      '.prose :where(p):not(:where([class~="not-prose"],[class~="not-prose"] *)) { margin: 1em 0 }\n' +
        ".prose :where(code):not(:where([class~='not-prose'], [class~='not-prose'] *))::before { content: '`' }\n" +
        '.prose-headings\\:font-semibold :is(:where(h1, h2):not(:where([class~=not-prose],[class~=not-prose] *))) { font-weight: 600 }',
    )
    expect(out).not.toMatch(/class~=/)
    expect(out).toContain('.prose :where(p):not(:where(.not-prose,.not-prose *)) { margin: 1em 0 }')
    expect(out).toContain(".prose :where(code):not(:where(.not-prose, .not-prose *))::before { content: '`' }")
    expect(out).toContain(':is(:where(h1, h2):not(:where(.not-prose,.not-prose *)))')
  })

  it('leaves every other attribute selector and declaration alone', async () => {
    const css = '.prose :where([class~="lead"]) { color: red }\n[class~="not-prose-ish"] { color: blue }\n.x { content: "[class~=\\"not-prose\\"]" }'
    expect(await run(css)).toBe(css)
  })

  it('matches the same elements as the attribute form', () => {
    document.body.innerHTML = '<div class="prose"><p id="a"></p><div class="x not-prose y"><p id="b"></p></div></div>'
    const viaAttr = [...document.querySelectorAll('.prose p:not(:where([class~="not-prose"],[class~="not-prose"] *))')].map((e) => e.id)
    const viaClass = [...document.querySelectorAll('.prose p:not(:where(.not-prose,.not-prose *))')].map((e) => e.id)
    expect(viaClass).toEqual(viaAttr)
    expect(viaClass).toEqual(['a'])
  })
})
