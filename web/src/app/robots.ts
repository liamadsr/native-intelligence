import type { MetadataRoute } from 'next'

const BASE_URL = 'https://dial8.ai'

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
        ],
      },
    ],
    sitemap: `${BASE_URL}/sitemap.xml`,
    host: BASE_URL,
  }
}
