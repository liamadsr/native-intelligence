// @vitest-environment jsdom
/**
 * Settings → Preferences → Assistant → Model (../agent-model-section), against
 * a stubbed /api/account/agent-model:
 *  - it shows the saved pick (Auto when none) and lists Auto and every pick,
 *    each with its line;
 *  - a pick saves at once (PUT) and says it applies from the next reply; a
 *    save the account refuses puts the old pick back and says so;
 *  - on an unpaid plan the premium picks can't be chosen, and a premium pick
 *    saved earlier says the assistant runs Auto for now;
 *  - on the person's ChatGPT plan there is no dropdown: the row names the
 *    plan's model.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { AGENT_MODEL_URL, AgentModelSection } from '../agent-model-section'

let container: HTMLDivElement
let root: Root

const state = { get: { model: 'auto', plan: 'paid', planModel: null } as Record<string, unknown>, putOk: true }
const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
  if (init?.method === 'PUT') {
    const body = JSON.parse(String(init.body)) as { model: string }
    return new Response(JSON.stringify(state.putOk ? { model: body.model } : { error: 'nope' }), { status: state.putOk ? 200 : 500 })
  }
  return new Response(JSON.stringify(state.get), { status: 200 })
})

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
}

async function mount() {
  await act(async () => root.render(h(AgentModelSection)))
  await flush()
}

const trigger = () => container.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')
const options = () => [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
const option = (label: string) => options().find((o) => o.textContent?.startsWith(label))!
const text = () => container.textContent ?? ''

async function click(el: HTMLElement) {
  await act(async () => el.click())
  await flush()
}

beforeEach(() => {
  state.get = { model: 'auto', plan: 'paid', planModel: null }
  state.putOk = true
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('AgentModelSection', () => {
  it('shows the saved pick and lists Auto and every pick', async () => {
    await mount()
    expect(fetchMock).toHaveBeenCalledWith(AGENT_MODEL_URL)
    expect(trigger()!.textContent).toBe('Auto')
    await click(trigger()!)
    expect(options().map((o) => o.querySelector('span span')?.textContent)).toEqual([
      'Auto',
      'Claude Opus 5.5',
      'Claude Sonnet 5.5',
      'GPT-5.6 Terra',
      'GPT-5.6 Luna',
      'DeepSeek V4 Flash',
    ])
    expect(option('Auto').getAttribute('aria-selected')).toBe('true')
    expect(option('Auto').textContent).toContain('Claude Haiku 5.5')
    expect(options().every((o) => !o.disabled)).toBe(true)
  })

  it('saves a pick at once and says when it applies', async () => {
    await mount()
    await click(trigger()!)
    await click(option('GPT-5.6 Luna'))
    expect(fetchMock).toHaveBeenLastCalledWith(AGENT_MODEL_URL, expect.objectContaining({ method: 'PUT', body: JSON.stringify({ model: 'gpt-5.6-luna' }) }))
    expect(trigger()!.textContent).toBe('GPT-5.6 Luna')
    expect(text()).toContain('Saved. Your assistant runs on GPT-5.6 Luna from its next reply.')
    expect(options()).toHaveLength(0)
  })

  it('puts the old pick back when the account refuses it', async () => {
    state.get = { model: 'claude-sonnet-5-5', plan: 'paid', planModel: null }
    state.putOk = false
    await mount()
    expect(trigger()!.textContent).toBe('Claude Sonnet 5.5')
    await click(trigger()!)
    await click(option('Auto'))
    expect(trigger()!.textContent).toBe('Claude Sonnet 5.5')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Couldn’t save the model')
  })

  it('on an unpaid plan, the premium picks can\'t be chosen', async () => {
    state.get = { model: 'auto', plan: 'unpaid', planModel: null }
    await mount()
    await click(trigger()!)
    for (const label of ['Claude Opus 5.5', 'Claude Sonnet 5.5', 'GPT-5.6 Terra']) {
      expect(option(label).disabled, label).toBe(true)
      expect(option(label).textContent, label).toContain('Paid plans')
    }
    for (const label of ['Auto', 'GPT-5.6 Luna', 'DeepSeek V4 Flash']) expect(option(label).disabled, label).toBe(false)
    await click(option('Claude Opus 5.5'))
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
  })

  it('says a premium pick saved earlier runs Auto for now on an unpaid plan', async () => {
    state.get = { model: 'claude-opus-5-5', plan: 'unpaid', planModel: null }
    await mount()
    expect(trigger()!.textContent).toBe('Claude Opus 5.5')
    expect(text()).toContain('Claude Opus 5.5 needs a paid plan, so your assistant runs on Auto for now.')
  })

  it('on the ChatGPT plan, names the plan\'s model and offers no dropdown', async () => {
    state.get = { model: 'gpt-5.6-luna', plan: 'chatgpt', planModel: 'GPT-6.1 Sol' }
    await mount()
    expect(trigger()).toBeNull()
    expect(text()).toContain('Your assistant runs on your ChatGPT plan’s model, GPT-6.1 Sol. You can pick another model on a Dial8 plan.')
  })

  it('says a premium pick needs a paid plan when the plan couldn\'t be read', async () => {
    state.get = { model: 'auto', plan: null, planModel: null }
    await mount()
    await click(trigger()!)
    expect(option('Claude Opus 5.5').disabled).toBe(false)
    await click(option('Claude Opus 5.5'))
    expect(text()).toContain('Saved. Your assistant runs on Claude Opus 5.5 from its next reply, on a paid plan.')
  })

  it('stays put when the setting can\'t be read', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('{}', { status: 500 }))
    await mount()
    expect(trigger()!.disabled).toBe(true)
    expect(trigger()!.textContent).toBe('Unavailable')
  })
})
