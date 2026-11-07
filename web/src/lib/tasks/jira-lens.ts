import {
  JiraApiError,
  JiraUnauthorizedError,
  isJiraNotFound,
  jiraFetch,
  type JiraCreateMetaField,
  type JiraIssue,
  type JiraStatus,
} from '@/lib/integrations/jira-api'
import { getValidTokenForAccount } from '@/lib/oauth/token-manager'
import { loadJiraSyncState } from './jira-config'
import { issueBrowseUrl } from './jira-push'
import {
  lensDateOnly,
  lensRef,
  lensText,
  type LensDetails,
  type LensEditable,
  type LensFieldUpdate,
  type LensFields,
  type LensLinkRow,
  type LensOptionScope,
  type LensResult,
} from './task-lens'

/**
 * The JIRA lens: read one linked issue's current fields, and write the four
 * editable ones back.
 *
 * Jira is the provider that needs the most machinery, and every piece of it
 * traces to one platform fact: A JIRA FIELD IS NOT UNIVERSALLY EDITABLE. Whether
 * `duedate` can be set on a given issue depends on the project's screen scheme,
 * the issue type, the issue's current workflow status, and the connected
 * account's permissions — all four at once, all four changeable by an admin
 * without warning. `GET /issue/{id}/editmeta` answers exactly that question for
 * exactly this issue right now, which is why the lens asks it rather than
 * assuming, and why `editable` is computed rather than hardcoded the way it is
 * for Asana and Linear.
 *
 * Sibling of jira-compose-meta.ts, which does the same job for the CREATE screen:
 * createmeta gates what the compose panel offers, editmeta gates what the lens
 * offers. The difference is that createmeta is cacheable per project+type (one
 * screen shared by every future issue) while editmeta is per ISSUE and changes as
 * the issue moves through its workflow — so it is read live, every time, and
 * never cached.
 */

/** The fields the lens reads. `duedate` is Jira's only due field, and date-only. */
const LENS_ISSUE_FIELDS =
  'summary,status,assignee,priority,duedate,labels,issuetype,project'

/**
 * The editmeta field ids the lens cares about.
 *
 * `labels` is Jira's own id for the field; there is no separate "tags" concept the
 * way Asana has one.
 */
const EDITABLE_FIELD_IDS = {
  assignee: 'assignee',
  priority: 'priority',
  due_date: 'duedate',
  labels: 'labels',
} as const

/** The shape `GET /issue/{id}/editmeta` returns: `{ fields: { <fieldId>: {…} } }`. */
interface JiraEditMeta {
  fields?: Record<string, JiraCreateMetaField | undefined>
}

interface JiraLensIssueFields {
  summary?: unknown
  status?: JiraStatus
  assignee?: { accountId?: string; displayName?: string; emailAddress?: string | null } | null
  priority?: { id?: string; name?: string } | null
  duedate?: unknown
  labels?: unknown
  issuetype?: { id?: string; name?: string } | null
  project?: { id?: string; key?: string; name?: string } | null
}

/**
 * `GET /issue/{id}/editmeta` — which fields this issue accepts RIGHT NOW.
 *
 * Read live and never cached, unlike createmeta: the answer depends on the
 * issue's current workflow status, so an issue that moves from In Progress to
 * Done can lose a field between two lens opens. The response is the same
 * `{ fields: { <fieldId>: { required, allowedValues, operations, … } } }` envelope
 * createmeta returns, which is what lets `JiraCreateMetaField` describe both.
 */
export async function getIssueEditMeta(
  accessToken: string,
  cloudId: string,
  issueIdOrKey: string,
): Promise<JiraEditMeta> {
  const body = (await jiraFetch(
    accessToken,
    cloudId,
    `/issue/${encodeURIComponent(issueIdOrKey)}/editmeta`,
  )) as JiraEditMeta | null
  return body ?? { fields: {} }
}

/**
 * `PUT /issue/{id}` — set fields on an existing issue. 204 No Content.
 *
 * The generic field write, used for every lens edit including the assignee.
 * `PUT /issue/{id}/assignee` (jira-api's `assignIssue`, which the push uses
 * post-create) is deliberately NOT used here: the lens can change several fields
 * in one gesture, and folding the assignee into the same PUT makes the whole edit
 * one atomic Jira operation rather than two writes that can half-succeed.
 */
