/**
 * How a card's rows are named in short form: the identifier where a record
 * has one (GEN-42) and its title. The same on both sides, so the rows the
 * client reports for the agent's note and the rows `show` and `read_card`
 * return read alike. Client-safe.
 */

export interface RowLabel {
  id: string
  identifier?: string
  title: string
}

const TITLE_KEYS = ['title', 'name', 'full_name', 'subject'] as const

/** A row's id, identifier and title, whatever its entity. */
export function rowLabel(row: Record<string, unknown>): RowLabel {
  const id = typeof row.id === 'string' ? row.id : String(row.id ?? '')
  const identifier = typeof row.identifier === 'string' && row.identifier ? row.identifier : undefined
  let title = ''
  for (const key of TITLE_KEYS) {
    const v = row[key]
    if (typeof v === 'string' && v.trim()) {
      title = v.trim()
      break
    }
  }
  return { id, ...(identifier ? { identifier } : {}), title: title || 'Untitled' }
}

/**
 * A row's field as the model reads it: a joined record by its name, a list of
 * them joined, a long text cut. Null when there is nothing there.
 */
export function compactValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'string') return value.length > 160 ? `${value.slice(0, 157)}…` : value
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    const items = value.map((v) => compactValue(v, depth + 1)).filter((v) => v !== null)
    return items.length ? items.slice(0, 10) : null
  }
  if (typeof value === 'object' && depth < 3) {
    const o = value as Record<string, unknown>
    for (const key of ['name', 'display_name', 'title', 'full_name', 'label', 'email']) {
      if (typeof o[key] === 'string' && o[key]) return o[key]
    }
    // A junction row (`labels: [{ label: { name } }]`, `assignees: [{ member }]`).
    const inner = Object.values(o).find((v) => v && typeof v === 'object')
    if (inner) return compactValue(inner, depth + 1)
    return typeof o.id === 'string' ? o.id : null
  }
  return null
}

/** Flatten a grouped result (`[{ items }]`) or a plain one into its rows, in order. */
export function flattenRows(data: unknown): Record<string, unknown>[] {
  if (!Array.isArray(data) || data.length === 0) return []
  const first = data[0] as Record<string, unknown>
  if (first && typeof first === 'object' && Array.isArray(first.items)) {
    const out: Record<string, unknown>[] = []
    for (const group of data as Array<{ items?: unknown[]; subGroups?: unknown[] }>) {
      if (Array.isArray(group.subGroups) && group.subGroups.length) out.push(...flattenRows(group.subGroups))
      else for (const item of group.items ?? []) out.push(item as Record<string, unknown>)
    }
    return out
  }
  return data as Record<string, unknown>[]
}
