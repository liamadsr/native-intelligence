/**
 * Which completed and canceled actions (or projects) a list shows: the
 * "Completed issues" / "Completed projects" row in a view's settings
 * (view-settings-popover.tsx), modelled on Linear's "Completed projects"
 * setting.
 *
 * - `past_day` / `past_week` / `past_month` / `past_year`: only the ones
 *   finished in that rolling window (24 hours, 7 days, one calendar month, one
 *   calendar year back from now). Actions offer day, week and month; projects
 *   week, month and year (COMPLETED_FILTER_OPTIONS_BY_ENTITY).
 * - `all`: every one, however old.
 * - `none`: none.
 * - `recent`: the setting's ONE older value (before 2026-11-20), kept so a view
 *   saved with it reads as it always did: the past 2 weeks (14 days). It is no
 *   longer offered for a new choice; the settings show it only on a view that
 *   still holds it.
 *
 * A NEW action list opens on `past_week` (DEFAULT_ACTION_COMPLETED_FILTER), a
 * new project list on `past_month` (DEFAULT_PROJECT_COMPLETED_FILTER; Linear's
 * own default is not documented). A SAVED view keeps exactly what it stores: a
 * view saved before this change with the old default `all` still shows all.
 *
 * A project is finished when its status is `completed` or `canceled`, and
 * when is `projects.completed_at` (migration 672's trigger).
 *
 * "Finished" is read from `actions.completed_at`, set by migration 672's
 * trigger when the status moves into a completed or canceled category (it was
 * `updated_at` before 672, which an edit to an old finished action moved):
 * see COMPLETED_AT_COLUMN in query-engine.ts.
 *
 * Storage. The view table's CHECK constraint (migration 039,
 * `view_completed_filter_check`) allows only `all`, `recent` and `none` until
 * migration 672 widens it. Until then a window is written as
 * `completed_filter = 'recent'` (the nearest value the old code understands)
 * with the exact window in `metadata.completed_window`, and read back from
 * there (completedFilterOfView). With 672 applied the column holds the window
 * itself (VIEW_COLUMN_TAKES_COMPLETED_WINDOWS) and the metadata key is only
 * read, for a view saved in between that 672 did not move.
 */

export const COMPLETED_WINDOWS = ['past_day', 'past_week', 'past_month', 'past_year'] as const
export type CompletedWindow = (typeof COMPLETED_WINDOWS)[number]

export const COMPLETED_FILTERS = [...COMPLETED_WINDOWS, 'all', 'none', 'recent'] as const
export type CompletedFilter = (typeof COMPLETED_FILTERS)[number]

/** What the view table's CHECK allows before migration 672. */
export const LEGACY_STORABLE_COMPLETED_FILTERS = ['all', 'recent', 'none'] as const

/** A new action list's setting. Saved views keep their own. */
export const DEFAULT_ACTION_COMPLETED_FILTER: CompletedFilter = 'past_week'

/** A new project list's setting (Linear's default is not documented). Saved views keep their own. */
export const DEFAULT_PROJECT_COMPLETED_FILTER: CompletedFilter = 'past_month'

/** The entities with a completed setting, and what a new list of each opens on. */
export function defaultCompletedFilterFor(entityType: string): CompletedFilter {
  if (entityType === 'action') return DEFAULT_ACTION_COMPLETED_FILTER
  if (entityType === 'project') return DEFAULT_PROJECT_COMPLETED_FILTER
  return 'all'
}

/** Does this entity's list take the completed setting? */
export function takesCompletedFilter(entityType: string): entityType is 'action' | 'project' {
  return entityType === 'action' || entityType === 'project'
}

/** The `metadata` key a window rides in while the column cannot hold it. */
export const COMPLETED_WINDOW_METADATA_KEY = 'completed_window'

/** The choices the settings offer, in order. `recent` is shown only where a view holds it. */
export const COMPLETED_FILTER_OPTIONS: ReadonlyArray<{ value: CompletedFilter; label: string }> = [
  { value: 'past_day', label: 'Past day' },
  { value: 'past_week', label: 'Past week' },
  { value: 'past_month', label: 'Past month' },
  { value: 'all', label: 'All' },
  { value: 'none', label: 'None' },
]