export async function updateIssueFields(
  accessToken: string,
  cloudId: string,
  issueIdOrKey: string,
  fields: Record<string, unknown>,
): Promise<void> {
  await jiraFetch(accessToken, cloudId, `/issue/${encodeURIComponent(issueIdOrKey)}`, {
    method: 'PUT',
    body: JSON.stringify({ fields }),
  })
}

/**
 * Fold editmeta into the lens's four-field editable set.
 *
 * ABSENT MEANS NOT EDITABLE, which is the entire contract: editmeta returns only
 * the fields on this issue's edit screen that this user may set, so a missing
 * `duedate` key is Jira saying "a PUT naming duedate will 400". Presence is the
 * whole test — `required` and `allowedValues` matter to the create panel's
 * can-I-compose-this question, not to can-I-edit-this.
 */
export function editableFromEditMeta(meta: JiraEditMeta | null | undefined): LensEditable {
  const fields = meta?.fields ?? {}
  return {
    assignee: !!fields[EDITABLE_FIELD_IDS.assignee],
    priority: !!fields[EDITABLE_FIELD_IDS.priority],
    due_date: !!fields[EDITABLE_FIELD_IDS.due_date],
    labels: !!fields[EDITABLE_FIELD_IDS.labels],
  }
}

/**
 * Normalize a Jira issue into lens fields.
 *
 * The two normalizations worth naming:
 *  - LABELS ARE PLAIN STRINGS in Jira (`["backend", "urgent"]`), with no id of
 *    any kind. They arrive as refs with `id === name`, which is honest rather
 *    than a fudge: a Jira label's identity IS its text, and the write submits
 *    that same text. Non-strings and blanks are dropped — the field is
 *    admin-editable free text and a stray null would render an empty chip.
 *  - `duedate` is already date-only, but it is sliced rather than trusted, so a
 *    site that ever returns a datetime cannot put a `T` in a date chip.
 */
export function jiraLensFields(issue: JiraIssue | null | undefined): LensFields {
  const fields = (issue?.fields ?? {}) as JiraLensIssueFields

  const labels: LensFields['labels'] = []
  if (Array.isArray(fields.labels)) {
    for (const label of fields.labels) {
      const text = lensText(label)
      if (text) labels.push({ id: text, name: text })
    }
  }

  return {
    project: lensRef(fields.project?.id, fields.project?.name, fields.project?.key),
    issue_type: lensRef(fields.issuetype?.id, fields.issuetype?.name),
    // Jira has no team concept — the coordinate above a project is the SITE, and
    // that is `option_scope.cloud_id`, not a field on the issue.
    team: null,
    // Nor a section: Jira's column analogue is `status`, which the lens reports
    // separately as read-only `status_name`.
    section: null,
    assignee: lensRef(
      fields.assignee?.accountId,
      fields.assignee?.displayName,
      fields.assignee?.emailAddress,
    ),
    priority: lensRef(fields.priority?.id, fields.priority?.name),
    due_date: lensDateOnly(fields.duedate),
    labels,
  }
}

/**
 * Build the lens write payload from a parsed update.
 *
 * Every branch is KEY PRESENCE, never truthiness, for the reason
 * push-overrides.ts spells out at length: `null` is a CLEAR and must reach Jira
 * as an explicit null, while absent must not appear in the payload at all. A `??`
 * here would silently drop every clear.
 *
 * Jira's own null semantics per field:
 *  - `assignee: null` unassigns. (`{ accountId }` when set — accountId only; the
 *    GDPR migration removed `name`/`key` from every user payload in Cloud.)
 *  - `priority: null` clears the priority.
 *  - `duedate: null` clears the date.
 *  - `labels: []` is the empty replacement. A plain PUT REPLACES the whole array
 *    rather than merging, which is exactly what a full-replacement `label_ids`
 *    wants — no `update: { labels: [{ add }] }` operations form needed.
 */
export function jiraLensPayload(update: LensFieldUpdate): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  if ('assignee_id' in update) {
    fields.assignee = update.assignee_id === null ? null : { accountId: update.assignee_id }
  }
  if ('priority_id' in update) {
    fields.priority = update.priority_id === null ? null : { id: update.priority_id }
  }
  if ('due_date' in update) {
    fields.duedate = update.due_date
  }
  if (update.label_ids !== undefined) {
    fields.labels = update.label_ids
  }
  return fields
}

