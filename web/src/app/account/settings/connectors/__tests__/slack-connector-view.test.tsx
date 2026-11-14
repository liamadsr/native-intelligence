// @vitest-environment jsdom
/**
 * Slack's page under Settings › Connectors (slack-connector-view.tsx):
 *
 *   • back from Slack's install it says how it ended, in plain words, and
 *     takes the result off the address (no code is made by itself);
 *   • Add to Slack asks for the install with this page to come back to;
 *     in the desktop app it opens Slack's page in the person's own browser,
 *     holds the claim for this window, and shows the result once the
 *     install is claimed back here;
 *   • linked in one Slack workspace, linking another sends the person to
 *     that workspace, and the code step ends when that link lands;
 *   • a failed first read says so and can be tried again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const desk = vi.hoisted(() => ({ on: false, openUrl: vi.fn(async (_url: string) => {}), hold: vi.fn() }))

vi.mock('../../settings-shell', () => ({ useSettingsNavigate: () => vi.fn() }))
vi.mock('../../../(dashboard)/side-panels/connections-section', () => ({ RowIcon: () => null }))
vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  isDesktopApp: () => desk.on,
}))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: desk.openUrl }))
vi.mock('@/lib/integrations/desktop-oauth-claims', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/integrations/desktop-oauth-claims')>()),
  holdDesktopSlackClaim: desk.hold,
}))

const { SlackConnectorView } = await import('../slack-connector-view')
const { emitSlackInstallCallback } = await import('@/lib/navigation-events')

type Team = { teamId: string; teamName: string; teamDomain: string; tokenStored?: boolean; myLink: { slackUserName: string } | null }
const net = {
  state: null as Record<string, unknown> | null,
  getStatus: 200,
  codeStatus: 200,
  installStatus: 200,
  installBody: null as Record<string, unknown> | null,
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
const acme: Team = { teamId: 'T1', teamName: 'Acme', teamDomain: 'acme', myLink: { slackUserName: 'sam' } }
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
  net.installBody = null
  desk.on = false
  desk.openUrl.mockReset().mockResolvedValue(undefined)
  desk.hold.mockReset()
  net.calls = []
  net.bodies = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET'
      net.calls.push(`${method} ${url}`)
      if (init?.body) net.bodies.push(init.body)
      if (url === '/api/account/integrations/slack/install') {
        const ok = net.installBody ?? { url: 'https://slack.com/oauth/v2/authorize?x=1' }
        return new Response(JSON.stringify(net.installStatus === 200 ? ok : { error: 'nope' }), { status: net.installStatus })
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
    // The web install is the page's own: nothing desktop about it.
    expect(desk.hold).not.toHaveBeenCalled()
    expect(desk.openUrl).not.toHaveBeenCalled()
  })
})

describe('Add to Slack in the desktop app', () => {
  const installButton = () => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Add to Slack')!
  const getReads = () => net.calls.filter((c) => c === 'GET /api/account/integrations/slack').length

  beforeEach(() => {
    desk.on = true
    net.installBody = { url: 'https://slack.com/oauth/v2/authorize?x=2', state: 'desk.state', claimSecret: 'desk-secret' }
  })

  it("asks for a desktop install, holds its claim, opens Slack's page in the person's browser, and stops spinning with a hint", async () => {
    net.state = slack([])
    await render()
    await act(async () => installButton().click())
    await flush()
    expect(JSON.parse(net.bodies[0])).toEqual({ returnTo: '/account/settings/connectors/slack', source: 'desktop' })
    expect(desk.hold).toHaveBeenCalledWith('desk.state', 'desk-secret')
    expect(desk.openUrl).toHaveBeenCalledWith('https://slack.com/oauth/v2/authorize?x=2')
    expect(desk.hold.mock.invocationCallOrder[0]).toBeLessThan(desk.openUrl.mock.invocationCallOrder[0])
    expect(installButton().disabled).toBe(false)
    expect(container.querySelector('svg.animate-spin')).toBeNull()
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'Finish adding Native Intelligence to Slack in your browser. This page updates by itself.',
    )
  })

  it('an answer without its state or claim secret starts nothing', async () => {
    net.installBody = { url: 'https://slack.com/oauth/v2/authorize?x=2' }
    net.state = slack([])
    await render()
    await act(async () => installButton().click())
    await flush()
    expect(desk.hold).not.toHaveBeenCalled()
    expect(desk.openUrl).not.toHaveBeenCalled()
    expect(container.textContent).toContain("Couldn't start the Slack install")
  })

  it("shows the claimed install's result as the page shows one from the address, and reads Slack's state again", async () => {
    net.state = slack([])
    await render()
    await act(async () => installButton().click())
    await flush()
    const before = getReads()
    net.state = slack([acme])
    await act(async () => emitSlackInstallCallback({ state: 'desk.state', result: 'installed' }))
    await flush()
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Slack is connected')
    expect(getReads()).toBe(before + 1)
    expect(container.textContent).toContain('Acme')
  })

  it('a failed result says why, plainly', async () => {
    net.state = slack([])
    await render()
    await act(async () => emitSlackInstallCallback({ state: 'desk.state', result: 'session' }))
    await flush()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('came back to a different browser')
    expect(container.querySelector('[role="status"]')).toBeNull()
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

    net.state = slack([acme, { ...beta, myLink: { slackUserName: 'sam' } }])
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

describe('a connected Slack workspace whose token the app does not hold', () => {
  it('says the app must be added to it again, with Add to Slack for an admin, and offers no linking there', async () => {
    net.state = slack([acme, { ...beta, tokenStored: false }])
    await render()
    const row = container.querySelector('[data-slack-team="T2"]')!
    expect(row.hasAttribute('data-slack-readd')).toBe(true)
    expect(row.textContent).toContain('has to be added to this Slack workspace again')
    expect(button('Add Native Intelligence to Beta again')).toBeDefined()
    expect(button('Link my account in Beta')).toBeUndefined()
    // The other workspace is as before.
    expect(container.querySelector('[data-slack-team="T1"]')!.hasAttribute('data-slack-readd')).toBe(false)
    await act(async () => button('Add Native Intelligence to Beta again')!.click())
    await flush()
    expect(net.calls).toContain('POST /api/account/integrations/slack/install')
  })

  it('tells someone who is not an admin to ask one', async () => {
    net.state = slack([{ ...beta, tokenStored: false }], { canInstall: false })
    await render()
    expect(container.textContent).toContain('Ask an admin of this workspace to add it')
    expect(button('Add Native Intelligence to Beta again')).toBeUndefined()
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
