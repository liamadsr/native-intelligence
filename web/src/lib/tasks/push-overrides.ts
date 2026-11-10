/**
 * Per-push destination overrides — the compose panel's half of the push contract.
 *
 * Until this module existed a push had exactly one destination: whatever
 * `task_sync_state.config` said, workspace-wide. That is still the DEFAULT and
 * still the whole story when nothing here is supplied — every function below is
 * written so that an absent or empty override is byte-identical to the old
 * behaviour, which is what lets the existing push tests keep passing untouched.
 *
 * What an override IS: a one-shot instruction attached to a single POST, chosen
 * in the compose panel and thrown away afterwards. It is never persisted (there
 * is no draft table and no new column — see the compose brief's zero-DDL rule),
 * never merged back into the workspace config, and never re-applied to a later
 * push of the same action.
 *
 * Two rules run through every provider's parser below and are the reason this is
 * a module rather than three inline `if` blocks:
 *
 *  1. UNKNOWN KEYS ARE REJECTED, not ignored. A compose panel that sends
 *     `assignee_id` to Jira (which wants `assignee_account_id`) has a bug, and a
 *     silently-dropped field would surface as "the assignee didn't stick" days
 *     later. A 400 naming the key is the cheap failure.
 *
 *  2. DEPENDENT FIELDS TRAVEL WITH THEIR PARENT. Overriding the parent container
 *     invalidates every id resolved under the config's own parent: a Jira issue
 *     type id is a per-project copy in team-managed projects, an Asana section
 *     gid belongs to one project, a Linear workflow state belongs to one team.
 *     So overriding the parent either carries its dependents explicitly or has
 *     them derived server-side — never inherited from the config, which is how
 *     you push an issue into project B with project A's issue type and get a
 *     400 nobody can read.
 *
 * Validation returns a discriminated result rather than throwing: the routes
 * turn `{ ok: false }` into `badRequest(...)`, and the AI tools turn the same
 * value into a tool error the model can correct on its next turn.
 */

/** A rejected override, carrying the message the caller renders verbatim. */
export interface OverrideParseFailure {
  ok: false
  error: string
}

export type OverrideParseResult<T> = { ok: true; value: T } | OverrideParseFailure

/**
 * Jira per-push overrides.
 *
 * `project_id` is the parent. Overriding it REQUIRES `issue_type_id`, because
 * issue types are project-local copies in team-managed projects — "Task" in one
 * project is a different id from "Task" in the next, and the config's id would
 * be rejected or, worse, silently resolve to an unrelated type.
 *
 * The SITE is deliberately not overridable in v1: `external_scope` on the link
 * row stores the config's cloud_id, every option route addresses one site, and a
 * cross-site compose would need its own token story. Compose stays within the
 * configured site.
 */
export interface JiraPushOverrides {
  /** Issue summary. Replaces the action's title, never appended to it. */
  title?: string
  /** Numeric project id as a string. Overriding it requires issue_type_id. */
  project_id?: string
  /** Display only — carried so the panel can label without a re-fetch. */
  project_key?: string
  issue_type_id?: string
  issue_type_name?: string
  /**
   * accountId ONLY. Never an email: Jira blanks `emailAddress` per the target
   * user's privacy setting while accountId is always populated, so email is
   * decorative in the picker and unusable as identity.
   *
   * NULL means CLEAR: push it unassigned rather than falling back to the
   * action's own Native Intelligence assignee via the email bridge. Absent still inherits.
   */
  assignee_account_id?: string | null
  /**
   * A priority id from compose-meta's `priority.allowedValues`. NOT from
   * /priority/search, which needs manage:jira-configuration — a scope Native Intelligence does
   * not hold and should not add for a dropdown.
   */
  priority_id?: string
  /**
   * Date-only `YYYY-MM-DD`. Only offered when compose-meta lists `duedate`.
   * NULL means CLEAR — no due date, rather than the action's own.
   */
  due_date?: string | null
  /** Freeform label strings. Only offered when compose-meta lists `labels`. */
  labels?: string[]
  /**
   * Required custom fields the panel rendered from their `allowedValues`, keyed
   * by fieldId (`customfield_10041`). The `{ id }` shape is Jira's own option
   * reference and is spread straight into the create's `fields` object.
   */
  custom_fields?: Record<string, { id: string }>
}

/**
 * Asana per-push overrides.
 *
 * `project_gid` is the parent, and overriding it SUPPRESSES the config's
 * section_map entirely rather than requiring a section: a section gid belongs to
 * exactly one project, so the mapped section for the action's lifecycle bucket
 * is meaningless in a different project. The task lands unsectioned in the
 * overridden project unless `section_gid` says otherwise — which is the honest
 * outcome, not a degraded one.
 *
 * NO priority: Asana has no native priority field (it is a per-project enum
 * custom field or nothing), so there is nothing to override.
 */
