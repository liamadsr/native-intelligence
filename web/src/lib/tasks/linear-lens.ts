import {
  LinearApiError,
  LinearUnauthorizedError,
  isLinearRateLimited,
  linearGraphQL,
} from '@/lib/integrations/linear-api'
import { getValidTokenForAccount } from '@/lib/oauth/token-manager'
import { loadLinearSyncState } from './linear-config'
import {
  lensDateOnly,
  lensRef,
  lensText,
  linearPriorityInput,
  linearPriorityRef,
  type LensDetails,
  type LensEditable,
  type LensFieldUpdate,
  type LensFields,
  type LensLinkRow,
  type LensOptionScope,
  type LensResult,
} from './task-lens'

/**
 * The LINEAR lens: read one linked issue's current fields, and write the four
 * editable ones back.
 *
 * By far the simplest of the three, and for one structural reason: `issueUpdate`
 * is a SINGLE generic mutation that takes every field at once. No per-field
 * endpoint fan-out (Asana's tags), no transition graph (Jira's status), no
 * per-issue field-permission probe (Jira's editmeta) — and the mutation returns
 * the updated issue inline, so the write needs no follow-up read either.
 *
 * The two Linear-specific traps the lens has to respect:
 *
 *  1. `priority` IS AN INT, 0-4, on a fixed workspace-wide scale — and 0 ("No
 *     priority") is a real, legal, intentional value. Every test against it must
 *     be `!== undefined`, never truthiness, which is the same footgun
 *     push-overrides.ts documents for the create path.
 *
 *  2. `issue(id:)` RETURNING NULL IS AMBIGUOUS BY DESIGN — deleted, invisible to
 *     this user, or never existed, all indistinguishable with no `errors` entry.
 *     linear-link-marker.ts refuses a terminal reading for exactly that reason, so
 *     the lens maps null to the retryable `task_missing`, never `task_deleted`.
 */

/**
 * The lens read query.
 *
 * `labels(first: 50)` is a bounded page rather than a walk: fifty labels on one
 * issue is already far past what anyone puts there, and a lens chip row that long
 * is unreadable anyway — so the ceiling costs nothing real and keeps the query's
 * complexity budget flat.
 */
const LENS_ISSUE_QUERY = `query LensIssue($id: String!) {
  issue(id: $id) {
    id
    identifier
    title
    url
    trashed
    dueDate
    priority
    state { id name type }
    team { id key name }
    project { id name }
    assignee { id name displayName email }
    labels(first: 50) { nodes { id name } }
  }
}`

/**
 * The lens write mutation.
 *
 * Selects the SAME field set as the read query, which is what lets the write's
 * response be normalized by the same function and returned as the read-through
 * body — no second round trip, unlike Jira's 204-answering PUT.
 */
const LENS_ISSUE_UPDATE = `mutation LensUpdateIssue($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue {
      id
      identifier
      title
      url
      trashed
      dueDate
      priority
      state { id name type }
      team { id key name }
      project { id name }
      assignee { id name displayName email }
      labels(first: 50) { nodes { id name } }
    }
  }
}`

/**
 * Linear's four editable lens fields.
 *
 * STATIC and all true: Linear has no per-issue field-permission model to probe
 * (a user who can see an issue can update it), and `priority` is a real field on
 * every issue on a fixed scale — no per-team lookup, no allowedValues, nothing to
 * gate on.
 */
export const LINEAR_LENS_EDITABLE: LensEditable = {
  assignee: true,
  priority: true,
  due_date: true,
  labels: true,
}

interface LinearLensIssue {
  id?: string
  identifier?: unknown
  title?: unknown
  url?: unknown
  trashed?: boolean
  dueDate?: unknown
  priority?: number | null
  state?: { id?: string; name?: unknown; type?: unknown } | null
  team?: { id?: string; key?: unknown; name?: unknown } | null
  project?: { id?: string; name?: unknown } | null
  assignee?: { id?: string; name?: unknown; displayName?: unknown; email?: unknown } | null
  labels?: { nodes?: Array<{ id?: string; name?: unknown }> } | null
}

