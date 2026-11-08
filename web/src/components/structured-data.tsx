/**
 * Renders JSON-LD structured data as a script tag in the initial server HTML so
 * crawlers and AI agents can read it without executing JS.
 *
 * The stable `id` lets React reconcile this element by key, and
 * `suppressHydrationWarning` prevents a false hydration mismatch when other
 * client scripts (e.g. PostHog's array loader) inject sibling <script> tags
 * into the tree before React hydrates.
 */
export function StructuredData({
  id = 'structured-data',
  data,
}: {
  id?: string
  data: object | object[]
}) {
  // An array renders as one script tag PER schema rather than a single
  // top-level JSON array: some in-the-wild consumers (Safari 26's page
  // parser, link-preview bots) JSON.parse the tag and read `@context` off
  // the root, throwing on an array. Per-entity tags are equally valid
  // JSON-LD and every consumer handles them.
  const items = Array.isArray(data) ? data : [data]
  return (
    <>
      {items.map((item, i) => (
        <script
          key={i}
          id={items.length === 1 ? id : `${id}-${i}`}
          type="application/ld+json"
          suppressHydrationWarning
          // schema.org JSON-LD — the content is static, author-controlled data,
          // not user input, so this is safe.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(item) }}
        />
      ))}
    </>
  )
}

const BASE_URL = 'https://dial8.ai'

// Organization schema — powers the knowledge panel / brand entity.
export const organizationSchema = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'Dial8',
  url: BASE_URL,
  logo: `${BASE_URL}/screenshots/Icon-macOS-Dark-1024x1024@2x-dark.png`,
  description:
    'Dial8 is the system that turns conversations into action — meeting capture, project management, and AI execution in one workspace.',
  sameAs: ['https://x.com/Dial8_ai', 'https://discord.gg/sHtYGtkWga'],
}

// WebSite schema — enables sitelinks search box eligibility and entity linking.
export const websiteSchema = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: 'Dial8',
  url: BASE_URL,
}

// SoftwareApplication schema — Dial8 as a product, eligible for rich results.
export const softwareApplicationSchema = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'Dial8',
  applicationCategory: 'BusinessApplication',
  operatingSystem: 'macOS, Windows, Web',
  url: BASE_URL,
  description:
    'Capture meetings, keep projects updated automatically, and let AI agents execute the work. Meeting capture, project management, and AI execution in one system.',
  offers: {
    '@type': 'Offer',
    price: '0',
    priceCurrency: 'USD',
    description: 'Free tier available',
  },
}

// SoftwareApplication schema for Dial8 Scribe — the free, open-source macOS
// speech-to-text app. Eligible for rich results on the /scribe page.
export const scribeSoftwareApplicationSchema = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'Dial8 Scribe',
  applicationCategory: 'UtilitiesApplication',
  operatingSystem: 'macOS, Windows',
  url: `${BASE_URL}/scribe`,
  description:
    'Hold a hotkey, speak, release — your words appear as text anywhere on your Mac. Powered by Whisper, running locally. Free and open source.',
  isAccessibleForFree: true,
  license: 'https://opensource.org/licenses/MIT',
  offers: {
    '@type': 'Offer',
    price: '0',
    priceCurrency: 'USD',
    description: 'Free and open source (MIT)',
  },
}

// BlogPosting schema — powers article rich results for a single blog post.
export function blogPostingSchema(post: {
  title: string
  description?: string
  date?: string | Date
  author?: string
  url: string
}) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title,
    ...(post.description ? { description: post.description } : {}),
    ...(post.date ? { datePublished: new Date(post.date).toISOString() } : {}),
    ...(post.author
      ? { author: { '@type': 'Person', name: post.author } }
      : {}),
    url: post.url,
    mainEntityOfPage: { '@type': 'WebPage', '@id': post.url },
    publisher: {
      '@type': 'Organization',
      name: 'Dial8',
      url: BASE_URL,
      logo: {
        '@type': 'ImageObject',
        url: `${BASE_URL}/screenshots/Icon-macOS-Dark-1024x1024@2x-dark.png`,
      },
    },
  }
}
