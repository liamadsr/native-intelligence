import type { MetadataRoute } from 'next'
import { blog, source } from '@/lib/source'
import { VS_COMPETITOR_SLUGS } from '@/data/vs-competitors'

const BASE_URL = 'https://dial8.ai'

// Public marketing surface plus the public docs. Auth/utility routes carry no
// SEO value, so they don't appear here (see robots.ts).
export default function sitemap(): MetadataRoute.Sitemap {
  // Derived from the same source of truth that generates the /vs/[competitor]
  // routes, so the sitemap can't drift from the real route set.
  const vsRoutes: MetadataRoute.Sitemap = VS_COMPETITOR_SLUGS.map((slug) => ({
    url: `${BASE_URL}/vs/${slug}`,
    changeFrequency: 'monthly',
    priority: 0.8,
  }))

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${BASE_URL}/`, changeFrequency: 'weekly', priority: 1 },
    { url: `${BASE_URL}/pricing`, changeFrequency: 'monthly', priority: 0.9 },
    { url: `${BASE_URL}/scribe`, changeFrequency: 'monthly', priority: 0.8 },
    // /sales is NOT listed: the sales pitch moved to `/` and /sales is a 308. A
    // redirect in the sitemap is a soft error in Search Console and splits
    // signal away from the canonical homepage. /meeting-notes and
    // /company-brain serve their own pitches again but, as before the sales
    // pivot, are not listed either — add them if they should be pushed for
    // organic search.
    ...vsRoutes,
    { url: `${BASE_URL}/ai-work-environment`, changeFrequency: 'monthly', priority: 0.7 },
    { url: `${BASE_URL}/blog`, changeFrequency: 'weekly', priority: 0.7 },
    { url: `${BASE_URL}/release-notes`, changeFrequency: 'weekly', priority: 0.6 },
    { url: `${BASE_URL}/about`, changeFrequency: 'monthly', priority: 0.5 },
    { url: `${BASE_URL}/contact`, changeFrequency: 'yearly', priority: 0.4 },
    { url: `${BASE_URL}/privacy`, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${BASE_URL}/terms`, changeFrequency: 'yearly', priority: 0.3 },
  ]

  const blogRoutes: MetadataRoute.Sitemap = blog.getPages().map((post) => ({
    url: `${BASE_URL}/blog/${post.slugs[0]}`,
    lastModified: post.data.date ? new Date(post.data.date) : undefined,
    changeFrequency: 'monthly',
    priority: 0.6,
  }))

  const docsRoutes: MetadataRoute.Sitemap = source.getPages().map((page) => ({
    url: `${BASE_URL}${page.url}`,
    changeFrequency: 'monthly',
    priority: 0.6,
  }))

  return [...staticRoutes, ...blogRoutes, ...docsRoutes]
}