/** Which lens field names an update touches — for the editmeta gate's message. */
function touchedFields(update: LensFieldUpdate): Array<keyof LensEditable> {
  const touched: Array<keyof LensEditable> = []
  if ('assignee_id' in update) touched.push('assignee')
  if ('priority_id' in update) touched.push('priority')
  if ('due_date' in update) touched.push('due_date')
  if (update.label_ids !== undefined) touched.push('labels')
  return touched
}

/**
 * Map a thrown Jira client error into a lens failure.
 *
 * The 404 mapping is the one that matters and it is deliberately RETRYABLE:
 * `GET /issue/{id}` answers 404 both for "this issue does not exist" and for "the
 * connected user cannot browse it", and Atlassian does not distinguish them. That
 * is precisely why jira-link-marker.ts refuses a terminal reading, and the lens
 * keeps its stance — `task_missing`, never `task_deleted`. A permission scheme
 * edited for an hour must not make the panel say "this ticket was deleted".
 *
 * A 429 is reported as `provider_error` rather than retried. The shared transport
 * already retries up to 3 times and will sleep as long as a 60s `Retry-After`,
 * which is fine for an Inngest step and wrong for a panel someone is looking at —
 * so when it finally throws, the lens surfaces it immediately with a retryable
 * code instead of adding another wait on top.
 *
 * THE MESSAGE IS NEVER `err.message`. A JiraApiError's message is built as
 * `Jira request failed (<status>) <url>[: <body>]` and that url is the internal
 * gateway form — `https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/issue/<id>`
 * — so returning it hands the browser the workspace's cloudId, the API host we
 * proxy through, and the raw Atlassian error body. jira-push already made this
 * call for the create path (see `rejectedCreateFields`, whose comment names the
 * same leak); the lens matches it. What DOES survive is the set of field KEYS Jira
 * named, because `customfield_10014` is the one actionable token in that envelope
 * and it identifies a field configuration rather than our infrastructure. The
 * whole error still reaches the server log, which is where it is useful.
 */
export function jiraLensFailure(err: unknown, context: string): LensResult {
  if (err instanceof JiraUnauthorizedError) {
    return { ok: false, code: 'reconnect_required', error: 'Reconnect Jira to continue' }
  }
  if (isJiraNotFound(err)) {
    return {
      ok: false,
      code: 'task_missing',
      error: 'This Jira issue could not be read — it may have been deleted, or moved out of view.',
    }
  }
  if (err instanceof JiraApiError && err.status === 429) {
    return {
      ok: false,
      code: 'provider_error',
      error: 'Jira is rate limiting this workspace right now. Try again in a moment.',
    }
  }
  console.error(`[jira-lens] ${context} failed:`, err)
  return {
    ok: false,
    code: 'provider_error',
    error: jiraLensErrorText(err, context),
  }
}

/**
 * A client-safe sentence for a Jira failure the mapper above did not classify.
 *
 * Two shapes, and the split is about who can act on it:
 *  - Jira named FIELDS (`errors: { duedate: "…" }` → `fieldErrors`). The keys are
 *    reported, because a user can go look at those fields on their issue's edit
 *    screen. The sentences are not, because they are localizable prose Jira wrote
 *    and they arrive concatenated with the gateway url in `message`.
 *  - Everything else — a 400 that flattened into `errorMessages`, a 500, a
 *    TypeError from a bad response shape, an aborted fetch. All of it collapses to
 *    one generic line: none of it is actionable in a properties panel, and the
 *    difference between "Jira 502'd" and "our JSON parse threw" is a log question.
 */
function jiraLensErrorText(err: unknown, context: string): string {
  if (err instanceof JiraApiError) {
    const named = Object.keys(err.fieldErrors)
    if (named.length > 0) {
      // Worded for the write, because that is the only call that produces field
      // errors: a `GET /issue` has no fields to reject. A read that somehow
      // carried them would still be readable prose rather than a wrong claim.
      return `Jira rejected ${named.join(', ')} on this issue. Check those fields in Jira.`
    }
  }
  return `Failed to ${context} — Jira returned an error. Try again in a moment.`
}

