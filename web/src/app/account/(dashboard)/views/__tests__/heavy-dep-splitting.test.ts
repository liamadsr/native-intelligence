import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Guards the two heaviest dependencies OFF the dashboard's first-load path.
 *
 * Measured on a production build of /account, first load:
 *   TipTap + ProseMirror   ~1MB parsed, via six detail panels importing
 *                          note-editor.tsx statically
 *   zod + the `ai` SDK     reached from `@/lib/editions`, which the nav rail,
 *                          tab context and calendar all import
 *
 * Both are needed eventually — the editor when a document is opened, the tool
 * ceiling when an agent runs — but neither is needed to paint the landing view.
 * These assertions are source-level because the property is about MODULE GRAPH
 * SHAPE, which rendering a component tree cannot observe.
 */

const VIEWS = 'src/app/account/(dashboard)/views'
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
/** Strip comments so prose naming a package never counts as an import. */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('note editor is loaded on demand', () => {
  // Every panel that renders the editor. Each one is reachable from
  // tab-content, so a static import here lands TipTap on first load.
  const PANELS = [
    'action-detail-panel.tsx',
    'contact-detail-panel.tsx',
    'document-detail-panel.tsx',
    'project-detail-panel.tsx',
    'initiative-detail-panel.tsx',
  ] as const

  it.each(PANELS)('%s imports NoteEditor from the lazy wrapper', (panel) => {
    const src = strip(read(`${VIEWS}/${panel}`))
    expect(src).toMatch(/import \{ NoteEditor \} from '\.\/note-editor-lazy'/)
    // The direct module may still be imported for TYPES, which cost nothing —
    // but never for the component value.
    expect(src).not.toMatch(/import \{[^}]*\bNoteEditor\b[^}]*\} from '\.\/note-editor'/)
  })

  it('the lazy wrapper actually defers, with a loading state', () => {
    const src = strip(read(`${VIEWS}/note-editor-lazy.tsx`))
    expect(src).toMatch(/dynamic<NoteEditorProps>\(/)
    expect(src).toMatch(/import\('\.\/note-editor'\)/)
    expect(src).toContain('ssr: false')
    expect(src).toContain('loading:')
  })

  it('no OTHER dashboard view slips in a static NoteEditor import', () => {
    // Catches a new panel added later that imports the editor directly.
    for (const file of readdirSync(join(process.cwd(), VIEWS))) {
      if (!file.endsWith('.tsx')) continue
      if (file === 'note-editor.tsx' || file === 'note-editor-lazy.tsx') continue
      const src = strip(read(`${VIEWS}/${file}`))
      expect(
        src,
        `${file} imports NoteEditor directly — use ./note-editor-lazy`,
      ).not.toMatch(/import \{[^}]*\bNoteEditor\b[^}]*\} from '\.\/note-editor'/)
    }
  })
})

describe('the tool ceiling stays free of zod and the ai SDK', () => {
  it('editions reaches the ceiling through the zod-free core module', () => {
    const src = strip(read('src/lib/editions/tool-ceiling.ts'))
    // `@/lib/editions` is imported by the nav rail and the calendar, so this
    // file must never reach tool-discovery (which imports `ai` and `zod`).
    expect(src).toMatch(/from '@\/lib\/ai\/tool-ceiling-core'/)
    expect(src).not.toMatch(/from '@\/lib\/ai\/tool-discovery'/)
  })

  it('the core module imports neither package', () => {
    const src = strip(read('src/lib/ai/tool-ceiling-core.ts'))
    expect(src).not.toMatch(/from ['"]zod['"]/)
    expect(src).not.toMatch(/from ['"]ai['"]/)
  })

  it('tool-discovery still re-exports both symbols, so server callers are unchanged', () => {
    const src = strip(read('src/lib/ai/tool-discovery.ts'))
    expect(src).toMatch(/export \{ CORE_TOOL_NAMES, computeToolCeiling \} from '\.\/tool-ceiling-core'/)
  })
})
