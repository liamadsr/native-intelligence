import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { apiError } from '@/lib/api-errors'
import { readAsanaTaskDetails, updateAsanaTaskFields } from './asana-lens'
import { readJiraTaskDetails, updateJiraTaskFields } from './jira-lens'
import { readLinearTaskDetails, updateLinearTaskFields } from './linear-lens'
import type {
  LensFailure,
  LensFieldUpdate,
  LensLinkRow,
  LensProvider,
  LensResult,
  LensUpdateParseFailure,
} from './task-lens'

/**
 * The plumbing every lens route repeats: find the link row, dispatch to the
 * provider's collector, and turn a coded result into an HTTP response.
 *
 * FOUR routes share this — the provider-generic GET and the three per-provider
 * PATCH handlers — which is the only reason it is a module. The alternative was
 * the same twenty lines copied into four files, where the interesting part (the
 * error-code→status mapping) could drift between the read and the write for the
 * same provider and nobody would notice until a banner rendered wrong.
 */

/**
 * Load the `action_external_task` row for one (action, provider).
 *
 * Through the CALLER'S RLS-scoped client, deliberately, unlike the
 * `task_sync_state` reads inside the collectors (which need the service client
 * because the destination config is workspace-level while its RLS policy is
 * per-connecting-user). The link row's own policy already admits every workspace
 * member, so scoping this read to the caller's session is both sufficient and the
 * tighter choice — a service-client read here would be a needless widening.
 *
 * The `.eq` chain matches the existing DELETE handlers' exactly, including
 * `workspace_id`: a linkId is a uuid a caller supplies, and without the workspace
 * predicate a member of workspace A could read a link belonging to workspace B by
 * guessing an id.
 */
export async function loadLensLink(args: {
  supabase: SupabaseClient
  actionId: string
  provider: LensProvider
  workspaceId: string
  /** When present, also pins the row id — the PATCH routes' URL segment. */
  linkId?: string
}): Promise<LensLinkRow | null> {
  let query = args.supabase
    .from('action_external_task')
    .select('id, external_id, external_scope, external_url, external_title')
    .eq('action_id', args.actionId)
    .eq('provider', args.provider)
    .eq('workspace_id', args.workspaceId)
  if (args.linkId) query = query.eq('id', args.linkId)

  const { data } = await query
    // Oldest-wins, matching every push's own existing-link pre-check. The UNIQUE
    // (action_id, provider) index means there is only ever one row, so this is
    // belt-and-braces against a future that relaxes it rather than a real tie.
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  return (data as LensLinkRow | null) ?? null
}

/**
 * Verify the action itself belongs to this workspace.
 *
 * Cheap and not redundant. The link lookup above is already workspace-scoped, so
 * a cross-workspace link cannot be read — but a MISSING link and a link belonging
 * to somebody else's action would both answer `link_not_found`, which tells a
 * probing caller nothing and tells a legitimate one the wrong thing. Checking the
 * action separately lets the route answer 404 "action not found" for an id that
 * isn't theirs, which is the same distinction every other action route draws.
 */
export async function actionExistsInWorkspace(args: {
  supabase: SupabaseClient
  actionId: string
  workspaceId: string
}): Promise<boolean> {
  const { data } = await args.supabase
    .from('actions')
    .select('id')
    .eq('id', args.actionId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle()
  return !!data
}

/** Read the linked task's live fields, whichever provider it is. */
export function readTaskDetails(args: {
  provider: LensProvider
  workspaceId: string
  link: LensLinkRow
}): Promise<LensResult> {
  const { workspaceId, link } = args
  switch (args.provider) {
    case 'jira':
      return readJiraTaskDetails({ workspaceId, link })
    case 'asana':
      return readAsanaTaskDetails({ workspaceId, link })
    case 'linear':
      return readLinearTaskDetails({ workspaceId, link })
  }
}

/** Write lens fields to the linked task, whichever provider it is. */
export function updateTaskDetails(args: {
  provider: LensProvider
  workspaceId: string
  link: LensLinkRow
  update: LensFieldUpdate
}): Promise<LensResult> {
  const { workspaceId, link, update } = args
  switch (args.provider) {
    case 'jira':
      return updateJiraTaskFields({ workspaceId, link, update })
    case 'asana':
      return updateAsanaTaskFields({ workspaceId, link, update })
    case 'linear':
      return updateLinearTaskFields({ workspaceId, link, update })
  }
}

/**
 * The HTTP status for each lens failure code.
 *
 * The mapping is the contract the UI branches on, and two entries carry the whole
 * design:
 *
 *  - `reconnect_required` is 400, NOT 401. A bare 401 is indistinguishable from
 *    the caller's own Supabase session expiring, which the client retries by
 *    refreshing a token that was never the problem. Every picker route already
 *    makes this exact choice; the lens matches it so one banner reads both.
 *
 *  - `task_missing` and `task_deleted` are both 404 and are distinguished ONLY by
 *    the code, because the difference is retryability rather than status:
 *    task_missing is Jira's/Linear's ambiguous gone-or-invisible (retry offered),
 *    task_deleted is Asana's unambiguous gone (terminal, no retry). A single
 *    "not found" status with two codes is what lets the panel offer a Retry button
 *    for one and a flat statement for the other.
 *
 *  - `provider_error` is 502, not 500: the failure is upstream, and a 500 reads as
 *    a Dial8 bug in every log and dashboard that aggregates by status.
 */
const LENS_FAILURE_STATUS: Record<LensFailure['code'], number> = {
  reconnect_required: 400,
  not_connected: 400,
  not_configured: 400,
  field_not_editable: 400,
  link_not_found: 404,
  task_missing: 404,
  task_deleted: 404,
  provider_error: 502,
}

/** Turn a lens result into the route's response. */
export function lensResponse(result: LensResult): Response {
  if (result.ok) return NextResponse.json(result)
  return apiError(result.error, {
    status: LENS_FAILURE_STATUS[result.code],
    code: result.code,
  })
}

/**
 * A rejected PATCH body, as the route's 400.
 *
 * Always 400 — every parse failure is the caller's payload to fix — but the CODE
 * rides along when the parser set one, because a code is the only part of a
 * validation failure the panel can branch on. `too_many_labels` is the case that
 * needs it: a user who bulk-selected a hundred tags gets "you picked too many",
 * where an uncoded 400 would leave the lens echoing a sentence written for a
 * network tab.
 *
 * Named here rather than inlined in the three PATCH routes for the reason
 * linkNotFound is: three copies of a status+code decision drift.
 */
export function lensParseFailure(failure: LensUpdateParseFailure): Response {
  return apiError(failure.error, { status: 400, code: failure.code })
}

/** The no-link-row failure, named once so all four routes word it identically. */
export function linkNotFound(provider: LensProvider): Response {
  return apiError(`This action is not linked to ${provider}`, {
    status: 404,
    code: 'link_not_found',
  })
}
