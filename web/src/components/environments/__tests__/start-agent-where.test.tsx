// @vitest-environment jsdom
/**
 * "in the cloud / on <your Mac>" beside an action's Start (start-agent-where.tsx):
 *
 *   - not a coding run (GET …/start-agent's `coding` is null), or no Mac: nothing;
 *   - a coding run and a Mac: where the Start runs now, and the choice of the
 *     cloud or the Mac, which sets the project's own "Run my work here" (PUT
 *     …/environments/default, the switch the project panel shows) and reads
 *     where the Start runs again, so the "with" picker can appear;
 *   - the Mac chosen with no folder linked to the repo: one sentence, and
 *     Link a folder (that Mac's Edit environment).
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

const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
vi.mock('@/lib/local-agent/relay-core', () => ({ refreshLocalAgentDevice: vi.fn(async () => null) }))
vi.mock('../edit-environment-dialog', () => ({
  EditEnvironmentDialog: ({ environment }: { environment: { id: string } }) => h('div', { 'data-edit-environment': environment.id }),
}))

import { StartAgentWhere, unlinkedFolderSentence } from '../start-agent-where'
import { useStartOnMac } from '../start-agent-with'
import { configureEnvironment, resetEnvironmentStore } from '@/lib/local-agent/environment-client'
import { cloud, fakeFetch, json, mac } from './fixtures'

const ACTION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const PROJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const START_URL = `/api/account/actions/${ACTION}/start-agent`
const REPO = 'liamadsr/native-intelligence'
const STUDIO = (over: Parameters<typeof mac>[0] = {}) => mac({ name: 'Studio Mac', deviceName: 'Studio Mac', ...over })

let container: HTMLDivElement
let root: Root
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null
const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })

function Host() {
  const place = useStartOnMac(ACTION, true)
  return h('div', { 'data-place': place.macId ?? 'cloud' }, h(StartAgentWhere, { place, enabled: true }))
}

/** `onMac`: the Mac "Run my work here" names now (the PUT changes it); `coding`: a coding run or not. */
async function mount(opts: { coding: boolean; onMac: string | null; envs: unknown[] }) {
  let onMac = opts.onMac
  const f = fakeFetch({ list: opts.envs }, [
    { url: START_URL, reply: () => json({ onMac: onMac ? { environmentId: onMac } : null, coding: opts.coding ? { projectId: PROJECT, repo: REPO } : null }) },
    {
      method: 'PUT',
      url: '/api/account/environments/default',
      reply: (body) => {
        onMac = (body as { environmentId: string | null }).environmentId
        return json({ environmentId: onMac, projectId: PROJECT })
      },
    },
  ])
  vi.stubGlobal('fetch', f.fn)
  configureEnvironment({ fetch: f.fn as never, isDesktop: () => false })
  await act(async () => root.render(h(Host)))
  await flush()
  return f
}

async function open() {
  await act(async () => {
    q('[data-start-agent-where]')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }))
  })
  await flush()
}

