/** Shared label types and utilities */

export type LabelScope = 'action' | 'email_thread' | 'project' | 'initiative' | 'capture'

export const ALL_LABEL_SCOPES: { value: LabelScope; label: string; short: string }[] = [
  { value: 'action', label: 'Actions', short: 'A' },
  { value: 'email_thread', label: 'Email', short: 'E' },
  { value: 'project', label: 'Projects', short: 'P' },
  { value: 'initiative', label: 'Initiatives', short: 'I' },
  { value: 'capture', label: 'Captures', short: 'C' },
]

export interface LabelWithScope {
  id: string
  name: string
  color: string
  group_name: string | null
  scopes: LabelScope[] | null
  created_at: string
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
