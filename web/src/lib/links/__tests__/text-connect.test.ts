import { beforeEach, describe, expect, it, vi } from 'vitest'
import { verifyOAuthState } from '@/lib/oauth/state'
import { connectLinkText, connectedNoticeEmail, nextConnectLeg, parseOAuthConnectPayload, startConnectFromLink, textConnectConfirmation } from '../oauth-link'
import { handleTextConnectCallback, type TextConnectCallbackDeps } from '../text-connect-callback'
import { LINK_PURPOSES } from '../purposes'
import type { OneTimeLink } from '../one-time'

/**
 * Connecting Google from a texted link: the link starts the sign-in with no
 * session, bound to the phone's browser by the nonce cookie; one tap connects
 * mail then calendar; the agent confirms in the text thread; and setup by
 * text asks for the website next. A browser that didn't start the flow gets
 * nothing.
 */
const LINK: OneTimeLink = {
  id: 'link-1',
  purpose: 'oauth_connect',
  userId: 'user-1',
  workspaceId: 'ws-1',
  payload: { provider: 'google', capabilities: ['email', 'calendar'] },
  expiresAt: '2026-11-02T15:15:00Z',
}

beforeEach(() => {
  vi.stubEnv('GOOGLE_CLIENT_ID', 'google-client')
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://dial8.ai')
})

function stateOf(authUrl: string) {
  const verified = verifyOAuthState(new URL(authUrl).searchParams.get('state'))
  if (!verified.ok) throw new Error(verified.error)
  return verified.data
}

describe('the link starts the provider sign-in', () => {
  it('the first leg is a web state for the link’s account, marked as from a text, with the rest of the legs', () => {
    const started = startConnectFromLink(LINK)
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const url = new URL(started.start.authUrl)
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('scope')).toContain('gmail.readonly')
    const state = stateOf(started.start.authUrl)
    expect(state).toMatchObject({ userId: 'user-1', workspaceId: 'ws-1', capability: 'email', source: 'web', via: 'text', then: ['calendar'], done: [], returnTo: '/l/done' })
    expect(state.nonce).toBe(started.start.nonce)
    expect(started.start.claimSecret).toBeNull()
  })

  it('a payload that is not a known provider or capability starts nothing', () => {
    expect(parseOAuthConnectPayload({ provider: 'asana', capabilities: ['tasks'] })).toBeNull()
    expect(parseOAuthConnectPayload({ provider: 'hubspot', capabilities: ['email'] })).toBeNull()
    expect(parseOAuthConnectPayload({ provider: 'google', capabilities: ['crm'] })).toBeNull()
    expect(parseOAuthConnectPayload({ provider: 'google', capabilities: ['calendar', 'email', 'calendar'] })).toEqual({ provider: 'google', capabilities: ['email', 'calendar'] })
    expect(startConnectFromLink({ ...LINK, payload: { provider: 'google' } })).toEqual({ ok: false, error: 'bad_link' })
  })

  it("the page's copy names the provider and says the password stays on its page", () => {
    expect(LINK_PURPOSES.oauth_connect.view(LINK)).toEqual({
      title: 'Connect Google',
      body: "Your Native Intelligence agent will be able to read your email and calendar. You sign in on Google's own page: Native Intelligence never sees your password.",
      button: 'Continue to Google',
    })
    const started = LINK_PURPOSES.oauth_connect.start(LINK)
    expect(started.ok && started.oauthNonce).toBeTruthy()
  })
})

