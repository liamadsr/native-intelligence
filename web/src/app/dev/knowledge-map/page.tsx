import { notFound } from 'next/navigation'
import KnowledgeMapBenchLoader from './bench-loader'

/**
 * Synthetic Knowledge Map benchmark — DEV ONLY.
 *
 * This route is the only way to exercise the GL and multi-tile paths at all:
 * real workspaces are 10³–10⁴ nodes, which is a SINGLE tile (architecture §7
 * build order step 2), so every streaming, eviction and LOD branch in the
 * client is dead code until something generates a 200k-node map.
 *
 * It lives outside /account deliberately — the proxy matcher only covers
 * /account and /admin, so there is no auth round trip and no workspace header
 * to fake. `notFound()` in production is what keeps it out of the shipped app;
 * `robots: noindex` is belt and braces for any preview deployment.
 */
export const metadata = {
  robots: { index: false },
}

export default function KnowledgeMapBenchPage() {
  if (process.env.NODE_ENV === 'production') notFound()
  return <KnowledgeMapBenchLoader />
}
