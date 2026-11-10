/**
 * The compose panel's Jira oracle: what a create screen ACTUALLY takes.
 *
 * A Jira create screen is per project AND per issue type, and admins hide fields
 * from it and require custom fields on it freely. Guessing produces the two
 * failures this module exists to prevent:
 *  - offering a field that isn't on the screen → 400 "Field 'duedate' cannot be
 *    set. It is not on the appropriate screen, or unknown."
 *  - omitting a required custom field → a generic 400 that names a
 *    `customfield_10041` the user has never heard of.
 *
 * So the panel asks first. `GET /issue/createmeta/{project}/issuetypes/{typeId}`
 * returns exactly the fields on that screen, each with `required`,
 * `hasDefaultValue` and (for select-shaped fields) `allowedValues` — enough to
 * decide, synchronously and for every field at once, whether a create can be
 * composed at all.
 *
 * THE CLASSIFICATION (classifyCreateMeta below) is the load-bearing part, and
 * the three-way split is the standard integrator pattern rather than an
 * invention here — Zapier and Unito land on the same one, because the
 * alternatives are worse:
 *
 *  1. RENDERED — a field the panel knows how to collect: the natives it draws
 *     itself (assignee, priority, duedate, labels), plus any required custom
 *     field carrying `allowedValues`, which becomes a generic dropdown.
 *  2. SATISFIED — required, but Jira will fill it: `hasDefaultValue`. Nothing to
 *     ask, nothing to send, no reason to block.
 *  3. BLOCKING — required, no `allowedValues`, no default. Free text, cascading
 *     selects, sprint/epic pickers, JSM request types. There is no generic value
 *     to invent, so the panel DISABLES Create and deep-links to Jira's own
 *     create screen. Never create-and-pray: the create is known to fail, and
 *     failing after minting nothing is strictly better than a 400 the user
 *     cannot read.
 *
 * `priority` deserves its own note. It is a system field, but its valid values
 * are per priority-SCHEME since 2024, and the endpoint that lists them
 * (`/priority/search`) needs `manage:jira-configuration` — a scope Native Intelligence neither
 * holds nor should request for a dropdown. createmeta's `allowedValues` on the
 * priority field is the same answer, in scope, in a call the panel already makes.
 */
import type { JiraAllowedValue, JiraCreateMetaField } from '@/lib/integrations/jira-api'

/**
 * The natives the compose panel draws itself, so they are never treated as
 * unknown customs no matter what createmeta says about them.
 *
 * `summary` is here because the panel's title input IS the summary field, and
 * `project`/`issuetype` because they are the coordinates of the screen being
 * described rather than fields on it — a create always carries all three, so
 * none can ever be a blocker.
 */
const RENDERED_FIELD_IDS = new Set([
  'project',
  'issuetype',
  'summary',
  'description',
  'assignee',
  'priority',
  'duedate',
  'labels',
  'reporter',
])

/** One option in a dropdown the panel renders for a custom field. */
export interface ComposeOption {
  id: string
  /** `name` when Jira gave one, else `value`, else the id — never empty. */
  name: string
}

/** A required custom field the panel CAN collect, as a dropdown. */
export interface ComposeCustomField {
  field_id: string
  name: string
  required: boolean
  options: ComposeOption[]
}

/** A required field the panel cannot collect — the wall. */
export interface ComposeBlockingField {
  field_id: string
  name: string
  /** The schema type Jira reported, for the panel's explanatory line. */
  schema_type: string | null
}

/**
 * Everything the compose panel needs to render a Jira create form, and the one
 * response shape the compose-meta route returns.
 */
export interface JiraComposeMeta {
  /** Is `duedate` on this screen at all? Absent → hide the date input. */
  has_due_date: boolean
  /** Is `duedate` also required? Only meaningful when has_due_date. */
  due_date_required: boolean
  has_labels: boolean
  labels_required: boolean
  has_assignee: boolean
  assignee_required: boolean
  has_priority: boolean
  priority_required: boolean
  /** The priority field's allowedValues — the ONLY in-scope source. */
  priorities: ComposeOption[]
  /** Required customs the panel renders as dropdowns. */
  custom_fields: ComposeCustomField[]
  /**
   * Required fields with no allowedValues and no default. NON-EMPTY MEANS
   * CREATE IS DISABLED — the panel shows these names and links out.
   */
  blocking_fields: ComposeBlockingField[]
}

/** An allowedValue's display label, never empty. */
function optionName(value: JiraAllowedValue): string {
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  if (name) return name
  const label = typeof value.value === 'string' ? value.value.trim() : ''
  if (label) return label
  return value.id ?? ''
}

/** allowedValues → renderable options, dropping any entry with no id. */
function toOptions(values: JiraAllowedValue[] | undefined): ComposeOption[] {
  if (!Array.isArray(values)) return []
  const out: ComposeOption[] = []
  for (const value of values) {
    const id = value?.id
    if (typeof id !== 'string' || id.length === 0) continue
    // An option we cannot submit is worse than one we do not show: `{ id }` is
    // the only shape the create accepts, so a value with no id is unusable.
    out.push({ id, name: optionName(value) || id })
  }
  return out
}

