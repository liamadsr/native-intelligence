/**
 * The provider LENS contract: one normalized shape for "what does the linked
 * ticket look like right now", plus the parser for the edits sent back.
 *
 * WHY A SHARED SHAPE AT ALL. The properties panel wants to render chips —
 * assignee, priority, due date, labels, and a few read-only coordinates — and it
 * wants to render them the same way whichever provider is behind them. Jira,
 * Asana and Linear disagree about almost every detail of those five fields:
 * labels are bare strings in Jira, gid-bearing tag objects in Asana and UUID
 * label objects in Linear; priority is a per-scheme option id in Jira, a fixed
 * 0-4 integer in Linear and does not exist in Asana; "project" is one object in
 * Jira, an array membership in Asana and an optional refinement in Linear. Every
 * one of those differences is real, and every one of them is the collector's
 * problem rather than the panel's — which is the same division of labour the
 * task-destinations route already drew for "where can this push go".
 *
 * WHY READ-THROUGH, NO CACHE. Every value here is fetched live when the lens
 * mounts and re-read after a write. There is deliberately no cross-request cache:
 * the only cached provider read in this codebase (task-destinations, a 60s SWR
 * window with no invalidation) shipped a bug where the push menu kept saying
 * "configure in settings" after the user had configured it, and the fix was two
 * moving parts — an invalidate call and a change event — wired into every write
 * funnel. A lens over four editable fields across three providers would need that
 * wiring on every one of them, plus the webhook read-back, plus unlink. Reading
 * live has one moving part and cannot go stale.
 *
 * WHAT IS NOT HERE. Status/state is READ-ONLY in the lens and is never written.
 * It already has an owner — the Native Intelligence→provider status echo (`*EchoStatus`) — and
 * a second write path racing it would fight the CAS loop-breaker the read-back
 * depends on. Project/issue-type/team moves are excluded for a different reason:
 * they rewrite identifiers, need field re-mapping wizards on Jira's side, and
 * invalidate the team-scoped ids the whole destination config is built from.
 */

/** The three providers a lens can be opened on. */
export const LENS_PROVIDERS = ['asana', 'jira', 'linear'] as const

export type LensProvider = (typeof LENS_PROVIDERS)[number]

export function isLensProvider(value: unknown): value is LensProvider {
  return typeof value === 'string' && (LENS_PROVIDERS as readonly string[]).includes(value)
}

/**
 * An id+name pair — the only shape a lens chip renders.
 *
 * `id` is always what a write would submit and `name` always what the chip
 * displays, which is why Jira's plain-string labels arrive here with `id === name`
 * rather than being special-cased in the UI: a label whose identity IS its text
 * is still an id, and flattening that here keeps one chip component for all three
 * providers.
 */
export interface LensRef {
  id: string
  name: string
}

/**
 * The fields a lens renders, normalized across providers.
 *
 * Every key is present on every provider's response, `null` where the provider
 * has no such concept (Asana priority, Jira team, Linear issue type) — absent
 * keys would make the UI branch on provider identity to know what to expect,
 * which is exactly what this shape exists to avoid.
 */
export interface LensFields {
  /** Jira project / Asana first project membership / Linear project. */
  project: LensRef | null
  /** Jira only. */
  issue_type: LensRef | null
  /** Linear only. */
  team: LensRef | null
  /** Asana only — the first membership's section. */
  section: LensRef | null
  assignee: LensRef | null
  /** Jira: priority id+name. Linear: '0'..'4' + canonical name. Asana: null. */
  priority: LensRef | null
  /** `YYYY-MM-DD`. */
  due_date: string | null
  labels: LensRef[]
}

/** Which of the four writable fields this provider+ticket will actually accept. */
export interface LensEditable {
  assignee: boolean
  priority: boolean
  due_date: boolean
  labels: boolean
}

/**
 * The scope ids the UI's option pickers need to call the existing option routes.
 *
 * Assembled server-side because the panel cannot derive them: a Jira
 * assignable-users lookup needs the SITE the issue lives on (which is the link
 * row's `external_scope`, not necessarily the workspace's current destination)
 * and the issue's own project; a Linear label list needs the issue's team, which
 * is a property of the issue rather than of the config. Every key is optional
 * because each is meaningful to exactly one provider.
 */
export interface LensOptionScope {
  /** Jira — `https://acme.atlassian.net`, for chip link-outs. */
  site_url?: string
  /** Jira (assignable-users + compose-meta) / Asana (sections). */
  project_id?: string
  /** Jira — needed with project_id for compose-meta's priority allowedValues. */
  issue_type_id?: string
  /** Jira — the site the issue lives on, from the link row's external_scope. */
  cloud_id?: string
  /** Jira — assignable-users takes a project KEY, not an id. */
  project_key?: string
  /** Linear (members / labels / projects are all team-scoped). */
  team_id?: string
  /** Asana (users / tags are workspace-scoped). */
  workspace_gid?: string
}

