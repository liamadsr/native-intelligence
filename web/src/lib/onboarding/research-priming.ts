import type { NextRequest } from 'next/server'

/**
 * Optional priming the wizard's PrimeStep collects and POSTs with the kickoff:
 * the user's self-declared role and what they're working on right now. Both are
 * OPTIONAL and best-effort — a malformed or oversized value is clamped/omitted,
 * never a 400. They are persisted under onboarding_progress.priming and folded
 * into the researcher brief so the agent can tailor its work.
 */
interface Priming {
  role?: string
  /**
   * The SAME role picks as `role`, unflattened. `role` stays the comma-joined
   * sentence the researcher brief reads; `roles` rides the brief as exact chips
   * — a joined string can't be re-split without losing a comma-bearing
   * free-text 'Other'.
   * Absent on a legacy/resumed client that only sends `role`.
   */
  roles?: string[]
  focus?: string
  /** From the wizard's question steps: where this person's meetings happen. */
  meetingPlatforms?: string[]
  /** From the wizard's question steps: their chosen capture default. */
  capturePreference?: string
}

// Roles are now a multi-select joined with ", " — 200 leaves room for several
// picks plus an 'Other' free-text without clamping mid-word in practice.
const ROLE_MAX = 200
/** Per-chip cap for the unflattened `roles[]`; the joined string caps at ROLE_MAX. */
const ROLE_ITEM_MAX = 60
const ROLES_MAX_COUNT = 10
const FOCUS_MAX = 500
const PLATFORM_MAX = 50
const PLATFORMS_MAX_COUNT = 10
const CAPTURE_MAX = 20

/**
 * Parse the optional kickoff body into a Priming. Tolerant by contract: an empty
 * body, no body, or malformed JSON all yield an empty Priming; a role/focus that
 * isn't a non-empty string is omitted; over-long values are trimmed then capped.
 * This must NEVER throw or cause the route to 400 — priming is a nicety, not a
 * gate on starting research.
 */
export async function parsePriming(request: NextRequest): Promise<Priming> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return {}
  }
  if (!body || typeof body !== 'object') return {}
  const bag = body as Record<string, unknown>
  const priming: Priming = {}
  const role = clampField(bag.role, ROLE_MAX)
  if (role) priming.role = role
  // Prefer the client's unflattened chips; fall back to re-splitting the joined
  // string so a resumed/legacy client still yields a derivable role list.
  const roles = Array.isArray(bag.roles)
    ? bag.roles
        .map((item) => clampField(item, ROLE_ITEM_MAX))
        .filter((item): item is string => Boolean(item))
        .slice(0, ROLES_MAX_COUNT)
    : splitRoleString(role).slice(0, ROLES_MAX_COUNT)
  if (roles.length > 0) priming.roles = roles
  const focus = clampField(bag.focus, FOCUS_MAX)
  if (focus) priming.focus = focus
  if (Array.isArray(bag.meetingPlatforms)) {
    const platforms = bag.meetingPlatforms
      .map((item) => clampField(item, PLATFORM_MAX))
      .filter((item): item is string => Boolean(item))
      .slice(0, PLATFORMS_MAX_COUNT)
    if (platforms.length > 0) priming.meetingPlatforms = platforms
  }
  const capture = clampField(bag.capturePreference, CAPTURE_MAX)
  if (capture) priming.capturePreference = capture
  return priming
}

/** Trim a candidate string and cap its length; non-strings/blanks → undefined. */
function clampField(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.slice(0, max)
}

/**
 * Split the wizard's comma-joined role string back into chips.
 *
 * The onboarding step joins its multi-select with ', ' before the network call,
 * so a resumed/legacy member's durable `priming.role` is all we have. Lossy only
 * for a free-text 'Other' value containing a comma.
 */
export function splitRoleString(role: string | undefined | null): string[] {
  if (!role) return []
  return role
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}