interface JiraLensArgs {
  workspaceId: string
  link: LensLinkRow
}

/**
 * Everything a Jira lens call needs after the gates: a token, the site, and the
 * site's display url.
 *
 * The SITE resolution is the load-bearing line. `link.external_scope` is the
 * cloudId the issue was pushed to and is preferred over the config's current
 * `cloud_id` in every case, because Jira issue ids are a per-site sequence that
 * all start at 10000 — a workspace that re-pointed its destination to another
 * Atlassian tenant would otherwise read a completely unrelated issue that happens
 * to share the id, and (worse, on the write path) EDIT it.
 */
async function resolveJiraLens(
  args: JiraLensArgs,
): Promise<{ token: string; cloudId: string; siteUrl: string | null } | LensResult> {
  const syncState = await loadJiraSyncState(args.workspaceId)
  if (!syncState) {
    return {
      ok: false,
      code: 'not_connected',
      error: 'Jira is not connected for this workspace',
    }
  }
  const cloudId = args.link.external_scope ?? syncState.config.cloud_id ?? null
  if (!cloudId) {
    return {
      ok: false,
      code: 'not_configured',
      error: 'This Jira link has no site recorded — re-push the action to relink it',
    }
  }
  const resolved = await getValidTokenForAccount(syncState.accountId)
  if (!resolved) {
    return { ok: false, code: 'reconnect_required', error: 'Reconnect Jira to continue' }
  }
  return {
    token: resolved.token,
    cloudId,
    // The site url is only ever the CONFIG's: the link row stores no site url,
    // and it is used for display link-outs, where being one tenant off is
    // cosmetic rather than the identity problem the cloudId is.
    siteUrl: syncState.config.site_url ?? null,
  }
}

/**
 * The option-picker scope for a Jira lens.
 *
 * `project_key` rides along beside `project_id` because Jira's assignable-users
 * endpoint takes a project KEY while every other option route takes the id —
 * deriving one from the other would cost the panel an extra round trip for a
 * value the issue read already carried.
 */
function jiraOptionScope(
  cloudId: string,
  siteUrl: string | null,
  issue: JiraIssue | null | undefined,
): LensOptionScope {
  const fields = (issue?.fields ?? {}) as JiraLensIssueFields
  const scope: LensOptionScope = { cloud_id: cloudId }
  if (siteUrl) scope.site_url = siteUrl
  const projectId = lensText(fields.project?.id)
  if (projectId) scope.project_id = projectId
  const projectKey = lensText(fields.project?.key)
  if (projectKey) scope.project_key = projectKey
  const issueTypeId = lensText(fields.issuetype?.id)
  if (issueTypeId) scope.issue_type_id = issueTypeId
  return scope
}

/** Assemble the normalized response from one issue read + one editmeta read. */
function jiraLensDetails(args: {
  link: LensLinkRow
  issue: JiraIssue
  meta: JiraEditMeta | null
  cloudId: string
  siteUrl: string | null
}): LensDetails {
  const fields = (args.issue.fields ?? {}) as JiraLensIssueFields
  return {
    ok: true,
    provider: 'jira',
    link_id: args.link.id,
    // Rebuilt from the LIVE key rather than reusing the stored `external_url`:
    // Jira rewrites an issue's key on a project move or a project-key rename, and
    // the stored url is only ever what it was at push time. Falls back to the
    // stored one when the site url is unknown, which is issueBrowseUrl's contract.
    url: issueBrowseUrl(args.siteUrl, lensText(args.issue.key)) ?? args.link.external_url,
    title: lensText(fields.summary) ?? args.link.external_title,
    status_name: lensText(fields.status?.name),
    fields: jiraLensFields(args.issue),
    editable: editableFromEditMeta(args.meta),
    option_scope: jiraOptionScope(args.cloudId, args.siteUrl, args.issue),
  }
}

/**
 * Read a linked Jira issue's current fields.
 *
 * TWO calls, both needed and deliberately not one: `GET /issue` for the values
 * and `GET /issue/{id}/editmeta` for whether they can be changed. They are issued
 * in parallel because neither depends on the other, and editmeta is BEST-EFFORT —
 * an editmeta failure yields an all-read-only lens rather than no lens at all,
 * because showing the values as uneditable is strictly better than showing
 * nothing when the only thing that failed was the permission probe.
 */