/** The GET response body, and the PATCH response body — deliberately the same. */
export interface LensDetails {
  ok: true
  provider: LensProvider
  /** `action_external_task.id` — the PATCH URL's own segment. */
  link_id: string
  url: string | null
  title: string | null
  /** Read-only display. Writing status is the echo's job, never the lens's. */
  status_name: string | null
  fields: LensFields
  editable: LensEditable
  option_scope: LensOptionScope
}

/**
 * The failure codes a lens read or write reports.
 *
 * Drawn from the vocabulary the push/echo/read-back paths already share, so a
 * banner written for one path reads the other correctly:
 *  - `reconnect_required` — the stored token was rejected. The picker routes'
 *    code for exactly this, mapped from a provider 401 rather than passed
 *    through, so it can never be confused with the CALLER's session expiring.
 *  - `task_missing` — RETRYABLE. Jira's 404 and Linear's null `issue(id:)` are
 *    both ambiguous by platform design (deleted, or not visible to this account),
 *    and jira-link-marker/linear-link-marker both refuse a terminal reading for
 *    that reason. The lens keeps their stance.
 *  - `task_deleted` — TERMINAL, and Asana's alone. An Asana gid that 404s really
 *    is gone (apply-remote-task-state's markTaskDeleted already treats it so).
 *  - `provider_error` — everything else, including a 429. See below for why a
 *    rate limit is reported rather than slept on.
 *  - `link_not_found` — no link row for this (action, provider). An NI-side
 *    fact, not a provider one.
 *  - `not_connected` / `not_configured` — the workspace never finished setup.
 *  - `field_not_editable` — Jira's editmeta says this field is not on the issue's
 *    edit screen right now (workflow state, screen scheme or permissions).
 */
export type LensFailureCode =
  | 'reconnect_required'
  | 'task_missing'
  | 'task_deleted'
  | 'provider_error'
  | 'link_not_found'
  | 'not_connected'
  | 'not_configured'
  | 'field_not_editable'

export interface LensFailure {
  ok: false
  code: LensFailureCode
  error: string
}

export type LensResult = LensDetails | LensFailure

/**
 * The link row a collector works from.
 *
 * Read from `action_external_task` by the route; the collector never queries. The
 * two columns worth naming: `external_id` is the provider's own id (a Jira issue
 * id, an Asana gid, a Linear UUID) and `external_scope` is Jira's cloudId — the
 * SITE the issue lives on, which must be used in preference to the workspace's
 * current `config.cloud_id`, because a workspace that re-pointed its destination
 * would otherwise resolve every old link against an unrelated tenant whose issue
 * ids start at the same 10000.
 */
export interface LensLinkRow {
  id: string
  external_id: string
  external_scope: string | null
  external_url: string | null
  external_title: string | null
}

// ---------------------------------------------------------------------------
// The PATCH body
// ---------------------------------------------------------------------------

/**
 * A parsed lens edit.
 *
 * The three-state reading is the whole point and is lifted from
 * push-overrides.ts's clearable readers: ABSENT means "do not touch this field",
 * `null` means "clear it", and a value means "set it". Folding null to absent is
 * the bug that reader exists to prevent — a user who opens the assignee chip and
 * picks "Unassigned" is making a choice, and treating it as absence leaves the
 * old assignee in place while the chip shows nobody.
 *
 * `label_ids` is the exception: it is a FULL REPLACEMENT array and is never null.
 * An empty array already means "no labels", so a second way to say it would only
 * give the UI two encodings for one gesture. It is also the only field with a
 * LENGTH LIMIT — see LENS_MAX_LABELS, and why Asana is the reason for it.
 */
export interface LensFieldUpdate {
  assignee_id?: string | null
  priority_id?: string | null
  due_date?: string | null
  label_ids?: string[]
}

export interface LensUpdateParseFailure {
  ok: false
  error: string
  /**
   * A machine-readable reason, present only where the panel can act on it.
   *
   * Most parse failures are caller BUGS (an unknown key, a malformed date) that no
   * UI branches on — the message is for whoever reads the network tab. `code` is
   * added for the ones a user can actually hit and recover from, so the panel can
   * say something better than echoing a validation sentence.
   */
  code?: LensUpdateParseFailureCode
}

