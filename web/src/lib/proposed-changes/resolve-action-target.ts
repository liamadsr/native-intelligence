import type { SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Fuzzy action-target resolution for update/assign proposals
// ---------------------------------------------------------------------------
// The extractor stages `update:action` proposals with entity_id=null almost
// always — the model hears "we should bump the API docs task to urgent" but
// never knows the action's UUID. Before this resolver, every such proposal
// died at apply time with "Entity ID required for action update".
//
// Resolution runs tiered from strict to loose, mirroring the philosophy of
// people/name-match.ts: a precise match always beats a fuzzy one, and an
// AMBIGUOUS tier refuses rather than guesses — silently updating the wrong
// action is worse than asking the user to pick. Scopes narrow before wide:
// the capture's project is searched first, then the team, then the workspace.
// ---------------------------------------------------------------------------

/** Tokens that carry no identity between two task titles. Functional words
 *  only — verbs like "update"/"fix" are meaningful in titles and stay. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'for', 'of', 'on', 'in', 'with', 'and', 'or', 'by',
  'at', 'is', 'are', 'be', 'will', 'it', 'its', 'this', 'that', 'from', 'as',
  'into', 'about', 'our', 'their', 'his', 'her', 'we', 'they', 'should', 'need',
  'needs',
])

/** e.g. GEN-42, ENG-7 — a spoken identifier is the strongest possible signal. */
const IDENTIFIER_RE = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g

function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function significantTokens(s: string): string[] {
  return normalize(s)
    .split(' ')
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
}

/** Fraction of the smaller token set covered by the intersection, 0..1. */
function tokenOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const setA = new Set(a)
  let inter = 0
  const setB = new Set(b)
  for (const t of setB) if (setA.has(t)) inter++
  if (inter < 2) return 0
  return inter / Math.min(setA.size, setB.size)
}

const OVERLAP_THRESHOLD = 0.6
/** A runner-up this close to the best score makes the match ambiguous. */
const OVERLAP_AMBIGUITY_MARGIN = 0.15
/** Containment needs enough substance that "fix" doesn't match everything. */
const CONTAINMENT_MIN_CHARS = 10

export interface ActionCandidate {
  id: string
  title: string | null
  identifier?: string | null
}

export interface ActionMatch<T extends ActionCandidate> {
  match: T | null
  /** True when several candidates matched equally well at the winning tier —
   *  the caller should refuse to guess rather than pick one. */
  ambiguous: boolean
}

/**
 * Find the action a proposal most plausibly targets, or refuse.
 *
 * `needles` are the proposal's descriptive texts in priority order (title,
 * then display_text). Tiers, strict → loose (first tier with exactly one hit
 * wins; a tier with multiple hits returns ambiguous WITHOUT falling through —
 * looser tiers can only make ambiguity worse):
 *   1. identifier mentioned in any needle (e.g. "GEN-42")
 *   2. exact normalized title equality
 *   3. containment (one normalized title inside the other, length-guarded)
 *   4. significant-token overlap ≥ 0.6 with a clear winner margin
 */
