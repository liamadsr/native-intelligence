// @vitest-environment jsdom
/**
 * Settings → Environments (environments-view.tsx, docs/plans/environments.md §6):
 * every environment in one list, your Macs first (only when you have one),
 * then the workspace's cloud environments; New and Edit open Edit
 * environment; Archive (for someone who can change it) says the server's
 * refusal.
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

const m = vi.hoisted(() => ({ toastError: vi.fn(), dialog: vi.fn((_props: unknown) => null) }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: m.toastError, success: vi.fn() }) }))
vi.mock('next/link', () => ({ default: ({ children, href }: { children: unknown; href: string }) => h('a', { href }, children as never) }))
vi.mock('@/lib/local-agent/relay-core', () => ({ refreshLocalAgentDevice: vi.fn(async () => null) }))
vi.mock('@/components/environments/edit-environment-dialog', () => ({ EditEnvironmentDialog: (props: unknown) => m.dialog(props) }))

import { EnvironmentsView, archiveDescription } from '../environments-view'
import { configureEnvironment, resetEnvironmentStore } from '@/lib/local-agent/environment-client'
import { cloud, fakeFetch, json, mac, type FakeRoute } from '@/components/environments/__tests__/fixtures'

let container: HTMLDivElement
let root: Root
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null
const flush = () => act(async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve()
})

async function mount(list: unknown[], routes: FakeRoute[] = []) {
  const f = fakeFetch({ list }, routes)
  vi.stubGlobal('fetch', f.fn)
  configureEnvironment({ fetch: f.fn as never, isDesktop: () => false })
  await act(async () => root.render(h(EnvironmentsView)))
  await flush()
  return f
}

beforeEach(() => {
  resetEnvironmentStore()
  m.toastError.mockClear()
  m.dialog.mockClear()
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

describe('Settings → Environments', () => {
  it('your Macs, then cloud; badges for the default and "only me"', async () => {
    await mount([mac(), cloud({ isWorkspaceDefault: true, projectCount: 2 }), cloud({ id: 'env-mine', name: 'Mine', shared: false, canEdit: false })])
    const sections = [...document.querySelectorAll('[data-environments-section]')].map((el) => el.getAttribute('data-environments-section'))
    expect(sections).toEqual(['macs', 'cloud'])
    expect(q('[data-environments-row="env-mac"]')!.textContent).toContain('2 folders: dial8-website, notes')
    expect(q('[data-environments-row="env-cloud"]')!.textContent).toContain('Used by 2 projects')
    expect(q('[data-environments-row="env-cloud"] [data-environments-default]')).not.toBeNull()
    expect(q('[data-environments-row="env-mine"] [data-environments-only-me]')).not.toBeNull()
    // Archive only for someone who can change it.
    expect(q('[data-environments-archive="env-cloud"]')).not.toBeNull()
    expect(q('[data-environments-archive="env-mine"]')).toBeNull()
  })

  it('no Mac: no Macs section; no cloud: the way to make one', async () => {
    await mount([])
    expect(q('[data-environments-section="macs"]')).toBeNull()
    expect(q('[data-environments-section="cloud"]')!.textContent).toContain('No cloud environments yet')
  })

  it('New and Edit open Edit environment', async () => {
    await mount([mac(), cloud()])
    await act(async () => q('[data-environments-new]')!.click())
    expect(m.dialog).toHaveBeenLastCalledWith(expect.objectContaining({ open: true, environment: null }))
    await act(async () => (q('[data-environments-row="env-mac"] button') as HTMLButtonElement).click())
    expect(m.dialog).toHaveBeenLastCalledWith(expect.objectContaining({ environment: expect.objectContaining({ id: 'env-mac' }) }))
  })

  it('Archive: refused, the server’s sentence; archived, gone from the list', async () => {
    const sentence = 'This environment can’t be archived while 1 project uses it. Pick another environment for it first.'
    await mount([cloud({ projectCount: 1 })], [{ method: 'DELETE', url: '/api/account/environments/env-cloud', reply: () => json({ error: sentence, code: 'ENVIRONMENT_IN_USE' }, 409) }])
    await act(async () => q('[data-environments-archive="env-cloud"]')!.click())
    await flush()
    const confirm = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Archive')!
    await act(async () => confirm.click())
    await flush()
    expect(m.toastError).toHaveBeenCalledWith('Couldn’t archive the environment', { description: sentence })
    expect(q('[data-environments-row="env-cloud"]')).not.toBeNull()

    act(() => root.unmount())
    root = createRoot(container)
    resetEnvironmentStore()
    await mount([cloud()], [{ method: 'DELETE', url: '/api/account/environments/env-cloud', reply: () => json({ archived: true }) }])
    await act(async () => q('[data-environments-archive="env-cloud"]')!.click())
    await flush()
    await act(async () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Archive')!.click())
    await flush()
    expect(q('[data-environments-row="env-cloud"]')).toBeNull()
  })

  it('the archive confirm says what stops it', () => {
    expect(archiveDescription({ name: 'CI', projectCount: 0, isWorkspaceDefault: false })).toBe('“CI” leaves every list. Chats that used it move to the next default.')
    expect(archiveDescription({ name: 'CI', projectCount: 2, isWorkspaceDefault: true })).toBe(
      '“CI” can’t be archived while 2 projects use it and it is the workspace’s default. Pick another environment for them first.',
    )
  })
})
