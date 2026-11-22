// @vitest-environment jsdom
/**
 * "Which folder on <Mac> holds <repo>?" (start-folder-choice.tsx): only git
 * folders; the one named like the repo preselected (never one linked to
 * another repo, never a read-only one); a read-only folder says why and
 * can't be picked; no git folder: one sentence. 'start' hands the pick to the
 * Start; 'link' links it here (PATCH …/folders/<id>) and the store learns it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }))
vi.mock('@/lib/local-agent/relay-core', () => ({ refreshLocalAgentDevice: vi.fn(async () => null) }))

import { StartFolderAnchor, StartFolderChoice, folderChoices } from '../start-folder-choice'
import { configureEnvironment, getEnvironmentsSnapshot, refreshEnvironments, resetEnvironmentStore } from '@/lib/local-agent/environment-client'
import { fakeFetch, json, mac } from './fixtures'
import type { MacEnvironmentItem } from '@/lib/local-agent/environment-client'

const REPO = 'liamadsr/native-intelligence'
const F = (id: string, label: string, over: Partial<MacEnvironmentItem['folders'][number]> = {}) => ({
  id, label, mode: 'edit' as const, isGit: true, baseBranch: 'main', repoFullName: null, ...over,
})
const STUDIO = (folders: MacEnvironmentItem['folders']) => mac({ name: 'Studio Mac', folders })

let container: HTMLDivElement
let root: Root
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null
const flush = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })

beforeEach(() => {
  resetEnvironmentStore()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  configureEnvironment(null)
  vi.unstubAllGlobals()
})

describe('folderChoices', () => {
  it('git folders only; the one named like the repo preselected', () => {
    const c = folderChoices(STUDIO([F('f-1', 'notes', { isGit: false }), F('f-2', 'site'), F('f-3', 'Native-Intelligence')]), REPO)!
    expect(c.rows.map((r) => r.id)).toEqual(['f-2', 'f-3'])
    expect(c.preselect).toBe('f-3')
  })

  it('never preselects a read-only folder or one linked to another repo; both still show', () => {
    const ro = folderChoices(STUDIO([F('f-1', 'native-intelligence', { mode: 'read' })]), REPO)!
    expect(ro.preselect).toBeNull()
    expect(ro.rows[0].blocked).toBe('native-intelligence on Studio Mac is read-only. Allow edits for it on your Mac, then press Start again.')
    const other = folderChoices(STUDIO([F('f-1', 'native-intelligence', { repoFullName: 'acme/other' })]), REPO)!
    expect(other.preselect).toBeNull()
    expect(other.rows[0]).toMatchObject({ blocked: null, otherRepo: 'acme/other' })
  })

  it('no git folder at all: null', () => {
    expect(folderChoices(STUDIO([F('f-1', 'notes', { isGit: false })]), REPO)).toBeNull()
  })
})

function render(m: MacEnvironmentItem, mode: 'start' | 'link', onStart = vi.fn()) {
  act(() =>
    root.render(
      h(StartFolderChoice, { open: true, onOpenChange: vi.fn(), mac: m, repo: REPO, mode, onStart, children: h(StartFolderAnchor, { asChild: true }, h('button', null, 'Start')) }),
    ),
  )
  return onStart
}

describe('the folder choice at the Start', () => {
  it('a matching folder preselected; “Link and start” hands it to the Start', async () => {
    const onStart = render(STUDIO([F('f-2', 'site'), F('f-3', 'native-intelligence')]), 'start')
    await flush()
    expect(q('[data-start-folder-choice]')!.textContent).toContain('Which folder on Studio Mac holds liamadsr/native-intelligence?')
    expect(q('[data-start-folder-option="f-3"]')!.getAttribute('aria-checked')).toBe('true')
    await act(async () => q('[data-start-folder-confirm]')!.click())
    expect(onStart).toHaveBeenCalledWith('f-3')
  })

  it('nothing matches: nothing is picked for the person, and the button waits for a pick', async () => {
    const onStart = render(STUDIO([F('f-2', 'site')]), 'start')
    await flush()
    expect((q('[data-start-folder-confirm]') as HTMLButtonElement).disabled).toBe(true)
    await act(async () => q('[data-start-folder-option="f-2"]')!.click())
    await act(async () => q('[data-start-folder-confirm]')!.click())
    expect(onStart).toHaveBeenCalledWith('f-2')
  })

  it('a read-only folder says why and can’t be picked', async () => {
    render(STUDIO([F('f-1', 'native-intelligence', { mode: 'read' })]), 'start')
    await flush()
    const row = q('[data-start-folder-option="f-1"]') as HTMLButtonElement
    expect(row.disabled).toBe(true)
    expect(row.textContent).toContain('is read-only. Allow edits for it on your Mac')
  })

  it('no git folder: one sentence, nothing to pick', async () => {
    render(STUDIO([F('f-1', 'notes', { isGit: false })]), 'start')
    await flush()
    expect(q('[data-start-folder-choice-none]')!.textContent).toContain('Add the folder in the Native Intelligence app on your Mac')
    expect(q('[data-start-folder-confirm]')).toBeNull()
  })

  it('“Link folder” (from Run on, before the press) links it and the list learns it', async () => {
    const m = STUDIO([F('f-3', 'native-intelligence')])
    const f = fakeFetch({ list: [m] }, [
      { method: 'PATCH', url: '/api/account/environments/folders/f-3', reply: () => json({ folder: { baseBranch: 'main', repoFullName: REPO } }) },
    ])
    vi.stubGlobal('fetch', f.fn)
    configureEnvironment({ fetch: f.fn as never, isDesktop: () => false })
    await refreshEnvironments({ force: true })
    render(m, 'link')
    await flush()
    await act(async () => q('[data-start-folder-confirm]')!.click())
    await flush()
    expect(f.calls.filter((c) => c.method === 'PATCH')).toEqual([{ method: 'PATCH', url: '/api/account/environments/folders/f-3', body: { repoFullName: REPO } }])
    const env = getEnvironmentsSnapshot().environments[0] as MacEnvironmentItem
    expect(env.folders[0].repoFullName).toBe(REPO)
  })
})