export function findBestActionMatch<T extends ActionCandidate>(
  candidates: T[],
  needles: Array<string | null | undefined>,
): ActionMatch<T> {
  const texts = needles.filter((n): n is string => !!n && n.trim().length > 0)
  if (texts.length === 0 || candidates.length === 0) {
    return { match: null, ambiguous: false }
  }

  const parsed = candidates
    .map((c) => ({
      c,
      norm: c.title ? normalize(c.title) : '',
      tokens: c.title ? significantTokens(c.title) : [],
    }))
    .filter((p) => p.norm.length > 0)

  // Tier 1: spoken identifier
  const mentioned = new Set(
    texts.flatMap((t) => [...t.matchAll(IDENTIFIER_RE)].map((m) => m[1].toUpperCase())),
  )
  if (mentioned.size > 0) {
    const byIdentifier = parsed.filter(
      (p) => p.c.identifier && mentioned.has(p.c.identifier.toUpperCase()),
    )
    if (byIdentifier.length === 1) return { match: byIdentifier[0].c, ambiguous: false }
    if (byIdentifier.length > 1) return { match: null, ambiguous: true }
  }

  for (const text of texts) {
    const needleNorm = normalize(text)
    if (!needleNorm) continue

    // Tier 2: exact normalized title
    const exact = parsed.filter((p) => p.norm === needleNorm)
    if (exact.length === 1) return { match: exact[0].c, ambiguous: false }
    if (exact.length > 1) return { match: null, ambiguous: true }

    // Tier 3: containment — the shorter string must still be substantial
    const contained = parsed.filter((p) => {
      const shorter = p.norm.length <= needleNorm.length ? p.norm : needleNorm
      if (shorter.length < CONTAINMENT_MIN_CHARS) return false
      return needleNorm.includes(p.norm) || p.norm.includes(needleNorm)
    })
    if (contained.length === 1) return { match: contained[0].c, ambiguous: false }
    if (contained.length > 1) return { match: null, ambiguous: true }

    // Tier 4: token overlap with a clear-winner margin
    const needleTokens = significantTokens(text)
    const scored = parsed
      .map((p) => ({ p, score: tokenOverlap(needleTokens, p.tokens) }))
      .filter((s) => s.score >= OVERLAP_THRESHOLD)
      .sort((a, b) => b.score - a.score)
    if (scored.length === 1) return { match: scored[0].p.c, ambiguous: false }
    if (scored.length > 1) {
      if (scored[0].score - scored[1].score >= OVERLAP_AMBIGUITY_MARGIN) {
        return { match: scored[0].p.c, ambiguous: false }
      }
      return { match: null, ambiguous: true }
    }
  }

  return { match: null, ambiguous: false }
}

export interface ResolvedActionTarget {
  id: string
  title: string | null
  identifier: string | null
}

interface ActionRow {
  id: string
  title: string | null
  identifier: string | null
  project_id: string | null
  team_id: string | null
  workflow_state: { category: string } | null
}

/** How many recent workspace actions form the candidate pool. Meetings talk
 *  about live work, so recency-bounded is both cheaper and more accurate. */
const CANDIDATE_POOL_LIMIT = 400

/**
 * Resolve which existing action a proposal targets, from its descriptive text.
 *
 * Completed/canceled actions are excluded — nobody stages an update to work
 * that's already done, and a stale Done item sharing a title with live work is
 * exactly the wrong-target hazard. Matching runs against the capture's project
 * actions first, then the team's, then the whole (recent) workspace pool, so a
 * project-local title match beats an identical title elsewhere. Returns null
 * when nothing matches OR the match is ambiguous.
 */
export async function resolveActionTarget(
  supabase: SupabaseClient,
  workspaceId: string,
  opts: {
    title?: string | null
    displayText?: string | null
    projectId?: string | null
    teamId?: string | null
  },
): Promise<ResolvedActionTarget | null> {
  const needles = [opts.title, opts.displayText]
  if (!needles.some((n) => n && n.trim())) return null

  const { data } = await supabase
    .from('actions')
    .select('id, title, identifier, project_id, team_id, workflow_state:workflow_state!status_id(category)')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(CANDIDATE_POOL_LIMIT)

  const rows = ((data as unknown as ActionRow[]) ?? []).filter((r) => {
    const category = r.workflow_state?.category
    return category !== 'completed' && category !== 'canceled'
  })
  if (rows.length === 0) return null

  const scopes: ActionRow[][] = []
  if (opts.projectId) scopes.push(rows.filter((r) => r.project_id === opts.projectId))
  if (opts.teamId) scopes.push(rows.filter((r) => r.team_id === opts.teamId))
  scopes.push(rows)

  for (const scope of scopes) {
    if (scope.length === 0) continue
    const { match, ambiguous } = findBestActionMatch(scope, needles)
    if (match) return { id: match.id, title: match.title, identifier: match.identifier ?? null }
    // Ambiguous in a narrow scope stays ambiguous in a wider one (superset
    // of candidates) — stop rather than let a looser pool pick a winner.
    if (ambiguous) return null
  }
  return null
}