export interface AsanaPushOverrides {
  title?: string
  project_gid?: string
  project_name?: string
  /**
   * A section of `project_gid` (or of the config project when not overridden).
   * NULL means CLEAR: no section, rather than the config's section_map choice.
   */
  section_gid?: string | null
  /**
   * An Asana user gid. Bypasses the config path's email bridge entirely.
   * NULL means CLEAR — push it unassigned.
   */
  assignee_gid?: string | null
  /**
   * Date-only `YYYY-MM-DD`. Asana rejects `due_on` and `due_at` together and
   * clears one when the other is set, so an override sends `due_on` alone —
   * the compose panel collects a date, never a time. NULL means CLEAR.
   */
  due_on?: string | null
}

/**
 * Linear per-push overrides.
 *
 * `team_id` is the parent, and it is the one case where the dependent field is
 * DERIVED rather than required from the caller: the config's `state_map` names
 * workflow states of the CONFIG's team, and a state id from team A is not a
 * legal target on team B. Rather than make the panel collect a state (which the
 * v1 design does not expose at all), the push derives the overridden team's
 * not_started state server-side — see resolveLinearStartState in linear-push.ts.
 *
 * `priority` is Linear's static Int scale: 0 No priority, 1 Urgent, 2 High,
 * 3 Medium, 4 Low. Workspace-wide, with no per-team restriction to look up.
 */
export interface LinearPushOverrides {
  title?: string
  team_id?: string
  /**
   * A project associated with `team_id`. Linear projects are many-to-many with
   * teams, so this is not derivable from the team and is always an explicit pick.
   */
  project_id?: string | null
  /** NULL means CLEAR — push it unassigned rather than email-bridging. */
  assignee_id?: string | null
  /** 0-4 inclusive. */
  priority?: number
  /** Label UUIDs. Group labels (`isGroup: true`) are not applicable and are
   *  filtered out by the labels option route before the panel ever offers one. */
  label_ids?: string[]
  /** TimelessDate `YYYY-MM-DD`. NULL means CLEAR. */
  due_date?: string | null
}

// ---------------------------------------------------------------------------
// Shared field readers
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD`, and a real calendar date — `2026-02-31` is not one. */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/**
 * Every key a provider's override object may carry, used to reject the rest.
 *
 * Checked BEFORE the per-field reads so the error names the offending key rather
 * than reporting the first type mismatch of a payload that was wrong wholesale.
 */
function rejectUnknownKeys(
  source: Record<string, unknown>,
  allowed: readonly string[],
  provider: string,
): OverrideParseFailure | null {
  const unknown = Object.keys(source).filter((key) => !allowed.includes(key))
  if (unknown.length === 0) return null
  return {
    ok: false,
    error: `Unknown ${provider} override field(s): ${unknown.join(', ')}`,
  }
}

/**
 * A non-empty trimmed string, or a failure.
 *
 * An empty string is REJECTED rather than treated as absent: `{ title: '' }` is
 * a panel bug (the user cleared the field and the panel should have blocked
 * Create), and silently falling back to the action's title would hide it.
 */
function readString(
  source: Record<string, unknown>,
  key: string,
  provider: string,
): OverrideParseResult<string | undefined> {
  const value = source[key]
  if (value === undefined || value === null) return { ok: true, value: undefined }
  if (typeof value !== 'string') {
    return { ok: false, error: `\`${key}\` must be a string (${provider} override)` }
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return { ok: false, error: `\`${key}\` must not be empty (${provider} override)` }
  }
  return { ok: true, value: trimmed }
}

/**
 * Like readString, but `null` is a VALUE meaning "clear this / do not fall back".
 *
 * The distinction the plain reader cannot express. Absent means "inherit" — the
 * push falls back to the workspace config or to the action's own assignee and
 * due date, which is what an untouched panel must keep doing. But a user who
 * opens the panel, sees a prefilled project and picks "No project", or clears the
 * date input, is making a CHOICE, and folding it to absent silently reinstated
 * the value they had just removed: the issue landed in the config's project, or
 * carrying the action's due date and Native Intelligence assignee, while the form said
 * otherwise.
 *
 * Only the fields that have a fallback are clearable. Everything else keeps
 * readString, where an explicit null is still just absent.
 */
function readClearableString(
  source: Record<string, unknown>,
  key: string,
  provider: string,
): OverrideParseResult<string | null | undefined> {
  if (source[key] === null) return { ok: true, value: null }
  return readString(source, key, provider)
}

