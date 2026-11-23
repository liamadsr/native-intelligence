/**
 * Filter values a page supplies itself, for a view kind whose rows are not a
 * table the filter picker can query (docs/plans/github-reviews.md: the
 * Reviews page's repositories, authors, assignees and labels, read live from
 * GitHub). A field names its source as `local:<key>`
 * (FilterFieldDefinition.options); the page sets the values it has on
 * screen, and the shared value picker (filters/filter-value-picker.tsx)
 * offers them. Client-safe, module-level, per tab.
 */
const values = new Map<string, readonly string[]>()

export const LOCAL_ENUM_PREFIX = 'local:'

/** The values offered for `key` (`github_pr.repo`), sorted. */
export function localEnumOptions(key: string): readonly string[] {
  return values.get(key) ?? []
}

/** Set the values a page has for `key`, deduplicated and sorted. */
export function setLocalEnumOptions(key: string, next: Iterable<string>): void {
  values.set(key, [...new Set([...next].filter((v) => typeof v === 'string' && v.length > 0))].sort((a, b) => a.localeCompare(b)))
}
