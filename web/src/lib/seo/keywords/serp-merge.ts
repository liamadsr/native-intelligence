/**
 * Merging several reads of one Google results page. Google serves automated
 * readers pages that vary (some poisoned), and nothing in a response marks
 * one, so a live SERP check reads the page three times and merges the reads:
 *
 *   - one organic row per site (a site's "www." and bare host are the same
 *     site), one SERP-feature row per type and site;
 *   - organic rows ordered by reciprocal rank fusion: a site every read shows
 *     beats any move up the page on one read, so a poisoned read cannot put
 *     its sites above the ones the reads agree on;
 *   - each row reported at the best position any read gave it, with how many
 *     reads showed it (`seen_in`);
 *   - SERP features after the organic rows, in page order.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import type { SerpItem } from './view'

/** One result of one read, trimmed to what the product reads (what a stored SERP keeps). */
export interface SerpReadItem {
  type: string
  rank_group?: number | null
  rank_absolute?: number | null
  domain?: string | null
  title?: string | null
  url?: string | null
  description?: string | null
  etv?: number | null
  referring_domains?: number | null
  backlinks?: number | null
}

export type MergedSerpItem = SerpReadItem & { seen_in: number }

// Reciprocal rank fusion's usual constant: large enough that a site on
// another read beats any move up the page.
const FUSION_K = 60

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** A provider SERP row, trimmed. */
export function trimSerpItem(item: {
  type: string
  rank_group?: number | null
  rank_absolute?: number | null
  domain?: string | null
  title?: string | null
  url?: string | null
  description?: string | null
  etv?: number | null
  backlinks_info?: {
    referring_domains?: number | null
    backlinks?: number | null
  } | null
}): SerpReadItem {
  return {
    type: item.type,
    rank_group: numOrNull(item.rank_group),
    rank_absolute: numOrNull(item.rank_absolute),
    domain: str(item.domain),
    title: str(item.title)?.slice(0, 300) ?? null,
    url: str(item.url)?.slice(0, 2048) ?? null,
    description: str(item.description)?.slice(0, 600) ?? null,
    etv: numOrNull(item.etv),
    referring_domains: numOrNull(item.backlinks_info?.referring_domains),
    backlinks: numOrNull(item.backlinks_info?.backlinks),
  }
}

function mergeKey(item: SerpReadItem): string {
  // The provider keeps "www." but a redirect row's breadcrumb host does not.
  const site = item.domain?.toLowerCase().replace(/^www\./, '')
  return `${item.type}|${site ?? item.title ?? ''}`
}

function bestPosition(item: SerpReadItem): number {
  return item.rank_group ?? item.rank_absolute ?? Number.MAX_SAFE_INTEGER
}

export function mergeSerpReads(
  reads: ReadonlyArray<ReadonlyArray<SerpReadItem>>,
): MergedSerpItem[] {
  const rows = new Map<
    string,
    { item: SerpReadItem; seenIn: number; score: number }
  >()
  for (const read of reads) {
    const seenOnRead = new Set<string>()
    for (const item of read) {
      const key = mergeKey(item)
      // Rows arrive in page order, so a site's first row on a read is its best.
      if (seenOnRead.has(key)) continue
      seenOnRead.add(key)
      const score = 1 / (FUSION_K + bestPosition(item))
      const row = rows.get(key)
      if (!row) {
        rows.set(key, { item, seenIn: 1, score })
        continue
      }
      row.seenIn += 1
      row.score += score
      if (bestPosition(item) < bestPosition(row.item)) row.item = item
    }
  }
  const all = [...rows.values()]
  const organic = all
    .filter((row) => row.item.type === 'organic')
    .sort((a, b) => b.score - a.score)
  const features = all
    .filter((row) => row.item.type !== 'organic')
    .sort(
      (a, b) =>
        (a.item.rank_absolute ?? Number.MAX_SAFE_INTEGER) -
        (b.item.rank_absolute ?? Number.MAX_SAFE_INTEGER),
    )
  return [...organic, ...features].map((row) => ({
    ...row.item,
    seen_in: row.seenIn,
  }))
}

/** The merged rows as the API returns them: organic rows numbered in merged order. */
export function serpItemsView(merged: readonly MergedSerpItem[]): SerpItem[] {
  let organicIndex = 0
  return merged.map((item) => {
    const organic = item.type === 'organic'
    return {
      type: item.type,
      rank: organic ? ++organicIndex : null,
      best_position: organic ? (item.rank_group ?? null) : null,
      seen_in: item.seen_in,
      domain: item.domain ?? null,
      title: item.title ?? null,
      url: item.url ?? null,
      description: item.description ?? null,
      etv: item.etv ?? null,
      referring_domains: item.referring_domains ?? null,
      backlinks: item.backlinks ?? null,
    }
  })
}