function readDate(
  source: Record<string, unknown>,
  key: string,
  provider: string,
): OverrideParseResult<string | undefined> {
  const read = readString(source, key, provider)
  if (!read.ok) return read
  if (read.value !== undefined && !isCalendarDate(read.value)) {
    return {
      ok: false,
      error: `\`${key}\` must be a YYYY-MM-DD date (${provider} override)`,
    }
  }
  return read
}

/** readDate with the same explicit-null-means-clear rule as readClearableString. */
function readClearableDate(
  source: Record<string, unknown>,
  key: string,
  provider: string,
): OverrideParseResult<string | null | undefined> {
  if (source[key] === null) return { ok: true, value: null }
  return readDate(source, key, provider)
}

/**
 * An array of non-empty strings, or a failure.
 *
 * An EMPTY ARRAY is legal and is preserved as `[]` — it means "this push carries
 * no labels", which is distinct from absent ("the panel did not offer labels")
 * only in that both produce the same create payload today. Kept distinguishable
 * anyway so a future "clear the config's labels" gesture has a value to send.
 */
function readStringArray(
  source: Record<string, unknown>,
  key: string,
  provider: string,
): OverrideParseResult<string[] | undefined> {
  const value = source[key]
  if (value === undefined || value === null) return { ok: true, value: undefined }
  if (!Array.isArray(value)) {
    return { ok: false, error: `\`${key}\` must be an array of strings (${provider} override)` }
  }
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') {
      return { ok: false, error: `\`${key}\` must be an array of strings (${provider} override)` }
    }
    const trimmed = entry.trim()
    if (trimmed.length === 0) {
      return { ok: false, error: `\`${key}\` must not contain empty strings (${provider} override)` }
    }
    out.push(trimmed)
  }
  return { ok: true, value: out }
}

/**
 * Parse a request body into `{ overrides }`, tolerating the three shapes a
 * legitimate caller produces for "no overrides": no body at all, an empty body,
 * and `{}`.
 *
 * This is the function that guarantees the byte-compatibility rule. Every
 * existing caller (the current PushToTrackerMenu, the AI tools, curl) sends a
 * POST with no body; all three land on `undefined` here and the push then takes
 * the exact code path it took before overrides existed.
 *
 * A body that is present but NOT parseable as JSON is a failure, not an absent
 * override: the caller meant to send something.
 */
export async function readOverridesBody(
  request: Request,
): Promise<OverrideParseResult<Record<string, unknown> | undefined>> {
  let text: string
  try {
    text = await request.text()
  } catch {
    // A body that cannot even be read is treated as absent rather than as an
    // error: there is nothing the caller can fix and the push still has a valid
    // config-driven destination.
    return { ok: true, value: undefined }
  }
  if (text.trim().length === 0) return { ok: true, value: undefined }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: 'Request body must be JSON' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Request body must be a JSON object' }
  }

  const body = parsed as Record<string, unknown>
  const unknownTop = Object.keys(body).filter((key) => key !== 'overrides')
  if (unknownTop.length > 0) {
    return { ok: false, error: `Unknown body field(s): ${unknownTop.join(', ')}` }
  }

  const overrides = body.overrides
  if (overrides === undefined || overrides === null) return { ok: true, value: undefined }
  if (typeof overrides !== 'object' || Array.isArray(overrides)) {
    return { ok: false, error: '`overrides` must be an object' }
  }
  const record = overrides as Record<string, unknown>
  // `{ overrides: {} }` is the panel opening and closing without touching a
  // field. Folded to absent so it takes the untouched config path rather than
  // an empty-merge path that would have to behave identically anyway.
  if (Object.keys(record).length === 0) return { ok: true, value: undefined }
  return { ok: true, value: record }
}

// ---------------------------------------------------------------------------
// Jira
// ---------------------------------------------------------------------------

const JIRA_OVERRIDE_KEYS = [
  'title',
  'project_id',
  'project_key',
  'issue_type_id',
  'issue_type_name',
  'assignee_account_id',
  'priority_id',
  'due_date',
  'labels',
  'custom_fields',
] as const

/**
 * The only key namespace `custom_fields` may use — Jira's own id form for a
 * custom field. Anything else is a SYSTEM field name, and jira-push's spread
 * would let it overwrite the destination rather than add to it.
 */
const CUSTOM_FIELD_KEY = /^customfield_\d+$/

