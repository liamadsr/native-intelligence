/**
 * The Studio product runner's pure half (../kit.ts): what a product folder is (detection on made-up folders), how its
 * components are found, which code a capture was built from (the code key), and the commit read from git's files.
 * Made-up products only.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  aliasesFromTsconfig,
  buildCatalog,
  checkRelativePath,
  chunkInputs,
  commitFromGit,
  componentId,
  componentKey,
  detectFramework,
  detectProduct,
  discoverExports,
  discoverFolders,
  isComponentFile,
  isPackagePath,
  slugOf,
  tailwindVersionOf,
  type FolderFacts,
} from '../kit'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const installed = { react: true, reactDom: true, esbuild: true, tailwindCli: true }

/** A made-up Vite product with Tailwind 4 and an `@` alias. */
const vite: FolderFacts = {
  packageJson: { name: '@fernhill/planner', dependencies: { react: '19', 'react-dom': '19' }, devDependencies: { vite: '7', tailwindcss: '4' } },
  tsconfigText: '{\n  // comments are fine\n  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] }, },\n}',
  entries: ['src', 'src/components', 'public'],
  stylesheets: { 'src/app.css': 'body { margin: 0 }', 'src/index.css': '@import "tailwindcss";' },
  installed,
}

describe('detectProduct', () => {
  it('reads a Vite product with Tailwind 4: its slug, alias, stylesheet and folders', () => {
    const r = detectProduct(vite)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.kit).toMatchObject({ slug: 'planner', title: '@fernhill/planner', framework: 'vite', alias: { '@': 'src' }, css: 'src/index.css', tailwind: 4, discover: ['src/components'], public: 'public', components: {} })
    expect(r.notes).toEqual([])
  })

  it('reads a Next product with Tailwind 3 and says what is stood in for', () => {
    const r = detectProduct({ ...vite, packageJson: { name: 'acme-site', dependencies: { next: '15', react: '19', 'react-dom': '19' } }, entries: ['app', 'components'], stylesheets: { 'app/globals.css': '@tailwind base;\n@tailwind utilities;' } })
    expect(r.ok && r.kit).toMatchObject({ framework: 'next', tailwind: 3, css: 'app/globals.css', discover: ['components'] })
    expect(r.ok && r.notes.join(' ')).toMatch(/Next\.js links, images and navigation/)
  })

  it('refuses in one sentence what is not a product yet', () => {
    expect(detectProduct({ ...vite, packageJson: null })).toEqual({ ok: false, reason: expect.stringMatching(/no package\.json/) })
    expect(detectProduct({ ...vite, packageJson: { name: 'cli', dependencies: { chalk: '5' } } })).toEqual({ ok: false, reason: expect.stringMatching(/does not use React/) })
    expect(detectProduct({ ...vite, installed: { ...installed, react: false } })).toEqual({ ok: false, reason: expect.stringMatching(/npm install/) })
    expect(detectProduct({ ...vite, installed: { ...installed, esbuild: false } })).toEqual({ ok: false, reason: expect.stringMatching(/esbuild/) })
  })

  it('notes a missing Tailwind command line and a missing stylesheet instead of failing', () => {
    const noCli = detectProduct({ ...vite, installed: { ...installed, tailwindCli: false } })
    expect(noCli.ok && noCli.notes.join(' ')).toMatch(/@tailwindcss\/cli/)
    const noCss = detectProduct({ ...vite, stylesheets: {} })
    expect(noCss.ok && noCss.kit.css).toBeNull()
    expect(noCss.ok && noCss.notes.join(' ')).toMatch(/No stylesheet/)
  })
})

describe('the small rules', () => {
  it('names products as the engine requires', () => {
    expect(slugOf('@fernhill/Planner App')).toBe('planner-app')
    expect(slugOf('___')).toBe('product')
    expect(slugOf('x'.repeat(80))).toHaveLength(41)
  })

  it('keeps every path a record names inside the folder', () => {
    expect(checkRelativePath('./src/index.css')).toBe('src/index.css')
    for (const bad of ['/etc/passwd', '~/secrets', '../other', 'src/../../x', 'a\\b', '', 7]) expect(checkRelativePath(bad), String(bad)).toBeNull()
  })

  it('reads aliases only when they stay inside the folder', () => {
    expect(aliasesFromTsconfig('{"compilerOptions":{"paths":{"@/*":["./src/*"],"~/*":["../shared/*"],"x":["y"]}}}')).toEqual({ '@': 'src' })
    expect(aliasesFromTsconfig('{"compilerOptions":{"baseUrl":"src","paths":{"@ui/*":["components/*"]}}}')).toEqual({ '@ui': 'src/components' })
    expect(aliasesFromTsconfig(null)).toEqual({})
  })

  it('tells frameworks and Tailwind majors apart', () => {
    expect(detectFramework({ dependencies: { '@remix-run/react': '2' } })).toBe('remix')
    expect(detectFramework({ dependencies: { react: '19' } })).toBe('react')
    expect(tailwindVersionOf("@import 'tailwindcss';")).toBe(4)
    expect(tailwindVersionOf('@tailwind base;')).toBe(3)
    expect(tailwindVersionOf('body{}')).toBeNull()
    expect(discoverFolders(['src'])).toEqual(['src'])
    expect(discoverFolders([])).toEqual(['.'])
    expect(isComponentFile('Card.tsx') && !isComponentFile('Card.test.tsx') && !isComponentFile('Card.stories.tsx') && !isComponentFile('card.ts')).toBe(true)
    expect(isPackagePath('node_modules/react/index.js') && isPackagePath('kit-stub:x') && !isPackagePath('src/a.tsx')).toBe(true)
  })
})