/**
 * `too_many_labels` — the label set exceeded LENS_MAX_LABELS. Distinct from a
 * malformed array because the fix is different: drop some labels, not fix the
 * payload.
 */
export type LensUpdateParseFailureCode = 'too_many_labels'

export type LensUpdateParseResult =
  | { ok: true; value: LensFieldUpdate }
  | LensUpdateParseFailure

const LENS_FIELD_KEYS = ['assignee_id', 'priority_id', 'due_date', 'label_ids'] as const

/**
 * The most labels one lens write may name.
 *
 * A CAP, not a preference, and it exists because `label_ids` is the only lens
 * field whose cost is linear in its own length. Jira and Linear both take the
 * whole set in one request (a `labels` array, a `labelIds` array), but ASANA
 * CANNOT: its tags are not a field on the task at all, they are managed through
 * `POST /tasks/{gid}/addTag` and `removeTag` — ONE HTTP CALL PER TAG — which
 * asana-lens diffs and issues sequentially, each subject to the shared
 * transport's retry-with-sleep on a 429. So a body naming 500 tags is 500
 * sequential Asana calls inside one request nobody cancelled, with a panel
 * waiting on it and a serverless timeout at the end.
 *
 * Enforced HERE rather than in the Asana collector for the reason every other
 * rule in this parser is: the caller learns the limit before anything is written,
 * from a message that names the field and the number, instead of from a request
 * that half-applied a tag diff and then timed out. The cap applies to all three
 * providers even though only Asana pays per-tag — one lens contract with one
 * limit beats three that differ, and no real ticket carries 50 labels (Jira's own
 * label field, the most permissive of the three, is free text nobody fills past a
 * handful).
 */
export const LENS_MAX_LABELS = 50

/** `YYYY-MM-DD`, and a real calendar date — `2026-02-31` is not one. */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/**
 * Parse a PATCH body into a field update.
 *
 * Modeled on push-overrides.ts's parsers and enforcing the same two rules:
 * UNKNOWN KEYS ARE REJECTED rather than ignored (a panel sending
 * `assignee_account_id` — Jira's push-override spelling — to the lens has a bug,
 * and a silently-dropped field surfaces days later as "the assignee didn't
 * stick"), and a provider that has no such field rejects it by NAME rather than
 * letting the provider answer with a message naming neither the panel nor the
 * field.
 *
 * An EMPTY update is rejected too. A PATCH that changes nothing is a caller bug
 * either way, and answering 200 for it would hand the panel a success it can't
 * distinguish from a real write.
 */
export function parseLensUpdate(
  body: unknown,
  provider: LensProvider,
): LensUpdateParseResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be a JSON object' }
  }
  const top = body as Record<string, unknown>
  const unknownTop = Object.keys(top).filter((key) => key !== 'fields')
  if (unknownTop.length > 0) {
    return { ok: false, error: `Unknown body field(s): ${unknownTop.join(', ')}` }
  }

  const raw = top.fields
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '`fields` must be an object' }
  }
  const source = raw as Record<string, unknown>

  const unknown = Object.keys(source).filter(
    (key) => !(LENS_FIELD_KEYS as readonly string[]).includes(key),
  )
  if (unknown.length > 0) {
    return { ok: false, error: `Unknown ${provider} lens field(s): ${unknown.join(', ')}` }
  }

  const out: LensFieldUpdate = {}

  // Clearable strings: `null` clears, absent leaves untouched, a value sets.
  for (const key of ['assignee_id', 'priority_id'] as const) {
    if (!(key in source)) continue
    const value = source[key]
    if (value === null) {
      out[key] = null
      continue
    }
    if (typeof value !== 'string') {
      return { ok: false, error: `\`${key}\` must be a string or null (${provider} lens)` }
    }
    const trimmed = value.trim()
    // An empty string is a panel bug, not a clear: `null` is how a clear is
    // spelled, and accepting '' as a synonym would give the UI two encodings for
    // one gesture and make a half-initialized input look deliberate.
    if (trimmed.length === 0) {
      return {
        ok: false,
        error: `\`${key}\` must not be empty — use null to clear (${provider} lens)`,
      }
    }
    out[key] = trimmed
  }

  if ('due_date' in source) {
    const value = source.due_date
    if (value === null) {
      out.due_date = null
    } else if (typeof value !== 'string') {
      return { ok: false, error: `\`due_date\` must be a string or null (${provider} lens)` }
    } else {
      const trimmed = value.trim()
      if (!isCalendarDate(trimmed)) {
        return {
          ok: false,
          error: `\`due_date\` must be a YYYY-MM-DD date or null (${provider} lens)`,
        }
      }
      out.due_date = trimmed
    }
  }

  if ('label_ids' in source) {
    const value = source.label_ids
    // Never null: `[]` already means "no labels" and is the clear.
    if (!Array.isArray(value)) {
      return {
        ok: false,
        error: `\`label_ids\` must be an array of strings (${provider} lens)`,
      }
    }
    // Length BEFORE contents: the whole point is not to do work proportional to a
    // hostile array, and validating 5000 entries to then reject the array on its
    // count would be exactly that.
    if (value.length > LENS_MAX_LABELS) {
      return {
        ok: false,
        code: 'too_many_labels',
        error:
          `\`label_ids\` names ${value.length} labels — at most ${LENS_MAX_LABELS} ` +
          `can be set in one edit (${provider} lens)`,
      }
    }
    const ids: string[] = []
    for (const entry of value) {
      if (typeof entry !== 'string' || entry.trim().length === 0) {
        return {
          ok: false,
          error: `\`label_ids\` must be an array of non-empty strings (${provider} lens)`,
        }
      }
      ids.push(entry.trim())
    }
    out.label_ids = ids
  }

  // Asana has NO native priority field — it exists only as a per-project enum
  // custom field, which is why the push override parser omits it too. Rejected by
  // name here rather than sent and refused, so the message names the field.
  if (provider === 'asana' && 'priority_id' in out) {
    return {
      ok: false,
      error: 'Asana has no priority field — `priority_id` is not editable in the Asana lens',
    }
  }

  if (Object.keys(out).length === 0) {
    return { ok: false, error: '`fields` must name at least one field to change' }
  }

  return { ok: true, value: out }
}