export function parseJiraOverrides(
  raw: Record<string, unknown> | undefined,
): OverrideParseResult<JiraPushOverrides | undefined> {
  if (!raw) return { ok: true, value: undefined }

  const unknown = rejectUnknownKeys(raw, JIRA_OVERRIDE_KEYS, 'jira')
  if (unknown) return unknown

  const out: JiraPushOverrides = {}

  for (const key of [
    'title',
    'project_id',
    'project_key',
    'issue_type_id',
    'issue_type_name',
    'priority_id',
  ] as const) {
    const read = readString(raw, key, 'jira')
    if (!read.ok) return read
    if (read.value !== undefined) out[key] = read.value
  }

  // Clearable: these two have a FALLBACK the push applies when they are absent
  // (the action's Native Intelligence assignee via the email bridge; the action's own due
  // date), so "the user removed this" has to be expressible as something other
  // than absence — otherwise clearing the field silently reinstated it.
  const assignee = readClearableString(raw, 'assignee_account_id', 'jira')
  if (!assignee.ok) return assignee
  if (assignee.value !== undefined) out.assignee_account_id = assignee.value

  const due = readClearableDate(raw, 'due_date', 'jira')
  if (!due.ok) return due
  if (due.value !== undefined) out.due_date = due.value

  const labels = readStringArray(raw, 'labels', 'jira')
  if (!labels.ok) return labels
  if (labels.value !== undefined) out.labels = labels.value

  const custom = raw.custom_fields
  if (custom !== undefined && custom !== null) {
    if (typeof custom !== 'object' || Array.isArray(custom)) {
      return { ok: false, error: '`custom_fields` must be an object (jira override)' }
    }
    const fields: Record<string, { id: string }> = {}
    for (const [fieldId, value] of Object.entries(custom as Record<string, unknown>)) {
      // The KEY is validated before the value, and the namespace is closed to
      // Jira's own `customfield_<n>` form. jira-push spreads this record LAST
      // into `fields`, after `project` and `issuetype` — and `{ id }` is exactly
      // the shape it writes for both — so an entry keyed `project` would not be
      // a custom field at all, it would REPLACE the destination the
      // dependent-field wall below has just validated, landing the issue in an
      // unrelated project while the link row records an ordinary push. Every
      // entry the compose panel produces is keyed by a fieldId of this form, so
      // closing the namespace costs nothing legitimate.
      if (!CUSTOM_FIELD_KEY.test(fieldId)) {
        return {
          ok: false,
          error:
            `\`custom_fields.${fieldId}\` is not a Jira custom field id ` +
            '(expected `customfield_<n>`) (jira override)',
        }
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {
          ok: false,
          error: `\`custom_fields.${fieldId}\` must be an object of the form { id } (jira override)`,
        }
      }
      const id = (value as { id?: unknown }).id
      // ONLY `{ id }` is accepted, deliberately. Every custom field the compose
      // panel renders is an allowedValues dropdown, and Jira identifies an
      // allowed value by id; accepting a bare string or a `{ value }` form would
      // let a free-text field through the wall this shape exists to enforce.
      if (typeof id !== 'string' || id.trim().length === 0) {
        return {
          ok: false,
          error: `\`custom_fields.${fieldId}.id\` must be a non-empty string (jira override)`,
        }
      }
      const extra = Object.keys(value as Record<string, unknown>).filter((k) => k !== 'id')
      if (extra.length > 0) {
        return {
          ok: false,
          error: `\`custom_fields.${fieldId}\` accepts only \`id\` (jira override)`,
        }
      }
      fields[fieldId] = { id: id.trim() }
    }
    out.custom_fields = fields
  }

  // The dependent-field rule. Rejected HERE rather than at the create, because
  // Jira's own rejection ("issue type is not valid for project") is a 400 whose
  // message names neither the config nor the override, and the user cannot tell
  // which of their two choices was wrong.
  if (out.project_id && !out.issue_type_id) {
    return {
      ok: false,
      error:
        'Overriding `project_id` requires `issue_type_id` — Jira issue types are ' +
        'per-project copies, so the configured type is not valid in another project.',
    }
  }

  // The same rule pointed the other way, for the DISPLAY-ONLY halves. Nothing
  // downstream reads `project_key` or `issue_type_name` — the push selects on
  // the ids — so one arriving alone is a silently-dropped field, which is
  // precisely what rule #1 refuses to do for unknown keys. Sending
  // `{ project_key: 'PLAT' }` and expecting a retarget is a natural misreading
  // (Jira's own APIs accept a project by key), and it would otherwise answer
  // 201 with the issue in the configured project. The panel always pairs them.
  if (out.project_key && !out.project_id) {
    return {
      ok: false,
      error:
        '`project_key` is display-only and must accompany `project_id` (jira override)',
    }
  }
  if (out.issue_type_name && !out.issue_type_id) {
    return {
      ok: false,
      error:
        '`issue_type_name` is display-only and must accompany `issue_type_id` (jira override)',
    }
  }

  return { ok: true, value: Object.keys(out).length > 0 ? out : undefined }
}

