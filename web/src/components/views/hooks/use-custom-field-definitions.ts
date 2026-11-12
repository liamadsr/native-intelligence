'use client'

/**
 * The active workspace's custom field definitions for one kind, for the view
 * chrome: the filter picker, the filter chips and summaries, the settings
 * popover's sort / group / column lists and the custom column cells.
 *
 * One GET /api/account/custom-fields?entity_type=<kind> per workspace and
 * kind, shared by every surface through a module cache (the way
 * use-picker-context and use-flow-status-ids share theirs), and only when a
 * surface asks: callers pass `enabled` so a list with no custom filter, sort
 * or column never fetches at all. An entry is reused for CACHE_TTL_MS, then
 * read again on the next mount (a field the agent defined in chat shows up
 * the next time a picker opens), and dropped at once on
 * CUSTOM_FIELDS_CHANGED_EVENT, which the add-a-field form fires.
 *
 * A kind that takes no fields (the registry's `customFields` flag), no active
 * workspace yet, or a failed read is an empty list: nothing custom is drawn.
 */
import * as React from 'react'
import { useWorkspaceId } from '@/app/account/workspace-switcher'
import {
  CUSTOM_FIELDS_CHANGED_EVENT,
  viewTakesCustomFields,
  type CustomFieldColumnDefinition,
} from '@/lib/views/custom-field-columns'
import type { ViewEntityType } from '@/lib/views/types'

const CACHE_TTL_MS = 30_000

interface Entry {
  at: number
  promise: Promise<CustomFieldColumnDefinition[]>
  value: CustomFieldColumnDefinition[] | null
}

const cache = new Map<string, Entry>()
const EMPTY: CustomFieldColumnDefinition[] = []

function isDefinition(v: unknown): v is CustomFieldColumnDefinition {
  if (!v || typeof v !== 'object') return false
  const d = v as Record<string, unknown>
  return typeof d.key === 'string' && typeof d.label === 'string' && typeof d.field_type === 'string'
}

async function fetchDefinitions(entityType: string): Promise<CustomFieldColumnDefinition[]> {
  try {
    const res = await fetch(`/api/account/custom-fields?entity_type=${encodeURIComponent(entityType)}`)
    if (!res?.ok) return EMPTY
    const json = (await res.json()) as { fields?: unknown }
    if (!Array.isArray(json?.fields)) return EMPTY
    return json.fields.filter(isDefinition).map((d) => ({
      key: d.key,
      label: d.label,
      field_type: d.field_type,
      options: Array.isArray(d.options) ? d.options.filter((o): o is string => typeof o === 'string') : [],
      // A relation's target, so its filter can pick records.
      ...(d.config && typeof d.config === 'object' ? { config: d.config } : {}),
    }))
  } catch {
    return EMPTY
  }
}

function load(cacheKey: string, entityType: string): Entry {
  const hit = cache.get(cacheKey)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit
  const entry: Entry = { at: Date.now(), value: hit?.value ?? null, promise: Promise.resolve(EMPTY) }
  entry.promise = fetchDefinitions(entityType).then((defs) => {
    entry.value = defs
    return defs
  })
  cache.set(cacheKey, entry)
  return entry
}

/**
 * Definitions a page already holds for one kind, handed to every view
 * surface under it in place of a read: a table's page gives its columns
 * (a table's rows take no workspace definitions, only their table's).
 */
export const CustomFieldDefinitionsContext = React.createContext<{ entityType: ViewEntityType; defs: CustomFieldColumnDefinition[] } | null>(null)

export function useCustomFieldDefinitions(entityType: ViewEntityType, enabled = true): CustomFieldColumnDefinition[] {
  const workspaceId = useWorkspaceId()
  const provided = React.useContext(CustomFieldDefinitionsContext)
  const given = provided?.entityType === entityType ? provided.defs : null
  const active = !given && enabled && !!workspaceId && viewTakesCustomFields(entityType) && entityType !== 'data_row'
  const cacheKey = `${workspaceId ?? ''}:${entityType}`
  const [state, setState] = React.useState<{ key: string; defs: CustomFieldColumnDefinition[] }>(() => ({
    key: cacheKey,
    defs: (active && cache.get(cacheKey)?.value) || EMPTY,
  }))
  const [generation, setGeneration] = React.useState(0)

  React.useEffect(() => {
    if (!active) return
    let cancelled = false
    const entry = load(cacheKey, entityType)
    if (entry.value) setState({ key: cacheKey, defs: entry.value })
    void entry.promise.then((defs) => {
      if (!cancelled) setState({ key: cacheKey, defs })
    })
    return () => {
      cancelled = true
    }
  }, [active, cacheKey, entityType, generation])

  React.useEffect(() => {
    if (!active) return
    const onChanged = () => {
      cache.clear()
      setGeneration((g) => g + 1)
    }
    window.addEventListener(CUSTOM_FIELDS_CHANGED_EVENT, onChanged)
    return () => window.removeEventListener(CUSTOM_FIELDS_CHANGED_EVENT, onChanged)
  }, [active])

  if (given) return given
  if (!active || state.key !== cacheKey) return EMPTY
  return state.defs
}

/** Test seam: forget everything between tests. */
export function __resetCustomFieldDefinitionsCache() {
  cache.clear()
}
