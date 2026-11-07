/**
 * The area a unit of background work belongs to, and the face that shows it
 * (docs/plans/one-agent-and-chat-pages.md, Part 3 "Faces", decision 9;
 * migration 318).
 *
 * Every ledger row (`tracked_job.area`) and every bot notice
 * (`metadata.area`) records its area: one of the 16 area keys of the pack
 * registry, or null for work with none. The face is chosen from the area:
 * each area that has background work has a system teammate keyed by it
 * (AREA_FACE_KEYS: Captures, Mail, Prospecting, Evals, CRM), and the
 * Assistant stays the main agent's face and the face of work with no area,
 * or an area with no face of its own yet. Because the area is on the work
 * itself, moving to one face for everything later is a change to how faces
 * are picked, not a data migration.
 *
 * Who writes what:
 *   - kinds whose area is fixed (KIND_AREAS): the extraction pass, the
 *     triage reconciler and the proposal age-out are Captures'; the email
 *     pass and the mail import are Mail's; prospecting, evals, enrichment and
 *     the CRM import their own areas; sequence sends Sequences' (they keep no
 *     bot, but their area is still certain).
 *   - a loop run: its skills' area, when they agree on one (the seeded Triage
 *     and Commitment reconciler loops are Captures'); a work run: the same,
 *     through its loop. The writer passes it (StartWorkInput.area).
 *   - everything else: null.
 *
 * Pure (no server imports), so the client and the server share it.
 */
import { isAreaKey, type AreaKey } from '@/lib/packs/registry'

/** The areas with a face of their own: a system teammate keyed by the area (migration 318). */
export const AREA_FACE_KEYS = ['captures', 'mail', 'prospecting', 'evals', 'crm'] as const satisfies readonly AreaKey[]
export type AreaFaceKey = (typeof AREA_FACE_KEYS)[number]

const AREA_FACE_SET: ReadonlySet<string> = new Set(AREA_FACE_KEYS)

export function isAreaFaceKey(value: unknown): value is AreaFaceKey {
  return typeof value === 'string' && AREA_FACE_SET.has(value)
}

/** The area's face key, or null for an area whose work the Assistant shows. */
export function areaFaceKey(area: string | null | undefined): AreaFaceKey | null {
  return isAreaFaceKey(area) ? area : null
}

/**
 * Kinds of work whose area never varies (WORK_KINDS' spellings). A kind not
 * here (a loop run, a work run, a skill run, a coding run, onboarding
 * research) takes its area from its writer, or has none.
 */
export const KIND_AREAS: Readonly<Record<string, AreaKey>> = {
  extraction: 'captures',
  triage_reconcile: 'captures',
  proposal_age_out: 'captures',
  email_drafts: 'mail',
  email_import: 'mail',
  prospecting: 'prospecting',
  eval: 'evals',
  crm_enrichment: 'crm',
  crm_import: 'crm',
  sequence_enrolment: 'sequences',
}

/** The area a new row records: the writer's, else its kind's, else null. */
export function workArea(kind: string, explicit?: string | null): AreaKey | null {
  if (isAreaKey(explicit)) return explicit
  return Object.hasOwn(KIND_AREAS, kind) ? KIND_AREAS[kind] : null
}

/** The one area some areas agree on (a loop's skills), else null: none, or more than one. */
export function singleArea(areas: Iterable<string | null | undefined>): AreaKey | null {
  let only: AreaKey | null = null
  for (const a of areas) {
    if (!isAreaKey(a)) continue
    if (only && only !== a) return null
    only = a
  }
  return only
}