// ---------------------------------------------------------------------------
// Asana
// ---------------------------------------------------------------------------

const ASANA_OVERRIDE_KEYS = [
  'title',
  'project_gid',
  'project_name',
  'section_gid',
  'assignee_gid',
  'due_on',
] as const

export function parseAsanaOverrides(
  raw: Record<string, unknown> | undefined,
): OverrideParseResult<AsanaPushOverrides | undefined> {
  if (!raw) return { ok: true, value: undefined }

  const unknown = rejectUnknownKeys(raw, ASANA_OVERRIDE_KEYS, 'asana')
  if (unknown) return unknown

  const out: AsanaPushOverrides = {}
  for (const key of ['title', 'project_gid', 'project_name'] as const) {
    const read = readString(raw, key, 'asana')
    if (!read.ok) return read
    if (read.value !== undefined) out[key] = read.value
  }

  // Clearable, for the same reason as Jira's pair: absent means the push applies
  // the config's section_map and the action's own assignee/due date.
  for (const key of ['section_gid', 'assignee_gid'] as const) {
    const read = readClearableString(raw, key, 'asana')
    if (!read.ok) return read
    if (read.value !== undefined) out[key] = read.value
  }

  const due = readClearableDate(raw, 'due_on', 'asana')
  if (!due.ok) return due
  if (due.value !== undefined) out.due_on = due.value

  // Display-only, same rule as Jira's project_key: asana-push selects on
  // `project_gid` and never reads the name, so a lone `project_name` would land
  // the task in the CONFIGURED project and still answer 201. The panel pairs it.
  if (out.project_name && !out.project_gid) {
    return {
      ok: false,
      error: '`project_name` is display-only and must accompany `project_gid` (asana override)',
    }
  }

  return { ok: true, value: Object.keys(out).length > 0 ? out : undefined }
}

// ---------------------------------------------------------------------------
// Linear
// ---------------------------------------------------------------------------

const LINEAR_OVERRIDE_KEYS = [
  'title',
  'team_id',
  'project_id',
  'assignee_id',
  'priority',
  'label_ids',
  'due_date',
] as const

/** Linear's fixed priority scale — 0 No priority … 4 Low. */
export const LINEAR_PRIORITY_MIN = 0
export const LINEAR_PRIORITY_MAX = 4

export function parseLinearOverrides(
  raw: Record<string, unknown> | undefined,
): OverrideParseResult<LinearPushOverrides | undefined> {
  if (!raw) return { ok: true, value: undefined }

  const unknown = rejectUnknownKeys(raw, LINEAR_OVERRIDE_KEYS, 'linear')
  if (unknown) return unknown

  const out: LinearPushOverrides = {}
  for (const key of ['title', 'team_id'] as const) {
    const read = readString(raw, key, 'linear')
    if (!read.ok) return read
    if (read.value !== undefined) out[key] = read.value
  }

  // Clearable: absent, the push falls back to the config's project (when the
  // team is unchanged) and to the action's Native Intelligence assignee. "No project" and
  // "Unassigned" are real picks in the panel and must not read as absence.
  for (const key of ['project_id', 'assignee_id'] as const) {
    const read = readClearableString(raw, key, 'linear')
    if (!read.ok) return read
    if (read.value !== undefined) out[key] = read.value
  }

  const priority = raw.priority
  if (priority !== undefined && priority !== null) {
    if (
      typeof priority !== 'number' ||
      !Number.isInteger(priority) ||
      priority < LINEAR_PRIORITY_MIN ||
      priority > LINEAR_PRIORITY_MAX
    ) {
      return {
        ok: false,
        error:
          `\`priority\` must be an integer ${LINEAR_PRIORITY_MIN}-${LINEAR_PRIORITY_MAX} ` +
          '(0 No priority, 1 Urgent, 2 High, 3 Medium, 4 Low) (linear override)',
      }
    }
    out.priority = priority
  }

  const labels = readStringArray(raw, 'label_ids', 'linear')
  if (!labels.ok) return labels
  if (labels.value !== undefined) out.label_ids = labels.value

  const due = readClearableDate(raw, 'due_date', 'linear')
  if (!due.ok) return due
  if (due.value !== undefined) out.due_date = due.value

  return { ok: true, value: Object.keys(out).length > 0 ? out : undefined }
}