/** `issue(id:)` with the lens's field set. Null means gone-or-invisible. */
export async function getIssueForLens(
  accessToken: string,
  issueId: string,
): Promise<LinearLensIssue | null> {
  const data = await linearGraphQL<{ issue?: LinearLensIssue | null }>(
    accessToken,
    LENS_ISSUE_QUERY,
    { id: issueId },
  )
  return data?.issue ?? null
}

/**
 * `issueUpdate` — set any combination of lens fields in ONE mutation.
 *
 * Returns the updated issue, which is the lens's read-back. A `success: false`
 * without an `errors[]` entry is treated as a failure too: the field exists in the
 * schema and trusting a null issue would reconcile the panel against nothing.
 */
export async function updateIssueFields(
  accessToken: string,
  issueId: string,
  input: Record<string, unknown>,
): Promise<LinearLensIssue> {
  const data = await linearGraphQL<{
    issueUpdate?: { success?: boolean; issue?: LinearLensIssue }
  }>(accessToken, LENS_ISSUE_UPDATE, { id: issueId, input })

  const issue = data?.issueUpdate?.issue
  if (!data?.issueUpdate?.success || !issue?.id) {
    throw new LinearApiError(200, 'Linear reported the issue update as unsuccessful')
  }
  return issue
}

/** Normalize a Linear issue into lens fields. */
export function linearLensFields(issue: LinearLensIssue | null | undefined): LensFields {
  const labels: LensFields['labels'] = []
  for (const label of issue?.labels?.nodes ?? []) {
    const ref = lensRef(label?.id, label?.name)
    if (ref) labels.push(ref)
  }

  return {
    project: lensRef(issue?.project?.id, issue?.project?.name),
    // Linear has no issue type, and no section — its column analogue is the
    // workflow state, reported separately as read-only `status_name`.
    issue_type: null,
    team: lensRef(issue?.team?.id, issue?.team?.name, issue?.team?.key),
    section: null,
    assignee: lensRef(
      issue?.assignee?.id,
      issue?.assignee?.displayName,
      issue?.assignee?.name,
      issue?.assignee?.email,
    ),
    priority: linearPriorityRef(issue?.priority),
    // A TimelessDate is already `YYYY-MM-DD`; sliced anyway so a datetime could
    // never reach a date chip.
    due_date: lensDateOnly(issue?.dueDate),
    labels,
  }
}

/**
 * Build the `IssueUpdateInput` from a parsed update.
 *
 * Returns a parse failure for a `priority_id` outside 0-4 rather than letting
 * Linear reject it: the message would name a GraphQL input field the user never
 * saw, and the lens's own ids are what the panel submitted.
 *
 * Null semantics per field:
 *  - `assigneeId: null` unassigns.
 *  - `priority: 0` is how "no priority" is spelled — the field itself cannot be
 *    unset, so a clear becomes 0 (see linearPriorityInput).
 *  - `dueDate: null` clears the date.
 *  - `labelIds: []` is the empty full-replacement.
 */
export function linearLensInput(
  update: LensFieldUpdate,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const input: Record<string, unknown> = {}
  if ('assignee_id' in update) {
    input.assigneeId = update.assignee_id
  }
  if ('priority_id' in update) {
    const priority = linearPriorityInput(update.priority_id ?? null)
    if (!priority.ok) return priority
    input.priority = priority.value
  }
  if ('due_date' in update) {
    input.dueDate = update.due_date
  }
  if (update.label_ids !== undefined) {
    input.labelIds = update.label_ids
  }
  return { ok: true, value: input }
}

/**
 * Map a thrown Linear client error into a lens failure.
 *
 * Note what is NOT here: a 404 branch. Linear does not answer 404 for a missing
 * issue — it answers a clean `{ data: { issue: null } }`, which the read path
 * handles as `task_missing` before any error is thrown. The rate-limit check uses
 * `isLinearRateLimited` rather than a status comparison because Linear's limiter
 * is DUAL-MODE: a plain HTTP 429, or an HTTP 400 whose GraphQL error carries
 * `extensions.code === 'RATELIMITED'`.
 */
export function linearLensFailure(err: unknown, context: string): LensResult {
  if (err instanceof LinearUnauthorizedError) {
    return { ok: false, code: 'reconnect_required', error: 'Reconnect Linear to continue' }
  }
  if (isLinearRateLimited(err)) {
    return {
      ok: false,
      code: 'provider_error',
      error: 'Linear is rate limiting this workspace right now. Try again in a moment.',
    }
  }
  console.error(`[linear-lens] ${context} failed:`, err)
  return {
    ok: false,
    code: 'provider_error',
    error: err instanceof Error ? err.message : `Failed to ${context}`,
  }
}

