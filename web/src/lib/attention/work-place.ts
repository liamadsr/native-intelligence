/**
 * Where a work card's Start runs: the place the person picks on the card
 * (components/attention/work-place-picker.tsx), sent with the Start as
 * `run_in` (PATCH /api/account/attention-items, settle-card.ts):
 *
 *   absent  a Native Intelligence work run: the workspace agent and its tools, as always;
 *   mac     one of the person's own shared folders on their Mac: the Native Intelligence
 *           agent there does it (environments start.ts startWorkOnMac);
 *   cloud   a shared cloud environment of the card's workspace, on a
 *           project's GitHub repo (a cloud environment holds no repos): a
 *           coding run (chat/cloud-coding-tools.ts startCardCodingRun).
 *
 * Only ids travel. The server checks each one again, as the person's own.
 */

export type WorkRunPlace = { kind: 'mac'; folder_id: string } | { kind: 'cloud'; environment_id: string; project_id: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)

/** A `run_in` as the place it names, or null when it isn't one. */
export function parseWorkRunPlace(v: unknown): WorkRunPlace | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (o.kind === 'mac' && isUuid(o.folder_id)) return { kind: 'mac', folder_id: o.folder_id }
  if (o.kind === 'cloud' && isUuid(o.environment_id) && isUuid(o.project_id)) {
    return { kind: 'cloud', environment_id: o.environment_id, project_id: o.project_id }
  }
  return null
}

/** Where a started card's work runs, as the Start's answer says it (the receipt). */
export type WorkRunWhere =
  | { kind: 'mac'; mac: string; folder: string; edits: boolean; session_id: string }
  | { kind: 'cloud'; environment: string; repo: string }
