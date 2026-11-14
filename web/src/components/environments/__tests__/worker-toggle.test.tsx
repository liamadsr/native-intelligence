// @vitest-environment jsdom
/**
 * The composer's worker toggle (worker-toggle.tsx over composer-state.ts
 * useComposerEnvironment, migration 658): which intelligence does the work on
 * the chat's Mac, apart from where it runs (the environment chip).
 *
 *   - in the desktop app on the chat's Mac, offering agents: a radio group,
 *     "Native Intelligence" first, then each agent by its label, with plain
 *     tooltips; a pick saves through setMacWorker (PATCH the Mac) and shows
 *     at once; the arrow keys move between segments;
 *   - a saved agent the Mac no longer offers: a segment, selected, muted;
 *   - nothing offered, a Cloud environment, or nothing saved off the Mac:
 *     nothing renders;
 *   - off the Mac with a saved agent: a muted chip, nothing to press.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: toastError, success: vi.fn() }) }))
vi.mock('@/lib/local-agent/relay-core', () => ({ refreshLocalAgentDevice: vi.fn(async () => null) }))

import { WorkerToggle } from '../worker-toggle'
import { useComposerEnvironment } from '@/app/account/(dashboard)/chat/composer-state'
import { configureEnvironment, resetEnvironmentStore } from '@/lib/local-agent/environment-client'
import type { LocalAgentStatus } from '@/lib/tauri-bridge'
import { THIS_MAC, cloud, fakeFetch, json, mac } from './fixtures'

function Host() {
  const env = useComposerEnvironment({ enabled: true, conversationId: 'c-1' })
  return h(WorkerToggle, { chat: env.chat, list: env.list, thisMac: env.thisMac, onPickWorker: env.pickWorker })
}

let container: HTMLDivElement
let root: Root
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null
const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })

const STUDIO = (over: Parameters<typeof mac>[0] = {}) => mac({ name: 'Studio Mac', deviceName: 'Studio Mac', ...over })
const CLAUDE = { id: 'claude-code', label: 'Claude Code' }
const CODEX = { id: 'codex', label: 'Codex' }

const status = (workers: LocalAgentStatus['workers']): LocalAgentStatus => ({
  available: true,
  reason: null,
  node: null,
  agentDir: null,
  built: true,
  grants: [],
  jobs: [],
  ...(workers === undefined ? {} : { workers }),
})

const chatOn = (env: ReturnType<typeof mac> | ReturnType<typeof cloud>, routes: Parameters<typeof fakeFetch>[1] = []) =>
  fakeFetch({ list: [STUDIO(), cloud()], chat: { environmentId: env.id, source: 'chat', environment: env } }, routes)

/** The page inside the desktop app on THIS_MAC, offering `workers`. */
async function mountOnMac(workers: LocalAgentStatus['workers'], f: ReturnType<typeof fakeFetch>) {
  configureEnvironment({
    fetch: f.fn as never,
    isDesktop: () => true,
    status: async () => status(workers),
    device: async () => ({ ok: true as const, value: { deviceId: THIS_MAC, name: 'Studio Mac', platform: 'macos', appVersion: '0.3.1' } }),
  })
  await act(async () => root.render(h(Host)))
  await flush()
}

/** A browser tab or a phone. */
async function mountOffMac(f: ReturnType<typeof fakeFetch>) {
  configureEnvironment({ fetch: f.fn as never, isDesktop: () => false })
  await act(async () => root.render(h(Host)))
  await flush()
}

const segments = () => [...document.querySelectorAll('[data-worker-segment]')] as HTMLElement[]
const seg = (id: string) => q(`[data-worker-segment="${id}"]`)!

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

