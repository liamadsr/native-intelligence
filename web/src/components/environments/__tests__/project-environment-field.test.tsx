// @vitest-environment jsdom
/**
 * The project panel's Environment rows (project-environment-field.tsx,
 * docs/plans/environments.md §6, §7 Q7):
 *
 *   - Environment: the workspace's SHARED cloud environments only (no Mac, no
 *     "only me" one), linked or unlinked through the project;
 *   - "Run my work here on <your Mac>": only when you have a Mac; read once
 *     per project, PUT on a toggle (null turns it off); a read that fails
 *     shows no switch; on, with no folder there linked to the project's repo,
 *     a line links one in that Mac's Edit environment.
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

const dialog = vi.hoisted(() => vi.fn((_props: unknown) => null))
const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: toastError, success: vi.fn() }) }))
vi.mock('@/lib/local-agent/relay-core', () => ({ refreshLocalAgentDevice: vi.fn(async () => null) }))
vi.mock('../edit-environment-dialog', () => ({ EditEnvironmentDialog: (props: unknown) => dialog(props) }))

import { ProjectEnvironmentField, macLinksRepo, type ProjectEnvironmentFieldProps } from '../project-environment-field'
import { configureEnvironment, resetEnvironmentStore } from '@/lib/local-agent/environment-client'
import { cloud, fakeFetch, json, mac, type FakeRoute } from './fixtures'

let container: HTMLDivElement
let root: Root
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null
const all = (sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[]
const flush = () => act(async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve()
})
const onLink = vi.fn()

async function mount(list: unknown[], routes: FakeRoute[] = [], over: Partial<ProjectEnvironmentFieldProps> = {}) {
  const f = fakeFetch({ list }, routes)
  vi.stubGlobal('fetch', f.fn)
  configureEnvironment({ fetch: f.fn as never, isDesktop: () => false })
  const props: ProjectEnvironmentFieldProps = {
    projectId: 'p-1',
    workspaceId: 'ws-1',
    githubRepo: 'liamadsr/native-intelligence-desktop',
    environmentId: null,
    environmentName: null,
    environmentNetworkAccess: null,
    onLink,
    ...over,
  }
  await act(async () => root.render(h(ProjectEnvironmentField, props)))
  await flush()
  return f
}

const SHARED_AND_NOT = [mac(), cloud({ id: 'env-shared', name: 'Shared' }), cloud({ id: 'env-mine', name: 'Mine', shared: false })]
const DEFAULT_GET = '/api/account/environments/default?workspaceId=ws-1&projectId=p-1'
const defaultRoute = (environmentId: string | null): FakeRoute => ({ url: DEFAULT_GET, reply: () => json({ environmentId }) })

beforeEach(() => {
  resetEnvironmentStore()
  onLink.mockClear()
  dialog.mockClear()
  toastError.mockClear()
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

describe('the project’s Environment', () => {
  it('links one of the workspace’s shared cloud environments only', async () => {
    await mount(SHARED_AND_NOT, [defaultRoute(null)])
    await act(async () => q('[data-project-environment-link]')!.click())
    await flush()
    expect(all('[data-project-environment-option]').map((el) => el.getAttribute('data-project-environment-option'))).toEqual(['env-shared'])
    await act(async () => q('[data-project-environment-option="env-shared"]')!.click())
    expect(onLink).toHaveBeenCalledWith({ id: 'env-shared', name: 'Shared', networkAccess: 'restricted' })
  })

  it('linked: its name and network, × unlinks', async () => {
    await mount(SHARED_AND_NOT, [defaultRoute(null)], { environmentId: 'env-shared', environmentName: 'Shared', environmentNetworkAccess: 'isolated' })
    const row = q('[data-project-environment-linked]')!
    expect(row.textContent).toContain('Shared')
    expect(row.textContent).toContain('Isolated')
    await act(async () => row.querySelector('button')!.click())
    expect(onLink).toHaveBeenCalledWith(null)
  })

  it('New environment… opens Edit environment for a new one', async () => {
    await mount(SHARED_AND_NOT, [defaultRoute(null)])
    await act(async () => q('[data-project-environment-link]')!.click())
    await flush()
    await act(async () => q('[data-project-environment-new]')!.click())
    expect(dialog).toHaveBeenLastCalledWith(expect.objectContaining({ open: true, environment: null }))
  })
})

describe('Run my work here on <your Mac>', () => {
  it('not shown without a Mac (and its setting never read)', async () => {
    const f = await mount([cloud()])
    expect(q('[data-project-run-on-mac]')).toBeNull()
    expect(f.calls.some((c) => c.url.startsWith('/api/account/environments/default'))).toBe(false)
  })

  it('shows its real state: read once from GET …/default with the workspace and the project', async () => {
    const f = await mount(SHARED_AND_NOT, [defaultRoute('env-mac')])
    expect(f.calls.filter((c) => c.url.startsWith('/api/account/environments/default'))).toEqual([{ method: 'GET', url: DEFAULT_GET, body: undefined }])
    expect(q('[data-project-run-on-mac]')!.getAttribute('data-project-run-on-mac')).toBe('on')
    expect(q('[data-project-run-on-mac-switch]')!.getAttribute('aria-checked')).toBe('true')
  })

  it('read once; a toggle PUTs your Mac, and off PUTs null', async () => {
    const f = await mount(SHARED_AND_NOT, [
      defaultRoute(null),
      { method: 'PUT', url: '/api/account/environments/default', reply: (body) => json(body) },
    ])
    expect(q('[data-project-run-on-mac]')!.getAttribute('data-project-run-on-mac')).toBe('off')
    expect(q('[data-project-run-on-mac-switch]')!.getAttribute('aria-checked')).toBe('false')
    expect(q('[data-project-run-on-mac] label')!.textContent).toBe("Run my work here onLiam's MacBook Pro")
    await act(async () => q('[data-project-run-on-mac-switch]')!.click())
    await flush()
    expect(f.calls.at(-1)).toEqual({ method: 'PUT', url: '/api/account/environments/default', body: { workspaceId: 'ws-1', projectId: 'p-1', environmentId: 'env-mac' } })
    expect(q('[data-project-run-on-mac]')!.getAttribute('data-project-run-on-mac')).toBe('on')
    await act(async () => q('[data-project-run-on-mac-switch]')!.click())
    await flush()
    expect(f.calls.at(-1)).toEqual({ method: 'PUT', url: '/api/account/environments/default', body: { workspaceId: 'ws-1', projectId: 'p-1', environmentId: null } })
  })

  it('a refused toggle goes back, and says the server’s sentence', async () => {
    await mount(SHARED_AND_NOT, [
      defaultRoute(null),
      { method: 'PUT', url: '/api/account/environments/default', reply: () => json({ error: 'You can’t use this environment here', code: 'BAD_REQUEST' }, 400) },
    ])
    await act(async () => q('[data-project-run-on-mac-switch]')!.click())
    await flush()
    expect(q('[data-project-run-on-mac]')!.getAttribute('data-project-run-on-mac')).toBe('off')
    expect(toastError).toHaveBeenCalledWith("Couldn’t run your work here on Liam's MacBook Pro", { description: 'You can’t use this environment here' })
  })

  it('a read that fails shows no switch', async () => {
    await mount(SHARED_AND_NOT, [{ url: '/api/account/environments/default', reply: () => json({ error: 'Method not allowed' }, 405) }])
    expect(q('[data-project-run-on-mac]')).toBeNull()
  })

  it('on, with no folder there linked to the project’s repo: a line that opens the Mac’s Edit environment', async () => {
    await mount(SHARED_AND_NOT, [defaultRoute('env-mac')])
    expect(q('[data-project-run-on-mac]')!.getAttribute('data-project-run-on-mac')).toBe('on')
    expect(q('[data-project-run-on-mac-unlinked]')!.textContent).toContain('liamadsr/native-intelligence-desktop')
    await act(async () => q('[data-project-link-folder]')!.click())
    expect(dialog).toHaveBeenLastCalledWith(expect.objectContaining({ open: true, environment: expect.objectContaining({ id: 'env-mac' }) }))
  })

  it('a linked folder (any case) needs no line', async () => {
    expect(macLinksRepo(mac(), 'LiamADSR/Native-Intelligence')).toBe(true)
    expect(macLinksRepo(mac(), 'liamadsr/native-intelligence-desktop')).toBe(false)
    await mount(SHARED_AND_NOT, [defaultRoute('env-mac')], { githubRepo: 'liamadsr/native-intelligence' })
    expect(q('[data-project-run-on-mac-unlinked]')).toBeNull()
  })
})
