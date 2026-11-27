/**
 * The setting (docs/plans/hosted-site-builders.md, deploy/app/.env.example):
 * WEBSITE_BUILDERS names the site builders the agent may connect,
 * comma-separated (`wordpress`). Empty or unset: none, and the website flow is
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
  return BUILT_BUILDERS.filter((b) => named.includes(b))
}
