// @vitest-environment jsdom
/**
 * Where an agent's canon edit is checked now that it applies at once
 * (decision 16): the document's history shows each edit's sources by kind and
 * domain, a quiet "from a web page" label on one that rested on outside text,
 * and "Revert just this edit"; the "not checked since" marker lists stale
 * sections, with "Mark checked" for someone who may edit, and renders nothing
 * when every section is fresh.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { DocumentHistory } from '../document-history'
import { StaleSectionsNote } from '../stale-sections-note'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

let root: Root
let el: HTMLDivElement
async function mount(node: ReturnType<typeof h>) {
  el = document.createElement('div')
  document.body.appendChild(el)
  root = createRoot(el)
  await act(async () => { root.render(node) })
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  vi.unstubAllGlobals()
})
const button = (label: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.includes(label))

const EDIT = {
  revision_number: 7,
  title: 'Product',
  author_kind: 'agent',
  author_id: 'm1',
  author_name: 'Liam',
  change_summary: 'Added to "Positioning"',
  section: 'Positioning',
  reason: 'What a competitor’s pricing page says',
  sources: [{ kind: 'web', url: 'https://www.gong.example/pricing' }],
  outside: 'a web page on gong.example',
  created_at: '2026-10-20T09:00:00Z',
  updated_at: '2026-10-20T09:00:00Z',
}
const BEFORE = { ...EDIT, revision_number: 6, author_kind: 'human', change_summary: 'Edited', section: undefined, reason: undefined, sources: undefined, outside: undefined }

describe('DocumentHistory', () => {
  it('an applied outside-sourced edit shows its label, where it came from, and Revert just this edit', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url)
      if (url.includes('?limit=')) return new Response(JSON.stringify({ revisions: [EDIT, BEFORE] }))
      return new Response(JSON.stringify({ revision: { ...EDIT, content: '## Positioning\nVs spreadsheets.\nCheaper than Gong.', frontmatter: {} }, previous: { ...BEFORE, content: '## Positioning\nVs spreadsheets.', frontmatter: {} } }))
    }))
    await mount(h(DocumentHistory, { documentId: 'd1', currentRevision: 7, canRestore: true, onRestored: () => {} }))
    expect(el.querySelector('[data-testid="revision-outside"]')!.textContent).toContain('from a web page on gong.example')
    expect(el.querySelector('[data-testid="revision-outside-detail"]')!.textContent).toBe('It rests on outside text: revert it if it’s wrong.')
    expect(el.textContent).toContain('From a web page on gong.example')
    expect(el.textContent).not.toContain('https://www.gong.example/pricing')
    expect(button('Revert just this edit')).toBeTruthy()
  })
})

describe('StaleSectionsNote', () => {
  it('renders nothing while every section is fresh', async () => {
    await mount(h(StaleSectionsNote, { documentId: 'd1', sections: [], canMark: true, onMarked: () => {} }))
    expect(el.innerHTML).toBe('')
  })

  it('lists a stale section quietly; Mark checked stamps it and it leaves the list', async () => {
    const marked: string[] = []
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }))))
    await mount(h(StaleSectionsNote, { documentId: 'd1', sections: [{ heading: 'Positioning', lastVerifiedAt: '2026-06-01T12:00:00Z' }], canMark: true, onMarked: (s: string) => marked.push(s) }))
    expect(el.textContent).toMatch(/Positioning not checked since Jun 1/)
    await act(async () => { button('Mark checked')!.click() })
    expect(marked).toEqual(['Positioning'])
  })

  it('someone who may not edit sees the marker without Mark checked', async () => {
    await mount(h(StaleSectionsNote, { documentId: 'd1', sections: [{ heading: 'Voice', lastVerifiedAt: '2026-06-01T00:00:00Z' }], canMark: false, onMarked: () => {} }))
    expect(el.textContent).toContain('Voice not checked since')
    expect(button('Mark checked')).toBeUndefined()
  })
})
