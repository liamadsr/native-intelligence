/**
 * The closed vocabularies a work proposal names when it is attemptable
 * (Sequence step 2 / B PR 1): WHO should do the work (a teammate role) and WHAT
 * it must produce (`expects`). Plain data, client-safe (no server imports) —
 * the verdict schema, the payload clamp, the gate (B PR 3), `delegate_work`
 * (step 13) and the settings surface (PR 5) all read from here, and migration
 * 280's CHECK constraints mirror the same lists.
 *
 * The roles are grounded in the deliverable shapes that exist
 * (docs/plans/agent-orchestration-product.md §3.5): a researcher or writer
 * produces a document, a correspondent an email draft, a developer a PR (an
 * `entity` deliverable with entity_type 'pr').
 */

export const WORK_ROLES = ['researcher', 'writer', 'developer', 'correspondent'] as const
export type WorkRole = (typeof WORK_ROLES)[number]

export function isWorkRole(v: unknown): v is WorkRole {
  return typeof v === 'string' && (WORK_ROLES as readonly string[]).includes(v)
}

/** How a role reads in the UI. */
export const WORK_ROLE_LABELS: Record<WorkRole, string> = {
  researcher: 'Researcher',
  writer: 'Writer',
  developer: 'Developer',
  correspondent: 'Correspondent',
}

/**
 * Roles an attempt can serve. A work run drafts documents and email drafts; a
 * developer's PR needs a coding run with a repo and a sandbox, which the attempt
 * gate does not start. The gate (auto-attempt.ts, ATTEMPTABLE_ROLES), the
 * breaker, the roster and the settings surface all read this one list.
 */
export const ATTEMPTABLE_WORK_ROLES: readonly WorkRole[] = ['researcher', 'writer', 'correspondent']

/** The run-boundary deliverable types an expectation can name (WorkDeliverable in agent-run/types.ts). */
export const WORK_EXPECT_TYPES = ['document', 'email_draft', 'action', 'entity'] as const
export type WorkExpectType = (typeof WORK_EXPECT_TYPES)[number]

/**
 * One expected artifact: "at least `min` deliverables of `type`" (`entity_type`
 * qualifies type 'entity', e.g. 'pr'). Validated against the run's sanitised
 * deliverables at settle (step 13); until then it is carried on the proposal
 * and the brief.
 */
export interface WorkExpectation {
  type: WorkExpectType
  min?: number
  entity_type?: string
}

export const WORK_EXPECTS_MAX = 4
export const WORK_EXPECT_MIN_CAP = 20
export const WORK_EXPECT_ENTITY_TYPE_MAX_CHARS = 40

/**
 * Normalise a model-authored `expects` value: keep only well-formed entries
 * (known type, integer min in [0, cap], short entity_type), at most
 * WORK_EXPECTS_MAX of them. Returns null when nothing survives, so a caller can
 * delete the key rather than store an empty list.
 */
export function normalizeWorkExpects(raw: unknown): WorkExpectation[] | null {
  if (!Array.isArray(raw)) return null
  const out: WorkExpectation[] = []
  for (const entry of raw) {
    if (out.length >= WORK_EXPECTS_MAX) break
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (typeof e.type !== 'string' || !(WORK_EXPECT_TYPES as readonly string[]).includes(e.type)) continue
    const item: WorkExpectation = { type: e.type as WorkExpectType }
    if (e.min !== undefined) {
      if (typeof e.min !== 'number' || !Number.isInteger(e.min) || e.min < 0) continue
      item.min = Math.min(e.min, WORK_EXPECT_MIN_CAP)
    }
    if (e.entity_type !== undefined) {
      if (typeof e.entity_type !== 'string' || !e.entity_type.trim()) continue
      item.entity_type = e.entity_type.trim().slice(0, WORK_EXPECT_ENTITY_TYPE_MAX_CHARS)
    }
    out.push(item)
  }
  return out.length > 0 ? out : null
}

/** The expectation each role implies when the proposal names none (§3.5). */
export const DEFAULT_EXPECTS_BY_ROLE: Readonly<Record<WorkRole, readonly WorkExpectation[]>> = Object.freeze({
  researcher: [{ type: 'document', min: 1 }],
  writer: [{ type: 'document', min: 1 }],
  developer: [{ type: 'entity', entity_type: 'pr', min: 1 }],
  correspondent: [{ type: 'email_draft', min: 1 }],
})

/**
 * Roles a work run may hand work to with `delegate_work` (Part 3). A delegated
 * child is a WORK run; a Developer's deliverable is a PR, which needs a coding
 * run (a project repo, an environment, the coding-agent mount), so a handoff to
 * the Developer is refused until delegation can start one.
 */
export const DELEGABLE_WORK_ROLES: readonly WorkRole[] = ['researcher', 'writer', 'correspondent']

const EXPECT_NOUNS: Record<WorkExpectType, [string, string]> = {
  document: ['document', 'documents'],
  email_draft: ['email draft', 'email drafts'],
  action: ['action', 'actions'],
  entity: ['item', 'items'],
}

/** "1 document", "2 email drafts", "1 pr". */
export function describeExpectation(e: WorkExpectation): string {
  const n = e.min ?? 1
  const [one, many] = e.type === 'entity' && e.entity_type ? [e.entity_type, e.entity_type] : EXPECT_NOUNS[e.type]
  return `${n} ${n === 1 ? one : many}`
}

/** The deliverable shape an expectation is checked against (the sanitised
 *  run-boundary deliverables: agent_run.deliverables). */
export interface ExpectableDeliverable {
  type: string
  entity_type?: string | null
}

/**
 * Did a run hand back what it was asked for? Each expectation needs at least
 * `min` (default 1) deliverables of its type; an `entity_type` narrows an
 * `entity` expectation. `unmet` names every expectation that fell short, in
 * words ("1 document"). No expectation (null or empty) is always met.
 */
export function evaluateExpects(
  expects: readonly WorkExpectation[] | null | undefined,
  deliverables: readonly ExpectableDeliverable[] | null | undefined,
): { met: boolean; unmet: string[] } {
  const unmet: string[] = []
  for (const e of expects ?? []) {
    const need = e.min ?? 1
    if (need <= 0) continue
    const have = (deliverables ?? []).filter(
      (d) => d.type === e.type && (!e.entity_type || d.entity_type === e.entity_type),
    ).length
    if (have < need) unmet.push(describeExpectation(e))
  }
  return { met: unmet.length === 0, unmet }
}
