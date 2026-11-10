// RSS 2.0 feed for the Native Intelligence blog. Generated from the same MDX source the blog
// pages read, so it stays in sync with published posts. Referenced by the
// <link rel="alternate" type="application/rss+xml"> in the root layout.
import { blog } from '@/lib/source'
import { appUrl } from '@/lib/app-url'

const BASE_URL = appUrl()
const FEED_TITLE = 'Native Intelligence Blog'
const FEED_DESCRIPTION = 'Product updates, writing, and announcements from Native Intelligence.'

// Escape the five XML predefined entities so titles/descriptions can't break
// the document.
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export const dynamic = 'force-static'

export function GET() {
  const posts = blog
    .getPages()
    .slice()
    .sort((a, b) => {
      const da = a.data.date ? new Date(a.data.date).getTime() : 0
      const db = b.data.date ? new Date(b.data.date).getTime() : 0
      return db - da
    })

  const items = posts
    .map((post) => {
      const url = `${BASE_URL}/blog/${post.slugs[0]}`
      const pubDate = post.data.date
        ? new Date(post.data.date).toUTCString()
        : undefined
      return [
        '    <item>',
        `      <title>${escapeXml(post.data.title ?? '')}</title>`,
        `      <link>${escapeXml(url)}</link>`,
        `      <guid isPermaLink="true">${escapeXml(url)}</guid>`,
        post.data.description
          ? `      <description>${escapeXml(post.data.description)}</description>`
          : undefined,
        post.data.author
          ? `      <author>${escapeXml(String(post.data.author))}</author>`
          : undefined,
        pubDate ? `      <pubDate>${pubDate}</pubDate>` : undefined,
        '    </item>',
      ]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n')

  const now = new Date().toUTCString()

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(FEED_TITLE)}</title>
    <link>${BASE_URL}/blog</link>
    <atom:link href="${BASE_URL}/blog/feed.xml" rel="self" type="application/rss+xml" />
    <description>${escapeXml(FEED_DESCRIPTION)}</description>
    <language>en-us</language>
    <lastBuildDate>${now}</lastBuildDate>
${items}
  </channel>
</rss>
`

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=86400',
    },
  })
}
