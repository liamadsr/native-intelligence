import { ROADMAP_API_URL, ROADMAP_REVALIDATE_SECONDS } from './constants'
import { buildRoadmap, emptyRoadmap, type RoadmapData } from './parse'

const TIMEOUT_MS = 8_000

/**
 * The public roadmap from GitHub, cached by Next for five minutes.
 *
 * Never throws: any failure (network, rate limit, bad JSON) returns an empty
 * roadmap with `ok: false`, and the page links to GitHub instead.
 *
 * `GITHUB_ROADMAP_TOKEN` is optional. Without it GitHub allows 60 requests an
 * hour per IP, which the cache keeps us well under; a token raises that.
 */
export async function getRoadmap(fetchImpl: typeof fetch = fetch): Promise<RoadmapData> {
  try {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'native-intelligence-roadmap',
    }
    const token = process.env.GITHUB_ROADMAP_TOKEN?.trim()
    if (token) headers.Authorization = `Bearer ${token}`

    const res = await fetchImpl(ROADMAP_API_URL, {
      headers,
      next: { revalidate: ROADMAP_REVALIDATE_SECONDS },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      console.warn(`[roadmap] GitHub answered ${res.status}`)
      return emptyRoadmap(false)
    }
    return buildRoadmap(await res.json())
  } catch (error) {
    console.warn('[roadmap] could not load the roadmap from GitHub:', error instanceof Error ? error.message : error)
    return emptyRoadmap(false)
  }
}
