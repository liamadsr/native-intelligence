// @vitest-environment jsdom
/**
 * Edit environment (edit-environment-dialog.tsx, docs/plans/environments.md §6):
 *
 *   A Mac    Name and Folders, each folder's mode shown (not editable), its
 *            base branch only when the Mac's app supports one, its linked
 *            repo; + Add only in the desktop app on THAT Mac, else "Add on
 *            <Mac>"; no network, env vars or setup script; Remove this Mac,
 *            whose MAC_BUSY refusal is shown as the server's sentence.
 *   Cloud    Name, network (restricted for a new one), env vars and setup
 *            script (masked and read-only for someone who can't edit), Who
 *            can use it; an ENVIRONMENT_IN_USE refusal (unshare, archive)
 *            shown as the server's sentence.
 *   Both     validation mirrors the server's, before anything is sent.
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

import { EditEnvironmentDialog, countEnvVars, nameError } from '../edit-environment-dialog'
import { configureEnvironment, resetEnvironmentStore, type EnvironmentItem } from '@/lib/local-agent/environment-client'
import type { LocalAgentStatus } from '@/lib/tauri-bridge'
import { THIS_MAC, cloud, fakeFetch, json, mac, type FakeRoute } from './fixtures'

let container: HTMLDivElement
let root: Root
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null
const all = (sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[]
const flush = () => act(async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve()
})
const onSaved = vi.fn()
const onGone = vi.fn()
const onOpenChange = vi.fn()

/** Type into a React-controlled field. */
function type(el: HTMLElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const STATUS = { available: true, reason: null, node: null, agentDir: null, built: true, grants: [], jobs: [] } as LocalAgentStatus

async function open(environment: EnvironmentItem | null, opts: { routes?: FakeRoute[]; desktopOn?: string | null } = {}) {
  const f = fakeFetch(
    {
      list: environment ? [environment] : [],
      local: {
        devices: [{ id: THIS_MAC, name: "Liam's MacBook Pro", online: true }],
        folders: [
          { id: 'f-1', deviceId: THIS_MAC, grantId: 'g-1', label: 'dial8-website', path: '/Users/liam/code/dial8-v2/dial8-website', mode: 'edit', isGit: true, deviceName: "Liam's MacBook Pro", online: true },
        ],
        worktrees: [],
      },
    },
    opts.routes,
  )
  vi.stubGlobal('fetch', f.fn)
  configureEnvironment({
    fetch: f.fn as never,
    isDesktop: () => opts.desktopOn !== undefined && opts.desktopOn !== null,
    status: async () => STATUS,
    device: async () => ({ ok: true as const, value: { deviceId: opts.desktopOn ?? '', name: 'x', platform: 'macos', appVersion: '0.3.0' } }),
  })
  await act(async () => root.render(h(EditEnvironmentDialog, { open: true, onOpenChange, environment, onSaved, onGone })))
  await flush()
  return f
}

const submit = async () => {
  await act(async () => q('[data-environment-save]')!.click())
  await flush()
}

beforeEach(() => {
  resetEnvironmentStore()
  onSaved.mockClear()
  onGone.mockClear()
  onOpenChange.mockClear()
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

describe('the validators', () => {
  it('a name of 1 to 80 characters; env var lines counted', () => {
    expect(nameError('  ')).toBe('Name is required')
    expect(nameError('x'.repeat(81))).toBe('Name must be at most 80 characters')
    expect(nameError('Studio')).toBeNull()
    expect(countEnvVars('A=1\n# note\n\nexport B=2\nnot a var')).toBe(2)
  })
})

describe('a Mac', () => {
  it('Name and Folders; each folder’s mode is shown, not editable; no cloud fields', async () => {
    await open(mac())
    expect(q('[data-edit-environment]')!.getAttribute('data-edit-environment')).toBe('mac')
    expect((q('[data-environment-field="name"]') as HTMLInputElement).value).toBe("Liam's MacBook Pro")
    const rows = all('[data-environment-dialog-folder]')
    expect(rows.map((r) => r.getAttribute('data-environment-dialog-folder'))).toEqual(['f-1', 'f-2'])
    expect(rows[0].querySelector('[data-environment-mode]')!.textContent).toBe('Edits on a branch · change on your Mac')
    expect(rows[1].querySelector('[data-environment-mode]')!.textContent).toBe('Read only · change on your Mac')
    // The person's own path, dimmed, from the Mac's store.
    expect(rows[0].textContent).toContain('dial8-website · ~/code/dial8-v2')
    expect(q('[data-environment-field="network"]')).toBeNull()
    expect(q('[data-environment-disclosure="env-vars"]')).toBeNull()
    expect(q('[data-environment-field="shared"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Worktree')
  })

  it('the base branch only when the Mac’s app supports one, and only on an edit-mode git folder; a linked repo only on a git folder', async () => {
    await open(mac())
    expect(all('[data-environment-dialog-folder="f-1"] [data-environment-field="base-branch"]')).toHaveLength(1)
    expect((q('[data-environment-field="base-branch"]') as HTMLInputElement).value).toBe('main')
    // notes: read only, not git.
    expect(all('[data-environment-dialog-folder="f-2"] input')).toHaveLength(0)
    act(() => root.unmount())
    root = createRoot(container)
    resetEnvironmentStore()
    await open(mac({ supportsBaseBranch: false }))
    expect(all('[data-environment-field="base-branch"]')).toHaveLength(0)
    expect(all('[data-environment-field="repo"]')).toHaveLength(1)
    resetEnvironmentStore()
    act(() => root.unmount())
    root = createRoot(container)
    await open(mac({ folders: [{ id: 'f-3', label: 'docs', mode: 'read', isGit: true, baseBranch: null, repoFullName: null }] }))
    expect(all('[data-environment-dialog-folder="f-3"] [data-environment-field="base-branch"]')).toHaveLength(0)
    expect(all('[data-environment-dialog-folder="f-3"] [data-environment-field="repo"]')).toHaveLength(1)
  })

  it('+ Add only in the desktop app on that Mac; elsewhere "Add on <Mac>"', async () => {
    await open(mac(), { desktopOn: THIS_MAC })
    await flush()
    expect(q('[data-environment-dialog-add]')).not.toBeNull()
    expect(q('[data-environment-add-elsewhere]')).toBeNull()
    act(() => root.unmount())
    root = createRoot(container)
    resetEnvironmentStore()
    await open(mac(), { desktopOn: 'dev-other' })
    expect(q('[data-environment-dialog-add]')).toBeNull()
    expect(q('[data-environment-add-elsewhere]')!.textContent).toBe("Add on Liam's MacBook Pro")
  })

  it('Save: the name, then each changed folder setting', async () => {
    const f = await open(mac(), {
      routes: [
        { method: 'PATCH', url: '/api/account/environments/env-mac', reply: (body) => json({ environment: { ...mac(), ...(body as object) } }) },
        { method: 'PATCH', url: '/api/account/environments/folders/', reply: (body) => json({ folder: { deviceFolderId: 'f-1', baseBranch: 'main', repoFullName: null, ...(body as object) } }) },
      ],
    })
    type(q('[data-environment-field="name"]')!, 'Studio')
    type(q('[data-environment-field="repo"]')!, 'liamadsr/dial8-v2')
    await submit()
    const writes = f.calls.filter((c) => c.method !== 'GET')
    expect(writes).toEqual([
      { method: 'PATCH', url: '/api/account/environments/env-mac', body: { name: 'Studio' } },
      { method: 'PATCH', url: '/api/account/environments/folders/f-1', body: { repoFullName: 'liamadsr/dial8-v2' } },
    ])
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ name: 'Studio' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('an invalid base branch or repo is refused before anything is sent', async () => {
    const f = await open(mac())
    type(all('[data-environment-field="base-branch"]')[0], 'main..evil')
    type(all('[data-environment-field="repo"]')[0], 'not a repo')
    await flush()
    expect(document.body.textContent).toContain('The base branch must be a plain local branch name, like main')
    expect(document.body.textContent).toContain('The linked repo must look like owner/repo')
    await submit()
    expect(f.calls.filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('Remove this Mac: a short confirm; MAC_BUSY is the server’s sentence', async () => {
    const sentence = 'A Native Intelligence job is still open on this Mac. Stop it first, then remove the Mac.'
    const f = await open(mac(), {
      routes: [{ method: 'DELETE', url: `/api/account/environments/macs/${THIS_MAC}`, reply: () => json({ error: sentence, code: 'MAC_BUSY' }, 409) }],
    })
    await act(async () => q('[data-environment-remove-mac]')!.click())
    await flush()
    expect(document.body.textContent).toContain('Remove this Mac?')
    await act(async () => q('[data-environment-confirm]')!.click())
    await flush()
    expect(f.calls.at(-1)).toMatchObject({ method: 'DELETE', url: `/api/account/environments/macs/${THIS_MAC}` })
    expect(q('[data-environment-error]')!.textContent).toBe(sentence)
    expect(onGone).not.toHaveBeenCalled()
  })
})

describe('cloud', () => {
  it('new: network restricted, the workspace can use it; Create sends every field', async () => {
    const f = await open(null, {
      routes: [{ method: 'POST', url: '/api/account/environments', reply: (body) => json({ environment: { ...cloud({ id: 'env-new' }), ...(body as object) } }) }],
    })
    expect(q('[data-edit-environment]')!.textContent).toContain('New cloud environment')
    expect(q('[data-environment-field="network"] [aria-checked="true"]')!.getAttribute('data-environment-option')).toBe('restricted')
    expect(all('[data-environment-field="network"] [role="radio"]').map((el) => el.getAttribute('data-environment-option'))).toEqual(['trusted', 'restricted', 'isolated'])
    expect(q('[data-environment-field="shared"] [aria-checked="true"]')!.getAttribute('data-environment-option')).toBe('workspace')
    // No Mac fields.
    expect(q('[data-environment-dialog-folder]')).toBeNull()
    expect(q('[data-environment-remove-mac]')).toBeNull()
    type(q('[data-environment-field="name"]')!, 'Frontend')
    await act(async () => q('[data-environment-field="network"] [data-environment-option="isolated"]')!.click())
    await submit()
    expect(f.calls.at(-1)).toEqual({ method: 'POST', url: '/api/account/environments', body: { name: 'Frontend', networkAccess: 'isolated', shared: true } })
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 'env-new', name: 'Frontend' }))
  })

  it('an editor opens the env vars; a name is required', async () => {
    const f = await open(cloud())
    expect(q('[data-environment-summary="env-vars"]')!.textContent).toBe('2 variables')
    await act(async () => q('[data-environment-disclosure="env-vars"] button')!.click())
    expect((q('[data-environment-field="env-vars"]') as HTMLTextAreaElement).value).toBe('NODE_ENV=test\nAPI_URL=https://example.test')
    type(q('[data-environment-field="name"]')!, '  ')
    await submit()
    expect(document.body.textContent).toContain('Name is required')
    expect(f.calls.filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('someone who can’t edit: masked, read-only, only Close', async () => {
    await open(cloud({ canEdit: false, envVars: null, setupScript: null, secretsHidden: true }))
    expect(q('[data-environment-summary="env-vars"]')!.textContent).toBe('Set · hidden')
    expect((q('[data-environment-disclosure="env-vars"] button') as HTMLButtonElement).disabled).toBe(true)
    expect(q('[data-environment-field="env-vars"]')).toBeNull()
    expect((q('[data-environment-field="name"]') as HTMLInputElement).disabled).toBe(true)
    expect(q('[data-environment-save]')).toBeNull()
    expect(q('[data-environment-archive]')).toBeNull()
    expect(q('[data-environment-readonly]')).not.toBeNull()
  })

  it('made "only me" while a project uses it: ENVIRONMENT_IN_USE is the server’s sentence; only what changed is sent', async () => {
    const sentence = 'This environment can’t be made only yours while 1 project uses it. Pick another environment for it first.'
    const f = await open(cloud({ projectCount: 1 }), {
      routes: [{ method: 'PATCH', url: '/api/account/environments/env-cloud', reply: () => json({ error: sentence, code: 'ENVIRONMENT_IN_USE' }, 409) }],
    })
    await act(async () => q('[data-environment-field="shared"] [data-environment-option="me"]')!.click())
    await submit()
    expect(f.calls.at(-1)).toEqual({ method: 'PATCH', url: '/api/account/environments/env-cloud', body: { shared: false } })
    expect(q('[data-environment-error]')!.textContent).toBe(sentence)
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('Archive: confirm, then the refusal as the server’s sentence', async () => {
    const sentence = 'This environment can’t be archived while it is the workspace’s default cloud environment. Pick another environment for it first.'
    await open(cloud({ isWorkspaceDefault: true }), {
      routes: [{ method: 'DELETE', url: '/api/account/environments/env-cloud', reply: () => json({ error: sentence, code: 'ENVIRONMENT_IN_USE' }, 409) }],
    })
    await act(async () => q('[data-environment-archive]')!.click())
    await flush()
    await act(async () => q('[data-environment-confirm]')!.click())
    await flush()
    expect(q('[data-environment-error]')!.textContent).toBe(sentence)
    expect(onGone).not.toHaveBeenCalled()
  })
})
