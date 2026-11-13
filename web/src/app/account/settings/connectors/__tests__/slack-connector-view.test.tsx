// @vitest-environment jsdom
/**
 * Slack's page under Settings › Connectors (slack-connector-view.tsx):
 *
 *   • back from Slack's install it says how it ended, in plain words, and
 *     takes the result off the address (no code is made by itself);
 *   • Add to Slack asks for the install with this page to come back to;
 *   • linked in one Slack workspace, linking another sends the person to
 *     that workspace, and the code step ends when that link lands;
 *   • a failed first read says so and can be tried again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../settings-shell', () => ({ useSettingsNavigate: () => vi.fn() }))
vi.mock('../../../(dashboard)/side-panels/connections-section', () => ({ RowIcon: () => null }))

const { SlackConnectorView } = await import('../slack-connector-view')

type Team = { teamId: string; teamName: string; teamDomain: string; myLink: { slackUserName: string } | null }
const net = {
  state: null as Record<string, unknown> | null,
  getStatus: 200,
  codeStatus: 200,
  installStatus: 200,
  calls: [] as string[],
  bodies: [] as string[],
}
const slack = (installations: Team[], over: Record<string, unknown> = {}) => ({
  configured: true,
  appId: 'A0C9N6VPYLF',
  canInstall: true,
  canLink: true,
  installations,
  ...over,
})
const acme: Team = { teamId: 'T1', teamName: 'Acme', teamDomain: 'acme', myLink: { slackUserName: 'liam' } }
const beta: Team = { teamId: 'T2', teamName: 'Beta', teamDomain: 'beta', myLink: null }

let container: HTMLDivElement
let root: Root
const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => {})
}
async function render() {
  act(() => root.render(h(SlackConnectorView)))
  await flush()
}
const button = (name: string) =>
  [...container.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === name) as HTMLButtonElement | undefined
const codePosts = () => net.calls.filter((c) => c === 'POST /api/account/integrations/slack/link-code').length

beforeEach(() => {
  net.state = null
  net.getStatus = 200
  net.codeStatus = 200
  net.installStatus = 200
  net.calls = []
  net.bodies = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET'
      net.calls.push(`${method} ${url}`)
      if (init?.body) net.bodies.push(init.body)
      if (url === '/api/account/integrations/slack/install') {
        return new Response(JSON.stringify(net.installStatus === 200 ? { url: 'https://slack.com/oauth/v2/authorize?x=1' } : { error: 'nope' }), { status: net.installStatus })
      }
      if (url === '/api/account/integrations/slack/link-code') {
        return new Response(JSON.stringify({ code: 'K7Q4M2', expiresAt: '2026-10-22T19:00:00Z' }), { status: net.codeStatus })
      }
      return new Response(JSON.stringify(net.state), { status: net.getStatus })
    }),
  )
  window.history.replaceState({}, '', '/account/settings/connectors/slack')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('back from Slack’s install', () => {
  it('says it is connected, takes the result off the address, and makes no code by itself', async () => {
    window.history.replaceState({}, '', '/account/settings/connectors/slack?slack=installed')
    net.state = slack([acme])
    await render()
    expect(container.textContent).toContain('Slack is connected')
    expect(window.location.search).toBe('')
    expect(codePosts()).toBe(0)
  })

  it('says plainly why it did not connect', async () => {
    window.history.replaceState({}, '', '/account/settings/connectors/slack?slack=other_workspace&tab=x')
    net.state = slack([])
    await render()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('already connected to a different Native Intelligence workspace')
    expect(window.location.search).toBe('?tab=x')
  })

  it('leaves an address it does not know alone', async () => {
    window.history.replaceState({}, '', '/account/settings/connectors/slack?slack=<b>hi</b>')
    net.state = slack([])
    await render()
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.textContent).not.toContain('<b>hi</b>')
  })
})

describe('Add to Slack', () => {
  it('asks for the install, to come back to this page; a failure says so', async () => {
    net.state = slack([])
    net.installStatus = 502
    await render()
    await act(async () => button('Add to Slack')!.click())
    await flush()
    expect(net.calls).toContain('POST /api/account/integrations/slack/install')
    expect(JSON.parse(net.bodies[0])).toEqual({ returnTo: '/account/settings/connectors/slack' })
    expect(container.textContent).toContain("Couldn't start the Slack install")
  })
})

describe('linking one more Slack workspace', () => {
  it('opens the workspace being linked, and ends the code step when its link lands', async () => {
    net.state = slack([acme, beta])
    await render()
    await act(async () => button('Link my account in Beta')!.click())
    await flush()
    const open = [...container.querySelectorAll('a')].find((a) => a.textContent?.includes('Open Native Intelligence in Slack'))
    expect(open?.getAttribute('href')).toContain('team=T2')
    expect(container.textContent).toContain('K7Q4M2')

    net.state = slack([acme, { ...beta, myLink: { slackUserName: 'liam' } }])
    await act(async () => window.dispatchEvent(new Event('focus')))
    await flush()
    expect(container.textContent).not.toContain('K7Q4M2')
  })

  it('names the Slack workspace on each row’s buttons', async () => {
    net.state = slack([acme, beta])
    await render()
    expect(button('Unlink me from Acme')).toBeDefined()
    expect(button('Disconnect Beta')).toBeDefined()
  })
})

describe('a failed first read', () => {
  it('says so, not that Slack is unavailable, and can be tried again', async () => {
    net.getStatus = 500
    await render()
    expect(container.textContent).toContain("Couldn't load Slack")
    expect(container.textContent).not.toContain("isn't available")
    net.getStatus = 200
    net.state = slack([acme])
    await act(async () => button('Try again')!.click())
    await flush()
    expect(container.textContent).toContain('Acme')
  })
})