/**
 * Fold one project+type's create-screen fields into the compose panel's form
 * description.
 *
 * Pure, so the route can cache its INPUT (the raw field list) and re-run this
 * cheaply, and so the classification is testable without a Jira in the loop.
 */
export function classifyCreateMeta(fields: JiraCreateMetaField[]): JiraComposeMeta {
  const byId = new Map<string, JiraCreateMetaField>()
  for (const field of fields) {
    const id = field?.fieldId
    if (typeof id === 'string' && id.length > 0) byId.set(id, field)
  }

  const custom_fields: ComposeCustomField[] = []
  const blocking_fields: ComposeBlockingField[] = []

  for (const [fieldId, field] of byId) {
    // Only REQUIRED unknowns matter. An optional custom field the panel doesn't
    // draw is simply left unset, which is what an optional field means.
    if (field.required !== true) continue
    if (RENDERED_FIELD_IDS.has(fieldId)) continue
    // Jira fills it — nothing to ask and nothing to block on.
    if (field.hasDefaultValue === true) continue

    const options = toOptions(field.allowedValues)
    const name =
      typeof field.name === 'string' && field.name.trim().length > 0 ? field.name.trim() : fieldId

    if (options.length > 0) {
      custom_fields.push({ field_id: fieldId, name, required: true, options })
    } else {
      blocking_fields.push({
        field_id: fieldId,
        name,
        schema_type: typeof field.schema?.type === 'string' ? field.schema.type : null,
      })
    }
  }

  const priority = byId.get('priority')
  const duedate = byId.get('duedate')
  const labels = byId.get('labels')
  const assignee = byId.get('assignee')

  return {
    has_due_date: !!duedate,
    due_date_required: duedate?.required === true,
    has_labels: !!labels,
    labels_required: labels?.required === true,
    has_assignee: !!assignee,
    assignee_required: assignee?.required === true,
    has_priority: !!priority,
    priority_required: priority?.required === true,
    priorities: toOptions(priority?.allowedValues),
    custom_fields,
    blocking_fields,
  }
}

/**
 * The native Jira create screen for a project+type, for the panel's link-out
 * when `blocking_fields` is non-empty.
 *
 * Returns null when the site url is unknown rather than emitting a broken link —
 * an absent "open in Jira" button is honest; one that 404s is not.
 */
export function nativeCreateIssueUrl(
  siteUrl: string | null | undefined,
  projectId: string,
  issueTypeId: string,
): string | null {
  if (!siteUrl) return null
  const params = new URLSearchParams({ pid: projectId, issuetype: issueTypeId })
  return `${siteUrl.replace(/\/$/, '')}/secure/CreateIssue.jspa?${params.toString()}`
}

// ---------------------------------------------------------------------------
// Server-side cache
// ---------------------------------------------------------------------------

/**
 * In-process cache of raw createmeta field lists, keyed workspace+project+type.
 *
 * Worth having and cheap: a create screen changes when an admin edits it, i.e.
 * roughly never, while the panel re-reads it every time it opens. An hour of
 * staleness costs at most one create rejected over a field that moved, and how
 * that surfaces depends on WHICH field: a stale priority or custom field is a
 * `push_failed` the user sees and can fix, while a stale `duedate`/`labels` is
 * absorbed by the push's strip-retry — the issue is created without it and the
 * loss is reported as `dropped_fields` on the successful result rather than as
 * a failure. Either way it is reported; neither is silent.
 *
 * IN-PROCESS, and deliberately not Redis or the database. It is a latency cache
 * for a read that is already authorized and already cheap, so a cold lambda
 * simply pays the round trip. Keyed by WORKSPACE as well as project+type because
 * two workspaces can reach the same Jira site with different permissions, and
 * createmeta is permission-filtered — sharing an entry across them would let one
 * workspace see a field the other's token cannot set.
 */
const CREATE_META_TTL_MS = 60 * 60 * 1000

const createMetaCache = new Map<string, { at: number; fields: JiraCreateMetaField[] }>()

export function createMetaCacheKey(
  workspaceId: string,
  cloudId: string,
  projectId: string,
  issueTypeId: string,
): string {
  return `${workspaceId}:${cloudId}:${projectId}:${issueTypeId}`
}

/** A cached field list that is still inside the TTL, or null. */
export function readCachedCreateMeta(key: string): JiraCreateMetaField[] | null {
  const hit = createMetaCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > CREATE_META_TTL_MS) {
    createMetaCache.delete(key)
    return null
  }
  return hit.fields
}

export function writeCachedCreateMeta(key: string, fields: JiraCreateMetaField[]): void {
  createMetaCache.set(key, { at: Date.now(), fields })
}

/** Test seam — the cache is module state and would otherwise leak across tests. */
export function clearCreateMetaCache(): void {
  createMetaCache.clear()
}