interface LinearLensArgs {
  workspaceId: string
  link: LensLinkRow
}

async function resolveLinearLens(
  args: LinearLensArgs,
): Promise<{ token: string } | LensResult> {
  const syncState = await loadLinearSyncState(args.workspaceId)
  if (!syncState) {
    return {
      ok: false,
      code: 'not_connected',
      error: 'Linear is not connected for this workspace',
    }
  }
  const resolved = await getValidTokenForAccount(syncState.accountId)
  if (!resolved) {
    return { ok: false, code: 'reconnect_required', error: 'Reconnect Linear to continue' }
  }
  return { token: resolved.token }
}

/**
 * The option-picker scope for a Linear lens.
 *
 * Just the team id, and that one id is everything: Linear's members, labels and
 * projects routes are ALL team-scoped, and the team is a property of the issue
 * rather than of the config — an issue moved to another team in Linear must
 * populate its pickers from that team, not from the workspace's destination.
 */
function linearOptionScope(issue: LinearLensIssue | null | undefined): LensOptionScope {
  const teamId = lensText(issue?.team?.id)
  return teamId ? { team_id: teamId } : {}
}

function linearLensDetails(args: { link: LensLinkRow; issue: LinearLensIssue }): LensDetails {
  return {
    ok: true,
    provider: 'linear',
    link_id: args.link.id,
    url: lensText(args.issue.url) ?? args.link.external_url,
    title: lensText(args.issue.title) ?? args.link.external_title,
    status_name: lensText(args.issue.state?.name),
    fields: linearLensFields(args.issue),
    editable: LINEAR_LENS_EDITABLE,
    option_scope: linearOptionScope(args.issue),
  }
}

/**
 * The retryable miss, for a null or trashed issue.
 *
 * TRASHED GETS THE SAME CODE rather than one of its own, matching
 * linear-link-marker.ts: Linear's delete is a 30-day grace window, so a trashed
 * issue is genuinely gone-for-now-possibly-back — which is what `task_missing`
 * already means, and a second code would only give the UI two ways to say it.
 */
function linearTaskMissing(): LensResult {
  return {
    ok: false,
    code: 'task_missing',
    error:
      'This Linear issue could not be read — it may have been deleted, ' +
      'or moved out of view.',
  }
}

/** Read a linked Linear issue's current fields. ONE query. */
export async function readLinearTaskDetails(args: LinearLensArgs): Promise<LensResult> {
  const resolved = await resolveLinearLens(args)
  if ('ok' in resolved) return resolved

  try {
    const issue = await getIssueForLens(resolved.token, args.link.external_id)
    if (!issue?.id || issue.trashed === true) return linearTaskMissing()
    return linearLensDetails({ link: args.link, issue })
  } catch (err) {
    return linearLensFailure(err, 'read the Linear issue')
  }
}

/**
 * Write lens fields to a linked Linear issue.
 *
 * ONE mutation, and no read-back call: `issueUpdate` returns the updated issue
 * with the lens's whole field set inline, so its response IS the read-through
 * body. That is the Linear simplification in one line — Jira needs a re-GET
 * because its PUT answers 204, and Asana needs one because its tag calls happen
 * after the PUT.
 */
export async function updateLinearTaskFields(
  args: LinearLensArgs & { update: LensFieldUpdate },
): Promise<LensResult> {
  const resolved = await resolveLinearLens(args)
  if ('ok' in resolved) return resolved

  const input = linearLensInput(args.update)
  if (!input.ok) {
    // A bad priority id is the caller's mistake, and it is reported with the
    // field-level code rather than as a provider error: nothing was sent to
    // Linear, so calling it a provider failure would misattribute it.
    return { ok: false, code: 'field_not_editable', error: input.error }
  }

  try {
    const issue = await updateIssueFields(
      resolved.token,
      args.link.external_id,
      input.value,
    )
    if (issue.trashed === true) return linearTaskMissing()
    return linearLensDetails({ link: args.link, issue })
  } catch (err) {
    return linearLensFailure(err, 'update the Linear issue')
  }
}
