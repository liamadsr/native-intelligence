/**
 * The OAuth callback for a connect started from a texted link (state
 * `via: 'text'`, ./oauth-link.ts). The phone's browser has no Dial8 session,
 * so the binding is the web flow's: the oauth_nonce cookie the link's POST
 * set must equal the state's nonce, or nothing happens at all (and the
 * cookie is left alone, so a connect this browser really started isn't
 * broken by someone else's state).
 *
 *   connected leg   confirmed at once, in their thread and by text (the
 *                   first leg says what's still to come and, during setup by
 *                   text, asks for the website; a later leg is one line), then
 *                   the next leg starts (Google: calendar after email) with a
 *                   fresh nonce cookie. Closing the second consent screen
 *                   still leaves them told about the first.
 *   refused/failed  a later leg gets one line saying it didn't connect (the
 *                   first leg's text said it was next); a first leg says
 *                   nothing (the page says nothing connected).
 *
 * The browser lands on /l/done, which points back to the texts.
 * Pure over {@link TextConnectCallbackDeps}.
 */
import { isValidCapability, isValidProvider, type OAuthCapability } from '@/lib/oauth/config'
import type { CompleteConnectInput, CompleteConnectResult } from '@/lib/oauth/complete-connect'
import { secretsEqual, type OAuthStateData } from '@/lib/oauth/state'
import { TEXT_CONNECT_DONE_PATH, nextConnectLeg } from './oauth-link'

export interface TextConnectCallbackInput {
  provider: string
  code: string | null
  /** The provider's `error` (the person said no, or it failed). */
  error: string | null
  state: OAuthStateData
  /** The oauth_nonce cookie this browser carries. */
  cookieNonce: string | null
}

export interface TextConnectCallbackDeps {
  complete(input: CompleteConnectInput): Promise<CompleteConnectResult>
  confirm(args: {
    userId: string
    workspaceId: string
    provider: string
    capabilities: readonly string[]
    email: string | null
    messageKey: string
    first: boolean
    pending: readonly string[]
    /** True when this leg did NOT connect (a later leg refused or failed): `capabilities` is what didn't. */
    failed?: boolean
  }): Promise<unknown>
}

export interface TextConnectCallbackResult {
  /** Where the browser goes: the next leg's provider page, or /l/done (a path). */
  redirect: string
  /** The oauth_nonce cookie: the next leg's nonce to set, null to clear it, undefined to leave it alone. */
  nonce: string | null | undefined
  status: 'next' | 'connected' | 'partial' | 'failed'
}

/** The flow's end: /l/done, the cookie cleared (or left alone, for a browser that didn't start this flow). */
function done(status: 'connected' | 'partial' | 'failed', opts: { keepCookie?: boolean } = {}): TextConnectCallbackResult {
  return { redirect: `${TEXT_CONNECT_DONE_PATH}?status=${status}`, nonce: opts.keepCookie ? undefined : null, status }
}

export async function handleTextConnectCallback(input: TextConnectCallbackInput, deps: TextConnectCallbackDeps): Promise<TextConnectCallbackResult> {
  const { state, provider } = input
  // The binding first: no side effect (not even on the cookie) for a browser that didn't start this flow.
  if (!state.nonce || !secretsEqual(input.cookieNonce, state.nonce)) return done('failed', { keepCookie: true })
  if (!state.userId || !state.workspaceId || !isValidProvider(provider) || !state.capability || !isValidCapability(state.capability)) return done('failed')
  const userId = state.userId
  const workspaceId = state.workspaceId
  const capability: OAuthCapability = state.capability
  const first = state.done.filter(isValidCapability).length === 0

  const legDidNotConnect = async (): Promise<TextConnectCallbackResult> => {
    if (first) return done('failed')
    await deps.confirm({ userId, workspaceId, provider, capabilities: [capability], email: null, messageKey: state.nonce!, first: false, pending: [], failed: true })
    return done('partial')
  }
  if (input.error || !input.code) return legDidNotConnect()
  const result = await deps.complete({ provider, code: input.code, userId, capability, stateWorkspaceId: workspaceId, stateNonce: state.nonce })
  if (!result.ok) {
    console.warn(`[text-connect] leg failed provider=${provider} capability=${capability}: ${result.error}`)
    return legDidNotConnect()
  }

  const next = nextConnectLeg(state, provider, capability, result.email)
  await deps.confirm({
    userId,
    workspaceId,
    provider,
    capabilities: [capability],
    email: result.email,
    messageKey: state.nonce,
    first,
    pending: next ? state.then.filter((c) => isValidCapability(c) && c !== capability) : [],
  })
  if (next) return { redirect: next.authUrl, nonce: next.nonce, status: 'next' }
  return done('connected')
}
