// @vitest-environment jsdom
/**
 * "with …" beside an action's Start (start-agent-with.tsx, migration 658):
 * who does the card's work on the person's "Run my work here" Mac.
 *
 *   - no project, no "Run my work here", or a Mac that offers no agent (or
 *     whose offer isn't known): nothing renders, and the Start sends none;
 *   - a Mac that offers agents (as it last told the server, or live on it):
 *     Native Intelligence plus them, defaulting to the Mac's saved choice
 *     when it still offers it, else Native Intelligence; a pick is the
 *     Start's choice (never stored on the action).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }))
vi.mock('@/lib/local-agent/relay-core', () => ({ refreshLocalAgentDevice: vi.fn(async () => null) }))

import { StartAgentWith, startWorkerOptions } from '../start-agent-with'
import { configureEnvironment, resetEnvironmentStore } from '@/lib/local-agent/environment-client'
import { cloud, fakeFetch, json, mac } from './fixtures'

const ACTION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const START_URL = `/api/account/actions/${ACTION}/start-agent`
const OFFERS = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
]
const STUDIO = (over: Parameters<typeof mac>[0] = {}) => mac({ name: 'Studio Mac', deviceName: 'Studio Mac', ...over })

let container: HTMLDivElement
let root: Root
let chosen: Array<string | null | undefined> = []
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null
const flush = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })

let setOutside: ((v: string | null | undefined) => void) | null = null
function Host({ actionId }: { actionId: string | null }) {
  const [value, setValue] = useState<string | null | undefined>(undefined)
  setOutside = setValue
  chosen.push(value)
  return h(StartAgentWith, { actionId, enabled: true, value, onChange: setValue })
}

/**
 * The page as a browser tab sees it: the Mac's offer comes from the server's
 * mirror. `onMac`: what GET …/start-agent says (the route's own rule: a Mac
 * coding Start), or null.
 */
async function mount(actionId: string | null, onMac: string | null, envs: unknown[]) {
  const f = fakeFetch({ list: envs }, [
    { url: START_URL, reply: () => json({ onMac: onMac ? { environmentId: onMac } : null }) },
  ])
  vi.stubGlobal('fetch', f.fn)
  configureEnvironment({ fetch: f.fn as never, isDesktop: () => false })
  await act(async () => root.render(h(Host, { actionId })))
  await flush()
  return f
}

beforeEach(() => {
  resetEnvironmentStore()
  chosen = []
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

describe('startWorkerOptions', () => {
  it('nothing to choose without a Mac, or with no saved choice and nothing offered', () => {
    expect(startWorkerOptions(null, null)).toBeNull()
    expect(startWorkerOptions(STUDIO(), null)).toBeNull()
    expect(startWorkerOptions(STUDIO({ offeredWorkers: [] }), null)).toBeNull()
  })

  it('a saved choice with no offer known: Native Intelligence to pick, the saved one shown unavailable', () => {
    const o = startWorkerOptions(STUDIO({ worker: 'codex' }), null)!
    expect(o.options).toEqual([{ id: null, label: 'Native Intelligence' }])
    expect(o.unavailable).toEqual({ id: 'codex', label: 'Codex' })
    expect(o.initial).toBeNull()
  })

  it('on that Mac its live list wins; the saved choice is the default only while offered', () => {
    const live = startWorkerOptions(STUDIO({ offeredWorkers: OFFERS, worker: 'codex' }), { deviceId: 'dev-this', workers: [OFFERS[0]] })!
    expect(live.options.map((o) => o.id)).toEqual([null, 'claude-code'])
    expect(live.initial).toBeNull()
    expect(startWorkerOptions(STUDIO({ offeredWorkers: OFFERS, worker: 'codex' }), null)!.initial).toBe('codex')
  })
})

describe('the Start’s “with” choice', () => {
  it('no action: nothing renders and nothing is read', async () => {
    const f = await mount(null, null, [])
    expect(container.innerHTML).toBe('')
    expect(f.calls).toEqual([])
    expect(chosen.at(-1)).toBeUndefined()
  })

  it('a Start that doesn’t run on my Mac as a coding job (a non-developer agent, no repo, no “Run my work here”): nothing renders, no choice is sent', async () => {
    await mount(ACTION, null, [STUDIO({ offeredWorkers: OFFERS, worker: 'claude-code' })])
    expect(container.innerHTML).toBe('')
    expect(chosen.at(-1)).toBeUndefined()
  })

  it('a Mac that offers no agent: nothing renders, and the Start sends no choice', async () => {
    await mount(ACTION, 'env-mac', [STUDIO({ offeredWorkers: [] }), cloud()])
    expect(container.innerHTML).toBe('')
    expect(chosen.at(-1)).toBeUndefined()
  })

  it('a Mac that offers agents: “with” its saved choice; a pick changes the Start’s choice', async () => {
    const f = await mount(ACTION, 'env-mac', [STUDIO({ offeredWorkers: OFFERS, worker: 'codex' }), cloud()])
    expect(f.calls[0].url).toBe(START_URL)
    const trigger = q('[data-start-agent-with]')!
    expect(trigger.textContent).toBe('with Codex')
    expect(chosen.at(-1)).toBe('codex')
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }))
    })
    await flush()
    expect([...document.querySelectorAll('[data-start-agent-with-option]')].map((el) => el.getAttribute('data-start-agent-with-option'))).toEqual([
      'native',
      'claude-code',
      'codex',
    ])
    expect(q('[data-start-agent-with-menu]')!.textContent).toContain('Work on Studio Mac is done by')
    await act(async () => q('[data-start-agent-with-option="native"]')!.click())
    await flush()
    expect(chosen.at(-1)).toBeNull()
    expect(q('[data-start-agent-with]')!.textContent).toBe('with Native Intelligence')
    // Nothing is written anywhere: the choice rides on the Start.
    expect(f.calls.filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('a pick the Mac no longer offers goes back to the default: the label and what Start sends agree', async () => {
    await mount(ACTION, 'env-mac', [STUDIO({ offeredWorkers: OFFERS }), cloud()])
    expect(chosen.at(-1)).toBeNull()
    // The person had picked an agent that is gone from the offer.
    await act(async () => setOutside!('gemini-cli'))
    await flush()
    expect(chosen.at(-1)).toBeNull()
    expect(q('[data-start-agent-with]')!.textContent).toBe('with Native Intelligence')
  })
})