/** A project list's choices: Linear's "Completed projects" (past week, month, year, all, none). */
export const PROJECT_COMPLETED_FILTER_OPTIONS: ReadonlyArray<{ value: CompletedFilter; label: string }> = [
  { value: 'past_week', label: 'Past week' },
  { value: 'past_month', label: 'Past month' },
  { value: 'past_year', label: 'Past year' },
  { value: 'all', label: 'All' },
  { value: 'none', label: 'None' },
]

export const COMPLETED_FILTER_OPTIONS_BY_ENTITY = {
  action: COMPLETED_FILTER_OPTIONS,
  project: PROJECT_COMPLETED_FILTER_OPTIONS,
} as const

/** The settings row's name per entity. */
export const COMPLETED_FILTER_ROW_LABEL = { action: 'Completed issues', project: 'Completed projects' } as const

export const COMPLETED_FILTER_LABELS: Record<CompletedFilter, string> = {
  past_day: 'Past day',
  past_week: 'Past week',
  past_month: 'Past month',
  past_year: 'Past year',
  all: 'All',
  none: 'None',
  recent: 'Past 2 weeks',
}

export function isCompletedFilter(value: unknown): value is CompletedFilter {
  return typeof value === 'string' && (COMPLETED_FILTERS as readonly string[]).includes(value)
}

export function isCompletedWindow(value: unknown): value is CompletedWindow {
  return typeof value === 'string' && (COMPLETED_WINDOWS as readonly string[]).includes(value)
}

/** Anything unrecognised reads as `all`: the old behaviour, never fewer rows than asked for. */
export function normalizeCompletedFilter(value: unknown): CompletedFilter {
  return isCompletedFilter(value) ? value : 'all'
}

/**
 * The start of a filter's window (ISO), or null when it has none (`all`,
 * `none`). Rolling, from `now`: a day is 24 hours, a week 7 days, a month one
 * calendar month, `recent` 14 days (its meaning since migration 039).
 */
export function completedWindowStart(filter: CompletedFilter, now: Date = new Date()): string | null {
  const start = new Date(now.getTime())
  switch (filter) {
    case 'past_day':
      start.setTime(now.getTime() - 24 * 60 * 60 * 1000)
      break
    case 'past_week':
      start.setTime(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      break
    case 'recent':
      start.setTime(now.getTime() - 14 * 24 * 60 * 60 * 1000)
      break
    case 'past_month':
      start.setUTCMonth(start.getUTCMonth() - 1)
      break
    case 'past_year':
      start.setUTCFullYear(start.getUTCFullYear() - 1)
      break
    case 'all':
    case 'none':
      return null
  }
  return start.toISOString()
}

type ViewMetadata = Record<string, unknown> | null | undefined

function metadataObject(metadata: unknown): Record<string, unknown> {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? { ...(metadata as Record<string, unknown>) }
    : {}
}

/**
 * A saved view's setting. The column, unless it is `recent` and the metadata
 * names a window (a window saved while the column could not hold it). The
 * column wins otherwise: if older code later wrote `none` or `all` there, that
 * is the newer choice.
 */
export function completedFilterOfView(view: { completed_filter?: unknown; metadata?: unknown }): CompletedFilter {
  const column = normalizeCompletedFilter(view.completed_filter)
  if (column === 'recent') {
    const window = metadataObject(view.metadata)[COMPLETED_WINDOW_METADATA_KEY]
    if (isCompletedWindow(window)) return window
  }
  return column
}

/**
 * How a setting is written to the view table: the column value and the
 * metadata to write with it. `columnTakesWindows` is false until migration
 * 672 is applied (see the module comment).
 */
export function completedFilterForStorage(
  filter: unknown,
  metadata: ViewMetadata,
  { columnTakesWindows }: { columnTakesWindows: boolean },
): { completed_filter: CompletedFilter; metadata: Record<string, unknown> } {
  const value = normalizeCompletedFilter(filter)
  const meta = metadataObject(metadata)
  if (isCompletedWindow(value) && !columnTakesWindows) {
    return { completed_filter: 'recent', metadata: { ...meta, [COMPLETED_WINDOW_METADATA_KEY]: value } }
  }
  delete meta[COMPLETED_WINDOW_METADATA_KEY]
  return { completed_filter: value, metadata: meta }
}

/**
 * Whether the view table's column takes the windows: true since migration 672
 * widened its CHECK (REQUIRES 672 applied: before it, saving a window would
 * be refused by the constraint). A window saved in metadata before that is
 * still read (completedFilterOfView), and 672 moved those into the column.
 */
export const VIEW_COLUMN_TAKES_COMPLETED_WINDOWS = true
