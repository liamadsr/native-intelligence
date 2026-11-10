// @vitest-environment jsdom
/**
 * The agent panel's tabs (agent-look-editor.tsx): Look, Phone (as Settings ›
 * Phone shows it), Slack (as its connector page shows it) and People (who can
 * talk to the agent, and how). All but Look save as they go, so they have no
 * footer. The dialog has one fixed height, so it keeps its size. A look
 * being made survives a look at another tab, and openAgentEditor can open
 * straight onto one. The renderer and the routes are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

vi.mock('@/hooks/use-watched', () => ({ useWatched: (active: boolean) => active }))
vi.mock('bot-avatars', async () => {
  const { createElement } = await import('react')
  const { AGENT_LOOK_TYPES } = await import('@/lib/bots/agent-look')
  return {
    botAvatarPresets: Object.fromEntries(AGENT_LOOK_TYPES.map((t) => [t, { label: t[0].toUpperCase() + t.slice(1) }])),
    BotAvatar: (p: Record<string, unknown>) => createElement('canvas', { 'data-stub-bot': p.type, 'data-props': JSON.stringify(p) }),
  }
})

const { AgentLookButton, AgentEditorHost, openAgentEditor, __resetAgentEditorForTests } = await import('../agent-editor')
const { __resetAssistantNameForTests } = await import('@/lib/voice/assistant-name-store')
const { __resetAgentLookForTests } = await import('@/lib/bots/agent-look-store')

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let linkedPhone: { number: string; masked: string; verifiedAt: string; optedOut: boolean } | null = null
let slackLink: { slackUserName: string } | null = null
const fetchMock = vi.fn(async (url: string) => {
  if (url === '/api/account/phone') {
    return new Response(JSON.stringify({ phone: linkedPhone, niNumber: '+1 555 000 0000', available: true }), { status: 200 })
  }
  if (url === '/api/account/integrations/slack') {
    return new Response(
      JSON.stringify({ configured: true, appId: 'A1', canInstall: true, canLink: true, installations: [{ teamId: 'T1', teamName: 'Acme', teamDomain: 'acme', myLink: slackLink }] }),
      { status: 200 },
    )
  }
  return new Response('{}', { status: 404 })
})

let root: Root
let host: HTMLElement
beforeEach(() => {
  window.localStorage.clear()
  __resetAgentLookForTests()
  __resetAgentEditorForTests()
  __resetAssistantNameForTests()
  fetchMock.mockClear()
  linkedPhone = null
  slackLink = null
  vi.stubGlobal('fetch', fetchMock)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const q = <T extends Element = HTMLElement>(sel: string) => document.body.querySelector<T>(sel)
const dialog = () => q('[data-agent-look-editor]')
const tab = (id: string) => q<HTMLButtonElement>(`[data-agent-panel-tab="${id}"]`)!
const click = (el: HTMLElement) => act(async () => el.click())
async function until(ready: () => boolean) {
  for (let i = 0; i < 500 && !ready(); i++) await act(async () => void (await new Promise((r) => setTimeout(r, 10))))
  expect(ready()).toBe(true)
}

async function mount() {
  await act(async () =>
    root.render(
      <>
        <AgentLookButton name="Joseph" state="default" active size={56} />
        <AgentEditorHost />
      </>,
    ),
  )
  await until(() => !!q('[data-agent-look-open] canvas'))
}

describe('the agent panel’s tabs', { timeout: 15_000 }, () => {
  it('Phone, Slack, People and Look, in that order; the bot opens on Look', async () => {
    await mount()
    await click(q<HTMLButtonElement>('[data-agent-look-open]')!)
    await until(() => !!dialog())
    const ids = [...document.body.querySelectorAll('[data-agent-panel-tab]')].map((el) => el.getAttribute('data-agent-panel-tab'))
    expect(ids).toEqual(['phone', 'slack', 'people', 'look'])
    expect(tab('look').getAttribute('aria-selected')).toBe('true')
    // Nothing of the other tabs' is read until one is shown.
    expect(fetchMock).not.toHaveBeenCalledWith('/api/account/phone')
    expect(fetchMock).not.toHaveBeenCalledWith('/api/account/integrations/slack')
  })

  it('Phone and Slack each set up one way in, with no footer', async () => {
    await mount()
    await click(q<HTMLButtonElement>('[data-agent-look-open]')!)
    await until(() => !!dialog())

    await click(tab('phone'))
    await until(() => !!q('[data-sms-consent]'))
    expect(q('[data-communication="phone"]')!.textContent).toContain('Text Joseph')
    expect(q('[data-communication="slack"]')).toBeNull()
    expect(q('[data-look-save]')).toBeNull()

    await click(tab('slack'))
    await until(() => !!q('[data-slack-step="setup"]'))
    expect(q('[data-communication="slack"]')!.textContent).toContain('Message Joseph in Slack')
    expect(q('[data-agent-panel="phone"]')!.hidden).toBe(true)
  })

  it('People: only other people, never you (your phone and Slack are on their own tabs)', async () => {
    linkedPhone = { number: '+1 555 123 4567', masked: '•••4567', verifiedAt: '2026-10-01', optedOut: false }
    slackLink = { slackUserName: 'liam' }
    await mount()
    await act(async () => openAgentEditor(null, 'people'))
    await until(() => !!q('[data-people-others]'))
    expect(q('[data-people-others]')!.textContent).toContain('No one else can talk to Joseph')
    expect(q('[data-people-person]')).toBeNull()
    expect(q('[data-communication="people"]')!.textContent).not.toContain('+1 555 123 4567')
  })

  it('one fixed height for the dialog, every tab filling the rest of it, so it keeps its size', async () => {
    await mount()
    await click(q<HTMLButtonElement>('[data-agent-look-open]')!)
    await until(() => !!dialog())
    expect(dialog()!.className).toContain('h-[560px]')
    for (const id of ['phone', 'slack', 'people', 'look']) {
      await click(tab(id))
      const body = q('[data-agent-panel-body]')!
      expect(body.className).toContain('flex-1')
      // The shown tab fills it and scrolls inside it; the others are hidden in it.
      const panels = [...body.querySelectorAll<HTMLElement>(':scope > [role="tabpanel"]')]
      expect(panels.map((p) => p.getAttribute('data-agent-panel'))).toEqual(['phone', 'slack', 'people', 'look'])
      expect(panels.filter((p) => !p.hidden).map((p) => p.getAttribute('data-agent-panel'))).toEqual([id])
    }
  })

  it('a look being made survives a look at another tab', async () => {
    await mount()
    await click(q<HTMLButtonElement>('[data-agent-look-open]')!)
    await until(() => !!dialog())
    await click(q<HTMLButtonElement>('[data-look-tile="Cat"]')!)
    await click(tab('phone'))
    await click(tab('look'))
    expect(q('[data-look-tile="Cat"]')!.getAttribute('aria-checked')).toBe('true')
    expect(q<HTMLButtonElement>('[data-look-save]')!.disabled).toBe(false)
  })

  it('arrow keys move between the tabs, round', async () => {
    await mount()
    await click(q<HTMLButtonElement>('[data-agent-look-open]')!)
    await until(() => !!dialog())
    tab('look').focus()
    await act(async () => void tab('look').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    expect(tab('phone').getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tab('phone'))
    tab('phone').focus()
    await act(async () => void tab('phone').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })))
    await act(async () => void tab('look').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })))
    expect(tab('people').getAttribute('aria-selected')).toBe('true')
  })

  it('openAgentEditor can open straight onto a tab, and its close closes it', async () => {
    await mount()
    await act(async () => openAgentEditor(null, 'slack'))
    await until(() => !!q('[data-communication="slack"]'))
    expect(tab('slack').getAttribute('aria-selected')).toBe('true')
    const close = [...dialog()!.querySelectorAll('button')].find((b) => b.textContent === 'Close')!
    await click(close)
    await until(() => !dialog())
  })
})
