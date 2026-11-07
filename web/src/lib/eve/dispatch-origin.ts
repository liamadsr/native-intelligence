/**
 * Where the app dispatches its OWN eve agents (skill-runner, utility, the
 * coding-agent and work-agent runs, and the agent-run follow-up chat), and the
 * header that lets that call through Vercel Deployment Protection.
 *
 * On Vercel the origin is THIS deployment (https://VERCEL_URL): the agents ship
 * with the same commit, and NEXT_PUBLIC_APP_URL is the production domain, so a
 * preview dispatching there would run production's code (and production's
 * database) instead of its own. Off Vercel it is NEXT_PUBLIC_APP_URL, else local
 * dev's default. The eve agents call back to the app the same way
 * (agents/*\/lib/spec-client.ts prefer https://VERCEL_URL).
 *
 * This is ONLY the dispatch origin. Links rendered into user-facing output
 * (flow templates' appBaseUrl) stay on the public domain.
 */
export function eveDispatchOrigin(): string {
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`
  return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
}

/** Lets a same-deployment call through Vercel Deployment Protection on previews. */
export function protectionBypassHeaders(): Record<string, string> {
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET
  return secret ? { 'x-vercel-protection-bypass': secret } : {}
}