describe('the callback for a texted link', () => {
  function deps(over: Partial<{ ok: boolean; email: string }> = {}) {
    const confirmed: Array<Record<string, unknown>> = []
    const d: TextConnectCallbackDeps = {
      complete: vi.fn(async (input) => (over.ok === false ? { ok: false as const, error: 'token_exchange_failed' } : { ok: true as const, provider: input.provider, capability: input.capability, email: over.email ?? 'jane@brightweave.com' })),
      confirm: vi.fn(async (args) => {
        confirmed.push(args)
      }),
    }
    return { d, confirmed }
  }
  const first = () => {
    const started = startConnectFromLink(LINK)
    if (!started.ok) throw new Error('no start')
    return { state: stateOf(started.start.authUrl), nonce: started.start.nonce }
  }

  it('a browser without the nonce cookie gets nothing: no token exchange, no text, and its own cookie is left alone', async () => {
    const { state } = first()
    const { d } = deps()
    for (const cookieNonce of [null, 'someone-elses-nonce']) {
      expect(await handleTextConnectCallback({ provider: 'google', code: 'c1', error: null, state, cookieNonce }, d)).toEqual({ redirect: '/l/done?status=failed', nonce: undefined, status: 'failed' })
    }
    expect(d.complete).not.toHaveBeenCalled()
    expect(d.confirm).not.toHaveBeenCalled()
  })

  it('mail connects and the person is told at once (calendar still to come), then calendar starts in the same browser and gets one more line', async () => {
    const { state, nonce } = first()
    const { d, confirmed } = deps()
    const one = await handleTextConnectCallback({ provider: 'google', code: 'c1', error: null, state, cookieNonce: nonce }, d)
    expect(one.status).toBe('next')
    expect(d.complete).toHaveBeenCalledWith({ provider: 'google', code: 'c1', userId: 'user-1', capability: 'email', stateWorkspaceId: 'ws-1', stateNonce: expect.any(String) })
    expect(confirmed).toEqual([{ userId: 'user-1', workspaceId: 'ws-1', provider: 'google', capabilities: ['email'], email: 'jane@brightweave.com', messageKey: nonce, first: true, pending: ['calendar'] }])
    const second = stateOf(one.redirect)
    expect(second).toMatchObject({ capability: 'calendar', via: 'text', then: [], done: ['email'], userId: 'user-1', workspaceId: 'ws-1' })
    expect(second.nonce).toBe(one.nonce)
    expect(new URL(one.redirect).searchParams.get('login_hint')).toBe('jane@brightweave.com')
    const two = await handleTextConnectCallback({ provider: 'google', code: 'c2', error: null, state: second, cookieNonce: one.nonce! }, d)
    expect(two).toEqual({ redirect: '/l/done?status=connected', nonce: null, status: 'connected' })
    expect(confirmed[1]).toEqual({ userId: 'user-1', workspaceId: 'ws-1', provider: 'google', capabilities: ['calendar'], email: 'jane@brightweave.com', messageKey: second.nonce, first: false, pending: [] })
  })

  it('refusing the calendar screen after mail connected: mail was confirmed at once, and calendar gets one line saying it did not connect', async () => {
    const { state, nonce } = first()
    const { d, confirmed } = deps()
    const one = await handleTextConnectCallback({ provider: 'google', code: 'c1', error: null, state, cookieNonce: nonce }, d)
    const second = stateOf(one.redirect)
    const out = await handleTextConnectCallback({ provider: 'google', code: null, error: 'access_denied', state: second, cookieNonce: one.nonce! }, d)
    expect(out.status).toBe('partial')
    expect(confirmed).toHaveLength(2)
    expect(confirmed[0]).toMatchObject({ capabilities: ['email'], first: true })
    expect(confirmed[1]).toEqual({ userId: 'user-1', workspaceId: 'ws-1', provider: 'google', capabilities: ['calendar'], email: null, messageKey: second.nonce, first: false, pending: [], failed: true })
  })

  it('saying no (or a failed exchange) on the first leg connects nothing and texts nothing', async () => {
    const { state, nonce } = first()
    const denied = deps()
    expect((await handleTextConnectCallback({ provider: 'google', code: null, error: 'access_denied', state, cookieNonce: nonce }, denied.d)).status).toBe('failed')
    const broken = deps({ ok: false })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect((await handleTextConnectCallback({ provider: 'google', code: 'c1', error: null, state, cookieNonce: nonce }, broken.d)).status).toBe('failed')
    expect([...denied.confirmed, ...broken.confirmed]).toEqual([])
  })

  it('only a texted link’s state chains a leg', () => {
    const { state } = first()
    expect(nextConnectLeg({ ...state, via: null }, 'google', 'email', null)).toBeNull()
    expect(nextConnectLeg({ ...state, then: [] }, 'google', 'email', null)).toBeNull()
    expect(nextConnectLeg({ ...state, then: ['crm'] }, 'google', 'email', null)).toBeNull()
  })
})