describe('the worker toggle', () => {
  it('two agents: a labelled radio group, Native Intelligence first and checked, each segment with its tooltip', async () => {
    await mountOnMac([CLAUDE, CODEX], chatOn(STUDIO()))
    const group = q('[data-worker-toggle]')!
    expect(group.getAttribute('role')).toBe('radiogroup')
    expect(group.getAttribute('aria-label')).toBe('Who does the work on this Mac')
    expect(segments().map((el) => [el.getAttribute('data-worker-segment'), el.querySelector('.truncate')!.textContent, el.getAttribute('role')])).toEqual([
      ['native', 'Native Intelligence', 'radio'],
      ['claude-code', 'Claude Code', 'radio'],
      ['codex', 'Codex', 'radio'],
    ])
    expect(seg('native').getAttribute('aria-checked')).toBe('true')
    expect(seg('claude-code').getAttribute('aria-checked')).toBe('false')
    expect(seg('native').title).toBe('Work on this Mac is done by Native Intelligence.')
    expect(seg('claude-code').title).toBe('Work on this Mac is done by Claude Code, on your own Claude Code account.')
    expect(q('[data-worker-readonly]')).toBeNull()
  })

  it('narrow rows tighten the padding first; only the longest label may give way, the others keep their full text', async () => {
    await mountOnMac([CLAUDE, CODEX], chatOn(STUDIO()))
    for (const el of segments()) expect(el.className).toContain('@max-[20rem]/underrow:px-1')
    expect(seg('native').className).toContain('min-w-0 shrink')
    expect(seg('claude-code').className).toContain('shrink-0')
    expect(seg('codex').className).toContain('shrink-0')
    expect(q('[data-worker-toggle]')!.className).not.toContain('overflow-x-auto')
  })

  it('one agent: two segments', async () => {
    await mountOnMac([CLAUDE], chatOn(STUDIO()))
    expect(segments().map((el) => el.querySelector('.truncate')!.textContent)).toEqual(['Native Intelligence', 'Claude Code'])
  })

  it('a pick saves through the same path (PATCH the Mac) and shows at once; back to ours PATCHes null', async () => {
    const f = chatOn(STUDIO(), [{ method: 'PATCH', url: '/api/account/environments/env-mac', reply: (body) => json({ environment: STUDIO(body as { worker: string | null }) }) }])
    await mountOnMac([CLAUDE, CODEX], f)
    await act(async () => seg('codex').click())
    await flush()
    expect(f.calls.at(-1)).toEqual({ method: 'PATCH', url: '/api/account/environments/env-mac', body: { worker: 'codex' } })
    expect(seg('codex').getAttribute('aria-checked')).toBe('true')
    expect(seg('native').getAttribute('aria-checked')).toBe('false')
    // Pressing the selected one again changes nothing.
    await act(async () => seg('codex').click())
    await flush()
    expect(f.calls.filter((c) => c.method === 'PATCH')).toHaveLength(1)
    await act(async () => seg('native').click())
    await flush()
    expect(f.calls.at(-1)).toEqual({ method: 'PATCH', url: '/api/account/environments/env-mac', body: { worker: null } })
  })

  it('a refused pick goes back, with the server’s sentence', async () => {
    const f = chatOn(STUDIO(), [{ method: 'PATCH', url: '/api/account/environments/env-mac', reply: () => json({ error: 'Environment not found', code: 'NOT_FOUND' }, 404) }])
    await mountOnMac([CLAUDE], f)
    await act(async () => seg('claude-code').click())
    await flush()
    expect(seg('native').getAttribute('aria-checked')).toBe('true')
    expect(toastError).toHaveBeenCalledWith('Couldn’t change who does the work', { description: 'Environment not found' })
  })

  it('the arrow keys move between segments', async () => {
    await mountOnMac([CLAUDE, CODEX], chatOn(STUDIO()))
    await act(async () => seg('native').focus())
    const key = (k: string) =>
      act(async () => {
        document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
        // Radix moves the focus on a timeout.
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    await key('ArrowRight')
    expect(document.activeElement?.getAttribute('data-worker-segment')).toBe('claude-code')
    await key('ArrowRight')
    expect(document.activeElement?.getAttribute('data-worker-segment')).toBe('codex')
    await key('ArrowLeft')
    expect(document.activeElement?.getAttribute('data-worker-segment')).toBe('claude-code')
  })

  it('a saved agent the Mac no longer offers: kept as a segment, selected but muted, saying where to switch it on; another pick works', async () => {
    const f = chatOn(STUDIO({ worker: 'codex' }), [{ method: 'PATCH', url: '/api/account/environments/env-mac', reply: (body) => json({ environment: STUDIO(body as { worker: string | null }) }) }])
    await mountOnMac([CLAUDE], f)
    expect(segments().map((el) => el.getAttribute('data-worker-segment'))).toEqual(['native', 'claude-code', 'codex'])
    const saved = seg('codex')
    expect(saved.hasAttribute('data-worker-unavailable')).toBe(true)
    expect(saved.getAttribute('aria-checked')).toBe('true')
    expect(saved.className).toContain('border-dashed')
    expect(saved.className).not.toMatch(/(^| )opacity-/)
    expect(saved.title).toBe('This Mac doesn’t offer Codex right now. Switch one on in the Mac app’s menu: Local Agents → Coding Agents.')
    await act(async () => seg('claude-code').click())
    await flush()
    expect(f.calls.at(-1)).toEqual({ method: 'PATCH', url: '/api/account/environments/env-mac', body: { worker: 'claude-code' } })
  })

  it('a Mac offering no agents, with nothing saved: nothing renders', async () => {
    await mountOnMac([], chatOn(STUDIO()))
    expect(container.innerHTML).toBe('')
  })

  it('the Cloud environment selected: nothing renders, whatever this Mac offers', async () => {
    await mountOnMac([CLAUDE], chatOn(cloud()))
    expect(container.innerHTML).toBe('')
  })

  it('a desktop app too old to list agents, nothing saved: nothing renders', async () => {
    await mountOnMac(undefined, chatOn(STUDIO()))
    expect(container.innerHTML).toBe('')
  })

  it('off the Mac with a saved agent and no mirror (an older app): the way back to Native Intelligence is still there', async () => {
    const f = chatOn(STUDIO({ worker: 'claude-code' }), [
      { method: 'PATCH', url: '/api/account/environments/env-mac', reply: (body) => json({ environment: STUDIO(body as { worker: string | null }) }) },
    ])
    await mountOffMac(f)
    expect(q('[data-worker-readonly]')).toBeNull()
    expect(segments().map((el) => el.getAttribute('data-worker-segment'))).toEqual(['native', 'claude-code'])
    expect(seg('claude-code').hasAttribute('data-worker-unavailable')).toBe(true)
    expect(seg('claude-code').getAttribute('aria-checked')).toBe('true')
    await act(async () => seg('native').click())
    await flush()
    expect(f.calls.at(-1)).toEqual({ method: 'PATCH', url: '/api/account/environments/env-mac', body: { worker: null } })
  })

  it('a page with no way to save (no picker) and a saved agent: a muted chip, nothing to press', async () => {
    const saved = STUDIO({ worker: 'claude-code' })
    act(() => root.render(h(WorkerToggle, { chat: { loaded: true, environmentId: saved.id, source: 'chat', environment: saved }, list: { loaded: false, environments: [], defaultEnvironmentId: null } })))
    const chip = q('[data-worker-readonly]')!
    expect(chip.textContent).toBe('Claude Code')
    expect(chip.title).toBe('Change it in the Native Intelligence app on Studio Mac.')
    expect(container.querySelector('button')).toBeNull()
  })

  it('agent segments say “your own account” to a screen reader, as the “with” control and the tooltip do', async () => {
    await mountOnMac([CLAUDE], chatOn(STUDIO()))
    expect(seg('claude-code').textContent).toBe('Claude Code (your own account)')
    expect(seg('claude-code').querySelector('.sr-only')!.textContent).toBe(' (your own account)')
    expect(seg('native').textContent).toBe('Native Intelligence')
  })

  it('off the Mac with the Mac’s mirrored offer (its heartbeat): the toggle, tooltips naming the Mac, the same save path', async () => {
    const offered = STUDIO({ offeredWorkers: [CLAUDE, CODEX], worker: 'codex' })
    const f = fakeFetch({ list: [offered, cloud()], chat: { environmentId: 'env-mac', source: 'chat', environment: offered } }, [
      { method: 'PATCH', url: '/api/account/environments/env-mac', reply: (body) => json({ environment: STUDIO({ offeredWorkers: [CLAUDE, CODEX], ...(body as { worker: string | null }) }) }) },
    ])
    await mountOffMac(f)
    expect(q('[data-worker-readonly]')).toBeNull()
    expect(segments().map((el) => el.getAttribute('data-worker-segment'))).toEqual(['native', 'claude-code', 'codex'])
    expect(seg('codex').getAttribute('aria-checked')).toBe('true')
    expect(seg('claude-code').title).toBe('Work on Studio Mac is done by Claude Code, on your own Claude Code account.')
    await act(async () => seg('claude-code').click())
    await flush()
    expect(f.calls.at(-1)).toEqual({ method: 'PATCH', url: '/api/account/environments/env-mac', body: { worker: 'claude-code' } })
    expect(seg('claude-code').getAttribute('aria-checked')).toBe('true')
  })

  it('off the Mac: a saved agent its mirrored offer no longer lists shows as unavailable; an empty offer and nothing saved shows nothing', async () => {
    const stale = STUDIO({ offeredWorkers: [CLAUDE], worker: 'codex' })
    await mountOffMac(fakeFetch({ list: [stale], chat: { environmentId: 'env-mac', source: 'chat', environment: stale } }))
    expect(seg('codex').hasAttribute('data-worker-unavailable')).toBe(true)
    expect(seg('codex').title).toBe('Studio Mac doesn’t offer Codex right now. Switch one on in the Mac app’s menu: Local Agents → Coding Agents.')
    act(() => root.unmount())
    root = createRoot(container)
    resetEnvironmentStore()
    const none = STUDIO({ offeredWorkers: [] })
    await mountOffMac(fakeFetch({ list: [none], chat: { environmentId: 'env-mac', source: 'chat', environment: none } }))
    expect(container.innerHTML).toBe('')
  })

  it('off the Mac with nothing saved: nothing renders', async () => {
    await mountOffMac(chatOn(STUDIO()))
    expect(container.innerHTML).toBe('')
  })

  it('the app on another Mac: the chat’s Mac’s saved agent, unavailable (not known there), with Native Intelligence to go back to', async () => {
    const office = mac({ id: 'env-office', name: 'Office Mac', deviceName: 'Office Mac', deviceId: 'dev-office', worker: 'codex' })
    await mountOnMac([CLAUDE], fakeFetch({ list: [STUDIO(), office], chat: { environmentId: 'env-office', source: 'chat', environment: office } }))
    expect(segments().map((el) => el.getAttribute('data-worker-segment'))).toEqual(['native', 'codex'])
    expect(seg('codex').hasAttribute('data-worker-unavailable')).toBe(true)
    expect(seg('codex').title).toBe('Office Mac doesn’t offer Codex right now. Switch one on in the Mac app’s menu: Local Agents → Coding Agents.')
  })
})