// ---------------------------------------------------------------------------
// Linear's fixed priority scale
// ---------------------------------------------------------------------------

/**
 * Linear's priority scale, as a lens-shaped option list.
 *
 * Workspace-wide and fixed — there is no per-team lookup and no option route to
 * call, which is why the names live here rather than being fetched. The ids are
 * the integers as STRINGS because `LensRef.id` is a string for every provider;
 * the write path converts back.
 */
export const LINEAR_PRIORITY_NAMES: Record<number, string> = {
  0: 'No priority',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low',
}

/**
 * Linear's `priority` Int as a lens ref, or null.
 *
 * 0 is "No priority" and is a REAL value Linear stores — but as a chip it is
 * indistinguishable from "unset", and the write path clears with `priority: 0`
 * anyway, so it is normalized to null. That keeps "no priority" one state in the
 * UI instead of two that look identical and behave differently.
 */
export function linearPriorityRef(priority: number | null | undefined): LensRef | null {
  if (typeof priority !== 'number' || !Number.isInteger(priority)) return null
  if (priority <= 0 || priority > 4) return null
  return { id: String(priority), name: LINEAR_PRIORITY_NAMES[priority] ?? String(priority) }
}

/**
 * A lens `priority_id` as Linear's Int, or a failure.
 *
 * `null` (clear) becomes 0, which is how Linear spells "no priority" — there is
 * no way to unset the field itself.
 */
export function linearPriorityInput(
  priorityId: string | null,
): { ok: true; value: number } | LensUpdateParseFailure {
  if (priorityId === null) return { ok: true, value: 0 }
  if (!/^[0-4]$/.test(priorityId)) {
    return {
      ok: false,
      error:
        '`priority_id` must be "0"-"4" for Linear ' +
        '(0 No priority, 1 Urgent, 2 High, 3 Medium, 4 Low)',
    }
  }
  return { ok: true, value: Number(priorityId) }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * A date-only `YYYY-MM-DD` sliced off whatever the provider returned.
 *
 * Sliced rather than round-tripped through Date, matching every push's
 * `dueDateFor`: an all-day date parsed and re-formatted shifts across a timezone
 * boundary, which is how a due date lands a day early for half the world.
 */
export function lensDateOnly(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value)
  return match ? match[1] : null
}

/** Trim to a non-empty string, else null. */
export function lensText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * An id+name pair from a provider object, or null when there is no usable id.
 *
 * A ref with no id is dropped rather than rendered: the chip would be
 * unselectable and a write could not name it, so showing it promises an edit
 * that cannot happen.
 */
export function lensRef(
  id: unknown,
  ...names: unknown[]
): LensRef | null {
  if (typeof id !== 'string' || id.trim().length === 0) return null
  for (const name of names) {
    const text = lensText(name)
    if (text) return { id: id.trim(), name: text }
  }
  return { id: id.trim(), name: id.trim() }
}

/** An all-false editable set — what a lens over a ticket nobody may edit reports. */
export function noneEditable(): LensEditable {
  return { assignee: false, priority: false, due_date: false, labels: false }
}