describe('the confirmation text', () => {
  it('the first leg says what connected and what is next; during setup it asks for the website, guessing it from a business address', () => {
    expect(textConnectConfirmation({ provider: 'google', capabilities: ['email'], email: 'jane@brightweave.com', inSetup: true, first: true, pending: ['calendar'] })).toBe(
      "Google is connected (jane@brightweave.com): email. Calendar is next on that page. Is brightweave.com your business's website? Reply yes, or send me the right one, and I'll read it and set up your business.",
    )
    expect(textConnectConfirmation({ provider: 'google', capabilities: ['email'], email: 'jane.rugs@gmail.com', inSetup: true, first: true })).toBe(
      "Google is connected (jane.rugs@gmail.com): email. What's your business's website? Send it and I'll read it and set up your business.",
    )
  })

  it('outside setup it only says what connected; a later leg is one line', () => {
    expect(textConnectConfirmation({ provider: 'google', capabilities: ['email'], email: 'jane@brightweave.com', inSetup: false, first: true })).toBe('Google is connected (jane@brightweave.com): email.')
    expect(textConnectConfirmation({ provider: 'google', capabilities: ['calendar'], email: 'jane@brightweave.com', inSetup: true, first: false })).toBe('Google calendar is connected too.')
    expect(textConnectConfirmation({ provider: 'google', capabilities: ['calendar'], email: null, inSetup: false, first: false, failed: true })).toBe(
      'Google calendar didn\'t connect. Text me "connect Google" anytime for a new link.',
    )
  })

  it('the link text says what it opens, that it works once, and never asks for a password', () => {
    expect(connectLinkText('google', 'https://dial8.ai/l/AbCdEfGhIjKlMnOpQrStUv12')).toBe(
      "Connect your Google account: https://dial8.ai/l/AbCdEfGhIjKlMnOpQrStUv12 It opens Google's own sign-in and works once, for 15 minutes. I'll never ask for a password by text.",
    )
    for (const inSetup of [true, false]) {
      expect(textConnectConfirmation({ provider: 'google', capabilities: ['email'], email: 'a@b.com', inSetup, first: true }).toLowerCase()).not.toContain('password')
    }
  })

  it("the connected address's email names the Native Intelligence account it joined and how to remove the access", () => {
    const mail = connectedNoticeEmail({ to: 'jane@brightweave.com', provider: 'google', maskedPhone: '+1 ••• ••• 4321' })
    expect(mail.subject).toBe('Your Google account was connected to Native Intelligence')
    expect(mail.text).toContain('jane@brightweave.com was just connected to the Native Intelligence account texting +1 ••• ••• 4321')
    expect(mail.text).toContain('https://myaccount.google.com/permissions')
  })
})

describe("the GitHub link's page (roadmap track E)", () => {
  it('says the agent suggests website changes as pull requests, live only on their yes', async () => {
    const { LINK_PURPOSES } = await import('../purposes')
    const view = LINK_PURPOSES.oauth_connect.view({ payload: { provider: 'github', capabilities: ['github'] } } as never)
    expect(view).toEqual({
      title: 'Connect GitHub',
      body: "Your Native Intelligence agent will be able to read your repositories and suggest changes to your website as pull requests. Nothing goes live until you say yes by text. You sign in on GitHub's own page: Native Intelligence never sees your password.",
      button: 'Continue to GitHub',
    })
  })
})
