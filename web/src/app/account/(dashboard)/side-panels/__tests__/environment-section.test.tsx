// @vitest-environment jsdom
/**
 * The side panel's Environment card body (environment-section.tsx): the main
 * chat's environment (docs/plans/environments.md §6).
 *
 *   - its mark and name, online / offline for a Mac, a gear that opens Edit
 *     environment; the card's summary is its name;
 *   - a Mac: each folder `label · ~/parent` (the path on hover), its mode, its
 *     base branch once the Mac's app supports one, × on this Mac's folders in
 *     the desktop app; each folder's branches ("Worktree", cut in the middle,
 *     a click copies); Add folder… on that Mac, else where to add them;
 *   - cloud: the network level;
 *   - no environment for the chat: no card.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const m = vi.hoisted(() => ({
  add: vi.fn(async () => {}),
  remove: vi.fn(async (_id: string) => {}),
  copy: vi.fn(async (_text: string) => true),
  dialog: vi.fn((_props: unknown) => null),
}))
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: m.copy }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }))
vi.mock('@/lib/local-agent/relay-core', () => ({ refreshLocalAgentDevice: vi.fn(async () => null) }))
vi.mock('@/lib/local-agent/environment-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/local-agent/environment-client')>()),
  addEnvironmentFolder: m.add,
  removeEnvironmentFolder: m.remove,
}))
vi.mock('@/components/environments/edit-environment-dialog', () => ({ EditEnvironmentDialog: (props: unknown) => m.dialog(props) }))

import { EnvironmentSection, environmentSummary, macFolders, useEnvironmentCard, type EnvironmentCard } from '../environment-section'
import { configureEnvironment, resetEnvironmentStore, type EnvironmentSnapshot } from '@/lib/local-agent/environment-client'
import { THIS_MAC, cloud, fakeFetch, mac } from '@/components/environments/__tests__/fixtures'

const local = (over: Partial<EnvironmentSnapshot> = {}): EnvironmentSnapshot => ({
  loaded: true,
  devices: [{ id: THIS_MAC, name: "Liam's MacBook Pro", online: true }],
  folders: [
    { id: 'f-1', deviceId: THIS_MAC, grantId: 'g-1', label: 'dial8-website', path: '/Users/sam/code/dial8-v2/dial8-website', mode: 'edit', isGit: true, deviceName: "Liam's MacBook Pro", online: true },
    { id: 'f-2', deviceId: THIS_MAC, grantId: 'g-2', label: 'notes', path: '/Users/sam/notes', mode: 'read', isGit: false, deviceName: "Liam's MacBook Pro", online: true },
    { id: 'f-9', deviceId: 'dev-studio', grantId: 'g-9', label: 'studio-only', path: '/Users/liam/x', mode: 'read', isGit: false, deviceName: 'Studio', online: false },
  ],
  worktrees: [{ sessionId: 's-1', folderId: 'f-1', branch: 'dial8/dial8-website-agent-orchestration-fc09cf', live: false }],
  thisDeviceId: THIS_MAC,
  canEdit: true,
  picking: false,
  removing: [],
  ...over,
})

const card = (over: Partial<EnvironmentCard> = {}): EnvironmentCard => {
  const environment = over.environment ?? mac()
  return { environment, local: over.local ?? local(), summary: environmentSummary(environment) }
}

let container: HTMLDivElement
let root: Root
const q = (sel: string) => container.querySelector(sel) as HTMLElement | null
const render = (c: EnvironmentCard) => act(() => root.render(h(EnvironmentSection, { card: c })))

beforeEach(() => {
  m.add.mockClear()
  m.remove.mockClear()
  m.copy.mockClear()
  m.dialog.mockClear()
  resetEnvironmentStore()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  configureEnvironment(null)
})

describe('the Environment card', () => {
  it('the summary is the environment’s name', () => {
    expect(environmentSummary(mac())).toBe("Liam's MacBook Pro")
    expect(environmentSummary(cloud())).toBe('Default cloud')
  })

  it('a Mac’s folders: the store’s (live) with the server’s base branch; before it reads, the environment’s', () => {
    const rows = macFolders(mac(), local())
    expect(rows.map((r) => [r.folder.label, r.folder.baseBranch, r.worktrees.length])).toEqual([
      ['dial8-website', 'main', 1],
      ['notes', null, 0],
    ])
    const before = macFolders(mac(), local({ loaded: false, folders: [], worktrees: [] }))
    expect(before.map((r) => [r.folder.label, r.folder.path])).toEqual([
      ['dial8-website', ''],
      ['notes', ''],
    ])
  })

  it('the environment row: its mark and name, online, and a gear that opens Edit environment', () => {
    render(card())
    expect(q('[data-environment-section]')!.getAttribute('data-environment-kind')).toBe('mac')
    expect(q('[data-environment-name]')!.textContent).toBe("Liam's MacBook Pro")
    expect(q('[data-environment-online]')!.getAttribute('data-environment-online')).toBe('online')
    act(() => q('[data-environment-edit]')!.click())
    expect(m.dialog).toHaveBeenLastCalledWith(expect.objectContaining({ open: true, environment: expect.objectContaining({ id: 'env-mac' }) }))
  })

  it('a folder: `label · ~/parent`, the path on hover, its mode, its base branch, × on this Mac', () => {
    render(card())
    const website = q('[data-environment-folder="f-1"]')!
    expect(website.textContent).toContain('dial8-website · ~/code/dial8-v2')
    expect(website.getAttribute('title')).toBe('/Users/sam/code/dial8-v2/dial8-website')
    expect(website.querySelector('[data-environment-mode]')!.textContent).toBe('edits')
    expect(website.querySelector('[data-environment-base]')!.textContent).toBe('main')
    expect(q('[data-environment-folder="f-2"] [data-environment-mode]')!.textContent).toBe('read only')
    expect(q('[data-environment-folder="f-9"]')).toBeNull()
    act(() => q('[data-environment-remove="f-1"]')!.click())
    expect(m.remove).toHaveBeenCalledWith('f-1')
  })

  it('no base branch shown when the Mac’s app can’t use one', () => {
    render(card({ environment: mac({ supportsBaseBranch: false }) }))
    expect(q('[data-environment-base]')).toBeNull()
  })

  it('a branch: cut in the middle, "Worktree", a click copies the full name', async () => {
    render(card())
    const wt = q('[data-environment-worktree]')!
    expect(wt.getAttribute('data-environment-worktree')).toBe('dial8/dial8-website-agent-orchestration-fc09cf')
    expect(wt.textContent).toContain('…')
    expect(wt.textContent).toContain('Worktree')
    await act(async () => {
      wt.click()
      await Promise.resolve()
    })
    expect(m.copy).toHaveBeenCalledWith('dial8/dial8-website-agent-orchestration-fc09cf')
    expect(wt.textContent).toContain('Copied')
  })

  it('Add folder… in the desktop app on that Mac; elsewhere it says where; no ×', async () => {
    render(card())
    await act(async () => q('[data-environment-add]')!.click())
    expect(m.add).toHaveBeenCalledTimes(1)
    expect(q('[data-environment-hint]')).toBeNull()

    render(card({ local: local({ canEdit: false, thisDeviceId: null }) }))
    expect(q('[data-environment-add]')).toBeNull()
    expect(q('[data-environment-hint]')!.textContent).toBe("Add folders in Native Intelligence on Liam's MacBook Pro.")
    expect(container.querySelectorAll('[data-environment-remove]')).toHaveLength(0)

    // The desktop app on another Mac: the same.
    render(card({ local: local({ thisDeviceId: 'dev-studio' }) }))
    expect(q('[data-environment-add]')).toBeNull()
  })

  it('cloud: the network level, no folders', () => {
    render(card({ environment: cloud({ networkAccess: 'isolated' }) }))
    expect(q('[data-environment-section]')!.getAttribute('data-environment-kind')).toBe('cloud')
    expect(q('[data-environment-network]')!.textContent).toBe('Isolated networkGitHub only')
    expect(q('[data-environment-online]')).toBeNull()
    expect(q('[data-environment-folder]')).toBeNull()
    expect(q('[data-environment-add]')).toBeNull()
  })
})

describe('useEnvironmentCard', () => {
  let seen: EnvironmentCard | null | undefined
  function Probe({ conversationId }: { conversationId: string | null }) {
    seen = useEnvironmentCard({ open: true, conversationId })
    return null
  }
  const flush = () => act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })

  it('the chat’s environment from one read; none: no card', async () => {
    const f = fakeFetch({ list: [], chat: { environmentId: 'env-cloud', source: 'workspace', environment: cloud() } })
    configureEnvironment({ fetch: f.fn as never, isDesktop: () => false })
    await act(async () => root.render(h(Probe, { conversationId: 'c-1' })))
    await flush()
    expect(seen?.environment.id).toBe('env-cloud')
    expect(seen?.summary).toBe('Default cloud')
    expect(f.calls.filter((c) => c.url.startsWith('/api/account/environments/chat'))).toHaveLength(1)

    resetEnvironmentStore()
    const none = fakeFetch({ list: [] })
    configureEnvironment({ fetch: none.fn as never, isDesktop: () => false })
    await act(async () => root.render(h(Probe, { conversationId: 'c-2' })))
    await flush()
    expect(seen).toBeNull()
  })
})
