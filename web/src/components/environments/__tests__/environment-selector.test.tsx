// @vitest-environment jsdom
/**
 * The composer's environment selector (environment-selector.tsx over
 * composer-state.ts useComposerEnvironment, docs/plans/environments.md §6):
 *
 *   - not rendered when you have neither a Mac nor a cloud environment;
 *   - closed, the chat's environment: its kind's mark and its name, from one
 *     read of the chat; the list is read only when the menu opens;
 *   - the menu: your Macs first (online dot), then cloud, then New cloud
 *     environment…;
 *   - a pick is PUT for the chat (a chat with no id yet: your default); a
 *     refused one goes back, and the toast says the server's sentence;
 *   - it is a menu of radio items (the repo's Radix dropdown): the keyboard
 *     moves through it and Enter picks.
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

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: toastError, success: vi.fn() }) }))
vi.mock('@/lib/local-agent/relay-core', () => ({ refreshLocalAgentDevice: vi.fn(async () => null) }))

import { EnvironmentSelector } from '../environment-selector'
import { useComposerEnvironment } from '@/app/account/(dashboard)/chat/composer-state'
import { configureEnvironment, resetEnvironmentStore } from '@/lib/local-agent/environment-client'
import { cloud, fakeFetch, json, mac } from './fixtures'

function Host({ conversationId }: { conversationId: string | null }) {
  const env = useComposerEnvironment({ enabled: true, conversationId })
  return env.visible ? h(EnvironmentSelector, { chat: env.chat, list: env.list, onOpenMenu: env.openMenu, onPick: env.pick }) : null
}

let container: HTMLDivElement
let root: Root
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null
const flush = () => act(async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
})
/** Open the menu as a press does (Radix opens on pointerdown). */
const openMenu = async () => {
  await act(async () => {
    q('[data-environment-selector]')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }))
  })
  await flush()
}
/** A key on `el`, then Radix's deferred focus move (it focuses on a timeout). */
const key = (el: Element, k: string) => act(async () => {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  await new Promise((resolve) => setTimeout(resolve, 0))
})

async function mount(conversationId: string | null, fetcher: ReturnType<typeof fakeFetch>) {
  configureEnvironment({ fetch: fetcher.fn as never, isDesktop: () => false })
  await act(async () => root.render(h(Host, { conversationId })))
  await flush()
}

beforeEach(() => {
  resetEnvironmentStore()
  toastError.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  configureEnvironment(null)
})