beforeEach(() => {
  resetEnvironmentStore()
  toast.mockClear()
  toast.error.mockClear()
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

describe('unlinkedFolderSentence', () => {
  it('only when the Mac has no folder linked to the repo (names ignore case)', () => {
    expect(unlinkedFolderSentence(STUDIO(), REPO)).toBeNull()
    expect(unlinkedFolderSentence(STUDIO(), REPO.toUpperCase())).toBeNull()
    expect(unlinkedFolderSentence(STUDIO(), 'acme/core')).toBe('No folder on Studio Mac is linked to acme/core.')
    expect(unlinkedFolderSentence(null, 'acme/core')).toBeNull()
  })
})

describe('where the Start runs, chosen at the Start', () => {
  it('a work run (no repo, not a developer agent): nothing, even with a Mac', async () => {
    await mount({ coding: false, onMac: null, envs: [STUDIO(), cloud()] })
    expect(q('[data-start-agent-where]')).toBeNull()
  })

  it('a coding run but no Mac: nothing (the cloud is the only place)', async () => {
    await mount({ coding: true, onMac: null, envs: [cloud()] })
    expect(q('[data-start-agent-where]')).toBeNull()
  })

  it('a coding run in the cloud with a Mac available: choosing the Mac sets “Run my work here” and reads the Start again', async () => {
    const f = await mount({ coding: true, onMac: null, envs: [STUDIO(), cloud()] })
    const trigger = q('[data-start-agent-where]')!
    expect(trigger.getAttribute('data-start-agent-where')).toBe('cloud')
    expect(trigger.textContent).toContain('in the cloud')
    await open()
    expect([...document.querySelectorAll('[data-start-agent-where-option]')].map((el) => el.getAttribute('data-start-agent-where-option'))).toEqual(['cloud', 'env-mac'])
    const reads = f.calls.filter((c) => c.url === START_URL).length
    await act(async () => q('[data-start-agent-where-option="env-mac"]')!.click())
    await flush()
    // The project's own switch, not a second setting.
    expect(f.calls.filter((c) => c.method === 'PUT')).toEqual([
      { method: 'PUT', url: '/api/account/environments/default', body: { projectId: PROJECT, environmentId: 'env-mac' } },
    ])
    expect(f.calls.filter((c) => c.url === START_URL).length).toBe(reads + 1)
    expect(q('[data-place]')!.getAttribute('data-place')).toBe('env-mac')
    expect(q('[data-start-agent-where]')!.textContent).toContain('on Studio Mac')
    // The folder is linked: nothing to say.
    expect(toast).not.toHaveBeenCalled()
  })

  it('back to the cloud turns “Run my work here” off', async () => {
    const f = await mount({ coding: true, onMac: 'env-mac', envs: [STUDIO(), cloud()] })
    expect(q('[data-start-agent-where]')!.textContent).toContain('on Studio Mac')
    await open()
    await act(async () => q('[data-start-agent-where-option="cloud"]')!.click())
    await flush()
    expect(f.calls.find((c) => c.method === 'PUT')!.body).toEqual({ projectId: PROJECT, environmentId: null })
    expect(q('[data-place]')!.getAttribute('data-place')).toBe('cloud')
  })

  it('the Mac with no folder linked to the repo: one sentence, and Link a folder opens that Mac', async () => {
    const unlinked = STUDIO({ folders: [{ id: 'f-9', label: 'notes', mode: 'read', isGit: false, baseBranch: null, repoFullName: null }] })
    await mount({ coding: true, onMac: null, envs: [unlinked, cloud()] })
    await open()
    await act(async () => q('[data-start-agent-where-option="env-mac"]')!.click())
    await flush()
    expect(toast).toHaveBeenCalledWith(`No folder on Studio Mac is linked to ${REPO}.`, expect.objectContaining({ action: expect.objectContaining({ label: 'Link a folder' }) }))
    expect(q('[data-start-agent-where]')!.hasAttribute('data-start-agent-where-unlinked')).toBe(true)
    await open()
    expect(q('[data-start-agent-where-unlinked-note]')!.textContent).toBe(`No folder on Studio Mac is linked to ${REPO}.`)
    await act(async () => q('[data-start-agent-where-link]')!.click())
    await flush()
    expect(q('[data-edit-environment]')!.getAttribute('data-edit-environment')).toBe('env-mac')
  })

  it('a refused change: the place stays, and the server’s sentence shows', async () => {
    const f = fakeFetch({ list: [STUDIO(), cloud()] }, [
      { url: START_URL, reply: () => json({ onMac: null, coding: { projectId: PROJECT, repo: REPO } }) },
      { method: 'PUT', url: '/api/account/environments/default', reply: () => json({ error: 'That Mac was removed.' }, 409) },
    ])
    vi.stubGlobal('fetch', f.fn)
    configureEnvironment({ fetch: f.fn as never, isDesktop: () => false })
    await act(async () => root.render(h(Host)))
    await flush()
    await open()
    await act(async () => q('[data-start-agent-where-option="env-mac"]')!.click())
    await flush()
    expect(toast.error).toHaveBeenCalledWith('Couldn’t run your work on Studio Mac', { description: 'That Mac was removed.' })
    expect(q('[data-place]')!.getAttribute('data-place')).toBe('cloud')
  })
})
