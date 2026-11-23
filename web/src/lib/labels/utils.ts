/** Shared label types and utilities */

import { TAGGABLE, TAG_KINDS, type TagKind } from '@/lib/tags/kinds'

/** A kind of record a label (tag) is offered on: every kind that takes tags (lib/tags/kinds.ts). */
export type LabelScope = TagKind

/** Every kind a tag can be scoped to, in the order the settings list them. */
export const ALL_LABEL_SCOPES: { value: LabelScope; label: string; short: string }[] = TAG_KINDS.map((k) => ({
  value: k,
  label: TAGGABLE[k].noun[1],
  short: TAGGABLE[k].noun[0].slice(0, 2),
}))

export interface LabelWithScope {
  id: string
  name: string
  color: string
  group_name: string | null
  scopes: LabelScope[] | null
  created_at: string
  /** A personal tag: only its owner sees it (label.owner_user_id, migration 700). Absent on older responses. */
  personal?: boolean
}

export interface LabelGroup {
  groupName: string | null
  labels: LabelWithScope[]
}

/**
 * Groups a flat list of labels by their group_name.
 * Named groups come first (sorted alphabetically), ungrouped labels last.
 */
export function groupLabelsByGroupName(labels: LabelWithScope[]): LabelGroup[] {
  const grouped = new Map<string | null, LabelWithScope[]>()

  for (const label of labels) {
    const key = label.group_name || null
    const existing = grouped.get(key)
    if (existing) {
      existing.push(label)
    } else {
      grouped.set(key, [label])
    }
  }

  const result: LabelGroup[] = []

  // Named groups first, sorted alphabetically
  const namedKeys = Array.from(grouped.keys())
    .filter((k): k is string => k !== null)
    .sort((a, b) => a.localeCompare(b))

  for (const key of namedKeys) {
    result.push({ groupName: key, labels: grouped.get(key)! })
  }

  // Ungrouped labels last
  const ungrouped = grouped.get(null)
  if (ungrouped) {
    result.push({ groupName: null, labels: ungrouped })
  }

  return result
}

/**
 * Check if a label is visible for a given scope.
 * NULL scopes = visible everywhere.
 */
export function labelMatchesScope(label: LabelWithScope, scope: LabelScope): boolean {
  if (!label.scopes || label.scopes.length === 0) return true
  return label.scopes.includes(scope)
}
