// @vitest-environment jsdom
/**
 * The agent panel's Slack tab (slack-card.tsx): the Phone tab's card, for
 * Slack. Not linked: Get my code. The code: to copy, Open Dial8 in Slack, a
 * new code. Linked: who you are there, each workspace at the foot with
 * Unlink. No alerts switch. The routes are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

vi.mock('@/app/account/settings/settings-shell', () => ({ useSettingsNavigate: () => () => {} }))
const { SlackCard } = await import('../slack-card')

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let myLink: { slackUserName: string; alertsOn: boolean } | null
let configured: boolean
const calls: string[] = []
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  calls.push(`${init?.method ?? 'GET'} ${url}`)
  if (url === '/api/account/integrations/slack') {
    return Response.json({ configured, appId: 'A1', canInstall: true, canLink: true, selfInstallOpen: false, installations: configured ? [{ teamId: 'T1', teamName: 'Acme', teamDomain: 'acme', myLink }] : [] })
  }
  if (url === '/api/account/integrations/slack/link-code') return Response.json({ code: 'K7Q2-9XPL', expiresAt: '2026-10-24T22:00:00Z' })
  if (url.startsWith('/api/account/integrations/slack/link?team=')) {
    myLink = null
    return Response.json({ ok: true })
  }
  return new Response('{}', { status: 404 })
})

let root: Root
let host: HTMLElement
beforeEach(() => {
  myLink = null
  configured = true
  calls.length = 0
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

const q = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel)
async function until(ready: () => boolean) {
  for (let i = 0; i < 200 && !ready(); i++) await act(async () => void (await new Promise((r) => setTimeout(r, 5))))
  expect(ready()).toBe(true)
}
async function mount() {
  await act(async () => root.render(<SlackCard name="Joseph" />))
  await until(() => !q('[aria-label="Loading"]'))
}

describe('the Slack card', () => {
  it('not linked: Get my code, then the code to send Dial8, to copy, with Open Dial8 in Slack', async () => {
    await mount()
    expect(q('[data-slack-step="setup"]')!.textContent).toContain('Message Joseph in Slack')
    await act(async () => q<HTMLButtonElement>('[data-slack-get-code]')!.click())
    await until(() => !!q('[data-slack-step="code"]'))
    expect(q('[data-slack-code]')!.textContent).toContain('K7Q2-9XPL')
    expect(q<HTMLAnchorElement>('[data-slack-open]')!.href).toBe('https://slack.com/app_redirect?app=A1&team=T1')
    expect(host.textContent).toContain('Works once, for 15 minutes')
  })

  it('linked: who you are there, Open Dial8 in Slack, each workspace at the foot with Unlink; no alerts switch', async () => {
    myLink = { slackUserName: 'liam', alertsOn: true }
    await mount()
    const linked = q('[data-slack-step="linked"]')!
    expect(linked.textContent).toContain('@liam')
    expect(linked.textContent).toContain('Acme')
    expect(q('[data-slack-open]')).not.toBeNull()
    expect(q('[data-slack-alerts]')).toBeNull()
    expect(host.querySelector('[role="switch"]')).toBeNull()
    await act(async () => q<HTMLButtonElement>('[aria-label="Unlink me from Acme"]')!.click())
    await until(() => !!q('[data-slack-step="setup"]'))
    expect(calls).toContain('DELETE /api/account/integrations/slack/link?team=T1')
  })

  it('Slack not set up on this Dial8: says so', async () => {
    configured = false
    await mount()
    expect(host.textContent).toContain("Slack isn't set up on this Dial8 yet.")
  })
})