export async function readJiraTaskDetails(args: JiraLensArgs): Promise<LensResult> {
  const resolved = await resolveJiraLens(args)
  if ('ok' in resolved) return resolved
  const { token, cloudId, siteUrl } = resolved

  try {
    const [issue, meta] = await Promise.all([
      jiraFetch(
        token,
        cloudId,
        `/issue/${encodeURIComponent(args.link.external_id)}` +
          `?${new URLSearchParams({ fields: LENS_ISSUE_FIELDS }).toString()}`,
      ) as Promise<JiraIssue | null>,
      getIssueEditMeta(token, cloudId, args.link.external_id).catch((err) => {
        console.warn(
          `[jira-lens] editmeta unavailable for issue ${args.link.external_id} ` +
            '(rendering the lens read-only) —',
          err instanceof Error ? err.message : String(err),
        )
        return null
      }),
    ])

    if (!issue?.id) {
      // A 2xx with no issue is not a shape Jira produces, but trusting it would
      // render a lens over nothing. Treated as the same retryable miss a 404 is.
      return {
        ok: false,
        code: 'task_missing',
        error: 'Jira returned no issue for this link',
      }
    }

    return jiraLensDetails({ link: args.link, issue, meta, cloudId, siteUrl })
  } catch (err) {
    return jiraLensFailure(err, 'read the Jira issue')
  }
}

/**
 * Write lens fields to a linked Jira issue, then read them back.
 *
 * THE EDITMETA RE-CHECK IS NOT BELT-AND-BRACES. The panel gated its chips on the
 * editmeta it read when the lens mounted, and between that read and this write the
 * issue can have moved workflow state, had its screen scheme edited, or lost the
 * user a permission — all of which change the answer. Without the re-check the
 * failure is a Jira 400 whose message names a field the user can see is right
 * there on screen; with it the failure is `field_not_editable` naming the field,
 * before anything is written.
 *
 * The re-check also means a multi-field edit is ALL-OR-NOTHING: if any touched
 * field is not editable, nothing is written. A partial write would leave the panel
 * reconciling against a state no gesture produced.
 */
export async function updateJiraTaskFields(
  args: JiraLensArgs & { update: LensFieldUpdate },
): Promise<LensResult> {
  const resolved = await resolveJiraLens(args)
  if ('ok' in resolved) return resolved
  const { token, cloudId, siteUrl } = resolved

  try {
    const meta = await getIssueEditMeta(token, cloudId, args.link.external_id)
    const editable = editableFromEditMeta(meta)
    const blocked = touchedFields(args.update).filter((field) => !editable[field])
    if (blocked.length > 0) {
      return {
        ok: false,
        code: 'field_not_editable',
        error:
          `Jira will not accept ${blocked.join(', ')} on this issue right now — ` +
          'the field is off its edit screen, or your Jira account cannot set it. ' +
          'Change it in Jira instead.',
      }
    }

    await updateIssueFields(
      token,
      cloudId,
      args.link.external_id,
      jiraLensPayload(args.update),
    )

    // Re-read: Jira's PUT answers 204 with no body, so the only way to reconcile
    // the panel against real state (rather than against an echo of what we sent —
    // which hides a field Jira accepted and then normalized) is to ask again.
    const issue = (await jiraFetch(
      token,
      cloudId,
      `/issue/${encodeURIComponent(args.link.external_id)}` +
        `?${new URLSearchParams({ fields: LENS_ISSUE_FIELDS }).toString()}`,
    )) as JiraIssue | null

    if (!issue?.id) {
      return {
        ok: false,
        code: 'task_missing',
        error: 'The Jira issue was updated but could not be read back',
      }
    }

    // The POST-WRITE editmeta, not the pre-write one: a field can become
    // read-only as a consequence of the very edit just made (a Jira workflow that
    // locks fields on transition), and reporting the stale set would leave the
    // panel offering a chip the next write would refuse.
    return jiraLensDetails({
      link: args.link,
      issue,
      meta: await getIssueEditMeta(token, cloudId, args.link.external_id).catch(() => meta),
      cloudId,
      siteUrl,
    })
  } catch (err) {
    return jiraLensFailure(err, 'update the Jira issue')
  }
}
