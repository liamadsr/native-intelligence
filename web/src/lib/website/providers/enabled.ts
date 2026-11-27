/**
 * The setting (docs/plans/hosted-site-builders.md, deploy/app/.env.example):
 * WEBSITE_BUILDERS names the site builders the agent may connect,
 * comma-separated (`wordpress`, `shopify`, `webflow`, `wpcom`; each but
 * WordPress also needs its app's client id and secret). Empty or unset: none, and the website flow is
 * exactly the GitHub one. Only builders this build has are kept. Server only
 * (it reads the environment); no other import, so the onboarding section and
 * the tools can read it cheaply.
 */
import { BUILT_BUILDERS, type BuilderProvider } from './types'

export function enabledBuilders(env: Record<string, string | undefined> = process.env): BuilderProvider[] {
  const named = (env.WEBSITE_BUILDERS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  // Shopify needs our app's credentials as well: named without them, it stays off.
  return BUILT_BUILDERS.filter((b) => {
    if (!named.includes(b)) return false
    if (b === 'shopify') return shopifyApp(env) !== null
    if (b === 'webflow' || b === 'wpcom') return oauthBuilderApp(b, env) !== null
    return true
  })
}

/**
 * Our Shopify app (SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET: the app's Client
 * ID and secret in the Shopify Dev Dashboard), or null when either is empty.
 */
export function shopifyApp(env: Record<string, string | undefined> = process.env): { clientId: string; clientSecret: string } | null {
  const clientId = env.SHOPIFY_CLIENT_ID?.trim()
  const clientSecret = env.SHOPIFY_CLIENT_SECRET?.trim()
  return clientId && clientSecret ? { clientId, clientSecret } : null
}

/**
 * Our Webflow or WordPress.com app (WEBFLOW_CLIENT_ID / WEBFLOW_CLIENT_SECRET,
 * WPCOM_CLIENT_ID / WPCOM_CLIENT_SECRET: deploy/app/.env.example), or null
 * when either is empty.
 */
export function oauthBuilderApp(provider: 'webflow' | 'wpcom', env: Record<string, string | undefined> = process.env): { clientId: string; clientSecret: string } | null {
  const prefix = provider === 'webflow' ? 'WEBFLOW' : 'WPCOM'
  const clientId = env[`${prefix}_CLIENT_ID`]?.trim()
  const clientSecret = env[`${prefix}_CLIENT_SECRET`]?.trim()
  return clientId && clientSecret ? { clientId, clientSecret } : null
}
