import type { MetadataRoute } from 'next'
import { appUrl } from '@/lib/app-url'

const BASE_URL = appUrl()

// Robots policy for crawlers. We allow the public marketing surface (including
// the public docs) and block everything that is either private (the app,
// admin, API) or a utility route with no SEO value (auth flows, oauth
// callbacks, the Sentry test page). All bots are allowed — no AI-crawler blocks.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/account',
          '/admin',
          '/api/',
          '/login',
          '/forgot-password',
          '/reset-password',
          '/welcome',
          '/sign-out',
          '/auth/',
          '/oauth-popup-callback',
          '/mcp-oauth-popup-callback',
          '/mcp/',
          '/hud',
          '/s/',
          '/invite/',
          // A time offer's page and a guest's manage page: one person's link each.
          '/t/',
          '/b/',
        ],
      },
    ],
    sitemap: `${BASE_URL}/sitemap.xml`,
    host: BASE_URL,
  }
}
