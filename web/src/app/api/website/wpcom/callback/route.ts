/**
 * Where WordPress.com sends the owner back after they approve our app for
 * their site (docs/plans/hosted-site-builders.md, phase 3): the redirect URL its
 * app names (deploy/app/.env.example). The work is src/lib/website/oauth-callback.ts.
 */
import { oauthBuilderCallback } from '@/lib/website/oauth-callback'

export const dynamic = 'force-dynamic'

export function GET(request: Request): Promise<Response> {
  return oauthBuilderCallback('wpcom', request)
}
