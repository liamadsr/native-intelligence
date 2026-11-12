/**
 * Checking a `show` for one of the page kinds (./pages.ts) before anything is
 * read. Pure, like ./validate.ts: the target is a name or an id the server
 * resolves later (./page-server.ts), where the workspace and what the person
 * may see are known.
 *
 * Every refusal names the one thing to change (#669: weak models misplace
 * fields), and the obvious slips are fixed rather than refused: a case slip
 * in a tab, `skills` for the library's skills tab, a target on a page that
 * takes none when it is empty.
 */
import type { CardFilter } from './kinds'
import { PAGE_KINDS, PLACE_NOUN, isPageKind, type PageKind } from './pages'
import { checkFilter, type Checked } from './validate'

/** The raw input `show` hands over for a page kind. */
export interface PageShowInput {
  kind?: string
  title?: string
  target?: unknown
  tab?: unknown
  filters?: Array<{ field?: unknown; operator?: unknown; value?: unknown }>
}

/** A page card asked for, its target not yet found. */
export interface CheckedPageInput {
  kind: PageKind
  title: string
  /** The target as the agent named it: an id or a name. */
  target?: string
  tab?: string
  filters?: CardFilter[]
}

/** Where the agent finds the id for each kind's target, for a refusal. */
export const TARGET_SOURCE: Partial<Record<PageKind, string>> = {
  team_board: 'get_workspace lists the teams',
  teams: 'get_workspace lists the teams',
  sequences: 'list_sequences',
  prospecting: 'list_prospect_lists',
  evals: 'list_evals',
  knowledge: 'list_packages',
  library: 'list_agents or list_skills',
  studio: 'list_studio_projects lists the Studio projects and their videos',
}

const MAX_FILTERS = 12

function targetNoun(kind: PageKind): string {
  const types = PAGE_KINDS[kind].target?.types ?? []
  return types.map((t) => PLACE_NOUN[t]).join(' or ')
}

/** The page asked for, checked; or the one thing to fix. */
export function normalizePageInput(input: PageShowInput): Checked<CheckedPageInput> {
  const kind = typeof input.kind === 'string' ? input.kind.trim().toLowerCase() : ''
  if (!isPageKind(kind)) return { ok: false, error: `kind: '${String(input.kind)}' is not a page` }
  const def = PAGE_KINDS[kind]
  if (def.personOnly) {
    return { ok: false, error: `kind: only the person opens a ${def.label.toLowerCase()}. To answer about a teammate's work, call list_bot_work` }
  }
  const title = typeof input.title === 'string' ? input.title.replace(/\s+/g, ' ').trim().slice(0, 120) : ''
  if (!title) return { ok: false, error: `title: give the card a short title that says what it shows, e.g. "${def.label}"` }

  // The target: an id or a name, for the kinds that take one.
  const rawTarget = typeof input.target === 'string' ? input.target.trim() : input.target == null ? '' : null
  if (rawTarget === null) {
    return { ok: false, error: `target: give the ${targetNoun(kind) || 'target'}'s name or id as text` }
  }
  if (rawTarget && !def.target) {
    return { ok: false, error: `target: ${kind} opens the whole ${def.label} page and takes no target. Leave target out` }
  }
  if (!rawTarget && def.target?.required) {
    return {
      ok: false,
      error: `target: a ${def.label.toLowerCase()} needs its ${targetNoun(kind)}: give its name or id${TARGET_SOURCE[kind] ? ` (${TARGET_SOURCE[kind]})` : ''}`,
    }
  }

  // The tab: one of the kind's own, a case slip forgiven.
  let tab: string | undefined
  if (input.tab !== undefined && input.tab !== null && input.tab !== '') {
    const wanted = String(input.tab).trim().toLowerCase()
    if (!def.tabs) return { ok: false, error: `tab: ${kind} has no tabs. Leave tab out` }
    const hit = def.tabs.find((t) => t === wanted || `${t}s` === wanted || t === `${wanted}s`)
    if (!hit) return { ok: false, error: `tab: ${kind} has the tabs ${def.tabs.join(', ')}. Use one of them, or leave tab out for ${def.tabs[0]}` }
    tab = hit
  }
  // An eval suite's cases and runs are inside a suite.
  if (kind === 'evals' && tab && tab !== 'overview' && !rawTarget) {
    return { ok: false, error: `tab: '${tab}' is inside an eval suite. Give target, the suite's name or id, or leave tab out for the list of suites` }
  }
  if (kind === 'evals' && tab === 'overview' && !rawTarget) tab = undefined
  // A Studio tab is a view of one video: the overview is the page's own top level.
  if (kind === 'studio' && tab && tab !== 'overview' && !rawTarget) {
    return { ok: false, error: `tab: '${tab}' is a view of one video. Give target, the video's title or id, or leave tab out for the Studio` }
  }
  if (kind === 'studio' && tab === 'overview' && !rawTarget) tab = undefined
  // Knowledge's packages live on its library tab.
  if (kind === 'knowledge' && rawTarget) tab = 'library'

  // Filters: the team board's alone, on its actions.
  let filters: CardFilter[] | undefined
  const rawFilters = input.filters ?? []
  if (!Array.isArray(rawFilters)) return { ok: false, error: 'filters takes a list of {field, operator, value}' }
  if (rawFilters.length > 0) {
    if (kind !== 'team_board') {
      return {
        ok: false,
        error: `filters: ${kind} opens the ${def.label} page as it is and takes no filters. Leave them out (the person can filter it on the card)`,
      }
    }
    if (rawFilters.length > MAX_FILTERS) return { ok: false, error: `filters: at most ${MAX_FILTERS}` }
    filters = []
    for (const [i, f] of rawFilters.entries()) {
      const checked = checkFilter('action', f ?? {}, `filters[${i}]`)
      if (!checked.ok) return checked
      filters.push(checked.value)
    }
  }

  return {
    ok: true,
    value: {
      kind,
      title,
      ...(rawTarget ? { target: rawTarget } : {}),
      ...(tab ? { tab } : {}),
      ...(filters ? { filters } : {}),
    },
  }
}
