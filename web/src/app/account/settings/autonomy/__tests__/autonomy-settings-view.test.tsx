// @vitest-environment jsdom
/**
 * Settings → Autonomy (plan Part 5 row 9). Agents act by default, so there is
 * no mode chooser: the page shows one kill switch (on = 'attempt', off =
 * 'off'), hides the limits while it is off, and writes one change at a time:
 * the switch, a number (validated before it is sent), a teammate's role or
 * autonomy, and "Resume" on a paused role in its own workspace. A non-admin
 * sees it read-only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
vi.mock('thinking-orbs', () => ({ ThinkingOrb: () => null }))

import { AGENT_AUTONOMY_URL, AutonomySettingsView } from '../autonomy-settings-view'

const POLICY = {
  mode: 'attempt',
  chat_can_delegate_to: ['researcher', 'writer', 'correspondent'],
  max_chat_delegations_per_day: 10,
  max_chat_delegations_per_conversation: 3,
  attempt_min_confidence: null,
  max_attempts_per_capture: 1,
  max_attempts_per_day: 10,
  max_attempts_per_root: 3,
  max_delegation_depth: 2,
  max_fan_out: 3,
  role_breaker_window: 3,
  role_breaker_quiet_days: 7,
  role_breaker_resumed_at: {},
}

function loaded(over: Record<string, unknown> = {}) {
  return {
    workspace_id: 'ws-1',
    policy: POLICY as typeof POLICY & { mode: string },
    can_edit: true,
    teammates: [
      { id: 'quill', name: 'Quill', avatar_url: null, role: 'writer', autonomy: 'attempt', allowed_side_effects: ['read', 'internal-write'] },
      { id: 'rory', name: 'Rory', avatar_url: null, role: null, autonomy: 'propose', allowed_side_effects: ['read'] },
    ],
    roles: [
      { role: 'researcher', attemptable: true, default_teammate_id: null, breaker: null, resumed_at: null },
      { role: 'writer', attemptable: true, default_teammate_id: 'quill', breaker: { paused: true, window: 3 }, resumed_at: null },
      { role: 'developer', attemptable: false, default_teammate_id: null, breaker: null, resumed_at: null },
      { role: 'correspondent', attemptable: true, default_teammate_id: null, breaker: null, resumed_at: null },
    ],
    ...over,
  }
}

let container: HTMLDivElement
let root: Root
let state: ReturnType<typeof loaded>
let calls: Array<{ url: string; method: string; body: unknown; headers: unknown }>
let patchResponse: { ok: boolean; body: unknown }

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  state = loaded()
  calls = []
  patchResponse = { ok: true, body: { policy: POLICY, seeded: 0, stopped: null } }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null, headers: init?.headers ?? null })
      if (method === 'GET') return { ok: true, json: async () => state } as Response
      return { ok: patchResponse.ok, json: async () => patchResponse.body } as Response
    }),
  )
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

async function render() {
  await act(async () => root.render(h(AutonomySettingsView)))
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}
const text = () => container.textContent ?? ''
const button = (name: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(name)) as HTMLButtonElement
const writes = () => calls.filter((c) => c.method !== 'GET')
const killSwitch = () => container.querySelector('[role="switch"][aria-label="Agents work on their own"]') as HTMLButtonElement

describe('AutonomySettingsView', () => {
  it('saves the chat role allowlist independently of teammate autonomy', async () => {
    await render()
    const writer = container.querySelector('input[aria-label="Chat can delegate to Writer"]') as HTMLInputElement
    expect(writer.checked).toBe(true)
    await act(async () => writer.click())
    expect(writes()).toEqual([expect.objectContaining({ url: AGENT_AUTONOMY_URL, body: { policy: { chat_can_delegate_to: ['researcher', 'correspondent'] } } })])
    expect(text()).toContain('Helpers per conversation')
  })

  it('no mode chooser and no deployment banner: one switch, on by default, with the limits shown', async () => {
    await render()
    expect(killSwitch().getAttribute('aria-checked')).toBe('true')
    for (const gone of ['Propose', 'Attempt', 'switched off for this deployment', 'Switching to Attempt']) expect(text()).not.toContain(gone)
    expect(text()).toContain('First passes per meeting')
    expect(text()).toContain('Writer · Quill')
    expect(text()).toContain('Makes first passes on its own')
    // A role no one holds says it gets a teammate on first need.
    expect(text()).toContain('One is added the first time this role’s work comes up')
  })

  it('switching off writes mode off, says it is stopping running first passes, and hides the limits', async () => {
    patchResponse = { ok: true, body: { policy: { ...POLICY, mode: 'off' }, seeded: 0, stopped: 'requested' } }
    await render()
    state = loaded({ policy: { ...POLICY, mode: 'off' } })
    await act(async () => killSwitch().click())
    expect(writes()).toEqual([expect.objectContaining({ url: AGENT_AUTONOMY_URL, method: 'PATCH', body: { policy: { mode: 'off' } } })])
    expect(toast).toHaveBeenCalledWith('Stopping the first passes already running')
    expect(killSwitch().getAttribute('aria-checked')).toBe('false')
    expect(text()).toContain('Switched off')
    expect(text()).not.toContain('First passes per meeting')
    expect(container.querySelector('input[aria-label="Chat can delegate to Writer"]')).toBeNull()
  })

  it('switching back on writes mode attempt and says how many teammates it added', async () => {
    state = loaded({ policy: { ...POLICY, mode: 'off' } })
    patchResponse = { ok: true, body: { policy: POLICY, seeded: 3, stopped: null } }
    await render()
    expect(killSwitch().getAttribute('aria-checked')).toBe('false')
    state = loaded()
    await act(async () => killSwitch().click())
    expect(writes()).toEqual([expect.objectContaining({ body: { policy: { mode: 'attempt' } } })])
    expect(toast).toHaveBeenCalledWith('Added 3 role teammates')
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2)
  })

  it('a stored propose (before 354, or a malformed policy) shows off: the gate attempts nothing on it', async () => {
    state = loaded({ policy: { ...POLICY, mode: 'propose' } })
    patchResponse = { ok: true, body: { policy: POLICY, seeded: 0, stopped: null } }
    await render()
    expect(killSwitch().getAttribute('aria-checked')).toBe('false')
    expect(text()).toContain('Switched off')
    state = loaded()
    await act(async () => killSwitch().click())
    expect(writes()).toEqual([expect.objectContaining({ body: { policy: { mode: 'attempt' } } })])
  })

  it('a refused save puts the switch back and says why', async () => {
    state = loaded({ policy: { ...POLICY, mode: 'off' } })
    patchResponse = { ok: false, body: { error: 'Could not create the role teammates, so attempts were not switched on' } }
    await render()
    await act(async () => killSwitch().click())
    expect(killSwitch().getAttribute('aria-checked')).toBe('false')
    expect(toast.error).toHaveBeenCalledWith('Could not create the role teammates, so attempts were not switched on')
  })

  it('no teammates: the Teammates section is not rendered', async () => {
    state = loaded({ teammates: [] })
    await render()
    expect(container.querySelector('section[aria-label="Teammates"]')).toBeNull()
  })

  it('a number is sent on blur only when it is a whole number in range', async () => {
    await render()
    const input = container.querySelector('input[type="number"]') as HTMLInputElement
    const setValue = (v: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      act(() => {
        setter.call(input, v)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    setValue('99')
    await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(writes()).toEqual([])
    expect(toast.error).toHaveBeenCalledWith('Enter a whole number from 0 to 20')
    setValue('2')
    await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(writes()).toEqual([expect.objectContaining({ body: { policy: { max_attempts_per_capture: 2 } } })])
  })

  it('the attempt bar is a percent; empty means the flow’s own bar', async () => {
    await render()
    const input = container.querySelector('input[aria-label="Confidence needed for a first pass"]') as HTMLInputElement
    expect(input.value).toBe('')
    const setValue = (v: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      act(() => {
        setter.call(input, v)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    const blur = () => act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    setValue('150')
    await blur()
    expect(writes()).toEqual([])
    expect(toast.error).toHaveBeenCalledWith('Enter a whole percent from 0 to 100, or leave it empty')
    setValue('60')
    await blur()
    expect(writes()).toEqual([expect.objectContaining({ body: { policy: { attempt_min_confidence: 0.6 } } })])
  })

  it('Resume on a paused role posts the role in this workspace', async () => {
    await render()
    await act(async () => button('Resume Writer').click())
    expect(writes()).toEqual([
      expect.objectContaining({
        url: `${AGENT_AUTONOMY_URL}/resume`,
        method: 'POST',
        body: { role: 'writer', workspace_id: 'ws-1' },
        headers: { 'Content-Type': 'application/json', 'x-workspace-id': 'ws-1' },
      }),
    ])
  })

  it('a teammate’s role and autonomy are saved on its own route', async () => {
    await render()
    const role = container.querySelector('select[aria-label="Rory role"]') as HTMLSelectElement
    await act(async () => {
      role.value = 'researcher'
      role.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const autonomy = container.querySelector('select[aria-label="Quill autonomy"]') as HTMLSelectElement
    await act(async () => {
      autonomy.value = 'propose'
      autonomy.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(writes().map((c) => [c.url, c.body])).toEqual([
      [`${AGENT_AUTONOMY_URL}/teammates/rory`, { role: 'researcher' }],
      [`${AGENT_AUTONOMY_URL}/teammates/quill`, { autonomy: 'propose' }],
    ])
  })

  it('read-only for a non-admin', async () => {
    state = loaded({ can_edit: false })
    await render()
    expect(text()).toContain('Only workspace admins can change this')
    expect(killSwitch().disabled).toBe(true)
    expect(button('Resume Writer').disabled).toBe(true)
    expect((container.querySelector('select') as HTMLSelectElement).disabled).toBe(true)
    expect((container.querySelector('input[aria-label="Chat can delegate to Writer"]') as HTMLInputElement).disabled).toBe(true)
  })
})