describe('discovery', () => {
  const text = [
    'export function PricingCard() {}',
    'export default function SignupForm() {}',
    'export const Avatar = memo((p) => null)',
    'export const Tabs: React.FC = forwardRef((p, r) => null)',
    'export function ThemeProvider() {}',
    'export function helper() {}',
    'export const PricingCard2 = (p) => null',
  ].join('\n')

  it('finds exported components and leaves out what renders nothing by design', () => {
    const found = discoverExports(text, 'src/components/Pricing.tsx')
    expect(found.map((e) => e.name)).toEqual(['PricingCard', 'SignupForm', 'Avatar', 'Tabs', 'PricingCard2'])
    expect(found[0]).toEqual({ id: 'src-components-Pricing--PricingCard', name: 'PricingCard', group: 'src/components', help: '', curated: false, file: 'src/components/Pricing.tsx', width: 720, height: 420 })
    expect(discoverExports("'use server'\nexport function Action() {}", 'a.tsx')).toEqual([])
    expect(discoverExports(text, 'x.tsx', '^Pricing').map((e) => e.name)).toEqual(['SignupForm', 'Avatar', 'Tabs', 'ThemeProvider'])
    expect(componentId('app/(site)/hero.tsx', 'Hero')).toBe('app-site-hero--Hero')
  })

  it('lists curated components first, then each discovered export once', () => {
    const kit = { components: { hero: { fixture: 'src/fixtures/hero.tsx', export: 'HeroFixture', width: 1440, height: 900, help: 'The site hero', props: { title: 'Plan less' } } } }
    const catalog = buildCatalog(kit, [{ rel: 'src/components/b.tsx', text: 'export function Beta() {}' }, { rel: 'src/components/a.tsx', text: 'export function Alpha() {}\nexport function Alpha2() {}\nexport function Alpha() {}' }])
    expect(catalog.map((e) => e.id)).toEqual(['hero', 'src-components-a--Alpha', 'src-components-a--Alpha2', 'src-components-b--Beta'])
    expect(catalog[0]).toMatchObject({ curated: true, group: 'Featured', file: 'src/fixtures/hero.tsx', props: { title: 'Plan less' } })
  })
})

describe('the code key', () => {
  const metafile = {
    outputs: {
      'out/stage.js': { imports: [{ path: 'out/Card-1.js', kind: 'dynamic-import' }, { path: 'out/Form-2.js', kind: 'dynamic-import' }], inputs: { 'stage.tsx': {} } },
      'out/Card-1.js': { entryPoint: 'src/components/Card.tsx', imports: [{ path: 'out/chunk-shared.js', kind: 'import-statement' }], inputs: { 'src/components/Card.tsx': {} } },
      'out/Form-2.js': { entryPoint: 'src/components/Form.tsx', imports: [{ path: 'out/chunk-shared.js', kind: 'import-statement' }, { path: 'out/Card-1.js', kind: 'dynamic-import' }], inputs: { 'src/components/Form.tsx': {} } },
      'out/chunk-shared.js': { inputs: { 'src/lib/format.ts': {}, 'node_modules/react/index.js': {} } },
    },
  }

  it('follows shared code, never the components a chunk loads on demand', () => {
    expect(chunkInputs(metafile, 'out/Card-1.js')).toEqual(['node_modules/react/index.js', 'src/components/Card.tsx', 'src/lib/format.ts'])
    expect(chunkInputs(metafile, 'out/Form-2.js')).not.toContain('src/components/Card.tsx')
    expect(chunkInputs(metafile, 'out/missing.js')).toEqual([])
  })

  it('is the same for the same code in any order, and changes when a file, the settings or the styles change', () => {
    const base = { inputs: [{ path: 'src/a.tsx', sha256: sha('a') }, { path: 'src/b.ts', sha256: sha('b') }], settings: { alias: { '@': 'src' } }, css: sha('css') }
    const key = componentKey(base, sha)
    expect(key).toMatch(/^[a-f0-9]{32}$/)
    expect(componentKey({ ...base, inputs: [...base.inputs].reverse() }, sha)).toBe(key)
    expect(componentKey({ ...base, inputs: [{ path: 'src/a.tsx', sha256: sha('a2') }, base.inputs[1]!] }, sha)).not.toBe(key)
    expect(componentKey({ ...base, settings: { alias: {} } }, sha)).not.toBe(key)
    expect(componentKey({ ...base, css: null }, sha)).not.toBe(key)
  })
})

describe('commitFromGit', () => {
  const A = 'a'.repeat(40)
  it('reads a detached HEAD, a branch ref, and packed refs', () => {
    expect(commitFromGit({ head: `${A}\n`, ref: () => null, packedRefs: null })).toBe(A)
    expect(commitFromGit({ head: 'ref: refs/heads/main\n', ref: (n) => (n === 'refs/heads/main' ? `${A}\n` : null), packedRefs: null })).toBe(A)
    expect(commitFromGit({ head: 'ref: refs/heads/main', ref: () => null, packedRefs: `# pack-refs\n${'b'.repeat(40)} refs/heads/other\n${A} refs/heads/main\n` })).toBe(A)
  })
  it('answers null for no checkout or a ref it will not follow', () => {
    expect(commitFromGit({ head: null, ref: () => A, packedRefs: null })).toBeNull()
    expect(commitFromGit({ head: 'ref: refs/heads/../../x', ref: () => A, packedRefs: null })).toBeNull()
  })
})