describe('the environment selector', () => {
  it('is not rendered when you have neither a Mac nor a cloud environment', async () => {
    const f = fakeFetch({ list: [] })
    await mount('c-1', f)
    expect(q('[data-environment-selector]')).toBeNull()
    // The chat has none, so the list is read once to know.
    expect(f.calls.map((c) => c.url)).toEqual(['/api/account/environments/chat?conversationId=c-1', '/api/account/environments'])
  })

  it('shows when the chat has none but you have one, as "No environment"', async () => {
    const f = fakeFetch({ list: [cloud({ isWorkspaceDefault: false })] })
    await mount('c-1', f)
    expect(q('[data-environment-selector]')!.getAttribute('data-environment-selector')).toBe('none')
    expect(q('[data-environment-selector-name]')!.textContent).toBe('No environment')
  })

  it("closed: the chat's environment from one read; the list only when the menu opens", async () => {
    const f = fakeFetch({ list: [mac(), mac({ id: 'env-studio', name: 'Studio', online: false }), cloud()], chat: { environmentId: 'env-mac', source: 'mac', environment: mac() } })
    await mount('c-1', f)
    expect(q('[data-environment-selector]')!.getAttribute('data-environment-selector')).toBe('mac')
    expect(q('[data-environment-selector-name]')!.textContent).toBe("Liam's MacBook Pro")
    expect(f.calls.map((c) => c.url)).toEqual(['/api/account/environments/chat?conversationId=c-1'])

    await openMenu()
    expect(f.calls.map((c) => c.url)).toEqual(['/api/account/environments/chat?conversationId=c-1', '/api/account/environments'])
    const menu = q('[data-environment-menu]')!
    const rows = [...menu.querySelectorAll('[data-environment-option]')].map((el) => el.getAttribute('data-environment-option'))
    expect(rows).toEqual(['env-mac', 'env-studio', 'env-cloud'])
    expect(menu.textContent).toContain('Your Macs')
    expect(menu.querySelector('[data-environment-option="env-studio"] [data-environment-online-dot]')!.getAttribute('data-environment-online-dot')).toBe('offline')
    expect(menu.querySelector('[data-environment-option="env-mac"]')!.getAttribute('aria-checked')).toBe('true')
    expect(menu.querySelector('[data-environment-new-cloud]')!.textContent).toContain('New cloud environment…')
  })

  it('a pick is PUT for the chat, and shown at once', async () => {
    const f = fakeFetch(
      { list: [mac(), cloud()], chat: { environmentId: 'env-mac', source: 'mac', environment: mac() } },
      [{ method: 'PUT', url: '/api/account/environments/chat', reply: (body) => json({ environmentId: (body as { environmentId: string }).environmentId }) }],
    )
    await mount('c-1', f)
    await openMenu()
    await act(async () => q('[data-environment-option="env-cloud"]')!.click())
    await flush()
    expect(f.calls.at(-1)).toEqual({ method: 'PUT', url: '/api/account/environments/chat', body: { conversationId: 'c-1', environmentId: 'env-cloud' } })
    expect(q('[data-environment-selector]')!.getAttribute('data-environment-selector')).toBe('cloud')
    expect(q('[data-environment-selector-name]')!.textContent).toBe('Default cloud')
    expect(q('[data-environment-menu]')).toBeNull()
  })

  it('a chat with no id yet: where a new chat starts, and a pick PUTs without an id', async () => {
    const f = fakeFetch(
      { list: [mac(), cloud()], chat: { environmentId: 'env-mac', source: 'mac', environment: mac() } },
      [{ method: 'PUT', url: '/api/account/environments/chat', reply: (body) => json(body) }],
    )
    await mount(null, f)
    expect(f.calls[0].url).toBe('/api/account/environments/chat')
    expect(q('[data-environment-selector-name]')!.textContent).toBe("Liam's MacBook Pro")
    await openMenu()
    await act(async () => q('[data-environment-option="env-cloud"]')!.click())
    await flush()
    expect(f.calls.at(-1)).toEqual({ method: 'PUT', url: '/api/account/environments/chat', body: { environmentId: 'env-cloud' } })
    expect(q('[data-environment-selector-name]')!.textContent).toBe('Default cloud')
  })

  it('a refused pick goes back, and the toast says the server’s sentence', async () => {
    const sentence = 'You can’t use this environment here'
    const f = fakeFetch(
      { list: [mac(), cloud()], chat: { environmentId: 'env-mac', source: 'mac', environment: mac() } },
      [{ method: 'PUT', url: '/api/account/environments/chat', reply: () => json({ error: sentence, code: 'BAD_REQUEST' }, 400) }],
    )
    await mount('c-1', f)
    await openMenu()
    await act(async () => q('[data-environment-option="env-cloud"]')!.click())
    await flush()
    expect(f.calls.at(-1)).toMatchObject({ method: 'PUT', url: '/api/account/environments/chat' })
    expect(q('[data-environment-selector-name]')!.textContent).toBe("Liam's MacBook Pro")
    expect(toastError).toHaveBeenCalledWith("Couldn't switch the environment", { description: sentence })
  })

  it('a menu of radio items: the keyboard moves through it, Enter picks', async () => {
    const f = fakeFetch(
      { list: [mac(), mac({ id: 'env-studio', name: 'Studio', online: false }), cloud()], chat: { environmentId: 'env-mac', source: 'mac', environment: mac() } },
      [{ method: 'PUT', url: '/api/account/environments/chat', reply: (body) => json(body) }],
    )
    await mount('c-1', f)
    await openMenu()
    const menu = q('[data-environment-menu]')!
    expect(menu.getAttribute('role')).toBe('menu')
    const items = [...menu.querySelectorAll('[data-environment-option]')]
    expect(items.map((el) => [el.getAttribute('role'), el.getAttribute('aria-checked')])).toEqual([
      ['menuitemradio', 'true'],
      ['menuitemradio', 'false'],
      ['menuitemradio', 'false'],
    ])
    await key(menu, 'Home')
    expect(document.activeElement?.getAttribute('data-environment-option')).toBe('env-mac')
    await key(document.activeElement!, 'ArrowDown')
    expect(document.activeElement?.getAttribute('data-environment-option')).toBe('env-studio')
    await key(document.activeElement!, 'End')
    expect(document.activeElement?.hasAttribute('data-environment-new-cloud')).toBe(true)
    await key(document.activeElement!, 'ArrowUp')
    expect(document.activeElement?.getAttribute('data-environment-option')).toBe('env-cloud')
    await key(document.activeElement!, 'Enter')
    await flush()
    expect(f.calls.at(-1)).toEqual({ method: 'PUT', url: '/api/account/environments/chat', body: { conversationId: 'c-1', environmentId: 'env-cloud' } })
    expect(q('[data-environment-menu]')).toBeNull()
  })

  it('New cloud environment… opens Edit environment for a new one', async () => {
    const f = fakeFetch({ list: [mac()], chat: { environmentId: 'env-mac', source: 'mac', environment: mac() } })
    await mount('c-1', f)
    await openMenu()
    await act(async () => q('[data-environment-new-cloud]')!.click())
    await flush()
    expect(q('[data-edit-environment]')!.getAttribute('data-edit-environment')).toBe('new')
    expect(q('[data-edit-environment]')!.textContent).toContain('New cloud environment')
  })
})
