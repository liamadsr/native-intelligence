/**
 * What each single-use link purpose (./one-time.ts) shows and does:
 *
 *   view   the page's copy for an unused link (src/app/l/[token]/page.tsx),
 *          read with a peek, so nothing is used by looking.
 *   start  what the button does once the POST consumed the link
 *          (src/app/api/links/[token]/route.ts): a redirect, and the
 *          oauth_nonce binding cookie when the redirect starts an OAuth flow.
 *
 * A new purpose (Stripe Connect, track C) adds an entry here and to
 * migration 457's purpose check.
 */
import { importsOnConnect, parseOAuthConnectPayload, providerLabel, startConnectFromLink } from './oauth-link'
import type { OneTimeLink, OneTimeLinkPurpose } from './one-time'

export interface LinkPurposeView {
  title: string
  body: string
  button: string
}

export type LinkStart = { ok: true; redirect: string; oauthNonce: string | null } | { ok: false; error: string }

export interface LinkPurpose {
  view(link: OneTimeLink): LinkPurposeView | null
  start(link: OneTimeLink): LinkStart
}

const CAPABILITY_WORDS: Record<string, string> = { email: 'email', calendar: 'calendar', github: 'repositories', crm: 'contacts and companies', contacts: 'contacts' }

export const LINK_PURPOSES: Record<OneTimeLinkPurpose, LinkPurpose> = {
  oauth_connect: {
    view(link) {
      const payload = parseOAuthConnectPayload(link.payload)
      if (!payload) return null
      const name = providerLabel(payload.provider)
      const what = payload.capabilities.map((c) => CAPABILITY_WORDS[c] ?? c).join(' and ')
      return {
        // Google's contacts leg asked for on its own reads as its own product.
        title: payload.provider === 'google' && payload.capabilities.join() === 'contacts' ? 'Connect Google Contacts' : `Connect ${name}`,
        body: payload.capabilities.every((c) => importsOnConnect(payload.provider, c))
          ? `Your Native Intelligence agent will read your ${what} to bring them into Native Intelligence. It only reads: nothing is sent or changed in ${name}. You sign in on ${name}'s own page: Native Intelligence never sees your password.`
          : payload.provider === 'github'
            ? // A business's website (roadmap track E): it reads the repo and proposes changes as pull requests, merged only on their yes.
              `Your Native Intelligence agent will be able to read your repositories and suggest changes to your website as pull requests. Nothing goes live until you say yes by text. You sign in on GitHub's own page: Native Intelligence never sees your password.`
            : `Your Native Intelligence agent will be able to read your ${what}. You sign in on ${name}'s own page: Native Intelligence never sees your password.`,
        button: `Continue to ${name}`,
      }
    },
    start(link) {
      const started = startConnectFromLink(link)
      if (!started.ok) return started
      return { ok: true, redirect: started.start.authUrl, oauthNonce: started.start.nonce }
    },
  },
}
