import {
  AsanaApiError,
  AsanaInvalidGidError,
  AsanaUnauthorizedError,
  asanaFetch,
  assertAsanaGid,
  type AsanaNamedResource,
} from '@/lib/integrations/asana-api'
import { getValidTokenForAccount } from '@/lib/oauth/token-manager'
import { loadAsanaSyncState } from './asana-config'
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
 * The ASANA lens: read one linked task's current fields, and write the three
 * editable ones back.
 *
 * Asana sits between the other two in complexity, and its shape is driven by
 * three model facts:
 *
 *  1. THERE IS NO PRIORITY FIELD. Not "we don't support it" — Asana has no native
 *     priority at all; it exists only as a per-project enum custom field, which
 *     Native Intelligence has no schema knowledge of. So the lens reports `priority: null` and
 *     `editable.priority: false`, and the PATCH parser rejects `priority_id` by
 *     name. Same stance push-overrides.ts already takes for the create path.
 *
 *  2. A TASK CAN BE IN MANY PROJECTS. `projects` is an array and `memberships` is
 *     an array of {project, section} pairs. The lens shows the FIRST membership,
 *     because the push only ever puts a task in one project and showing a
 *     one-of-N project as though it were THE project is the honest simplification
 *     — while showing all of them would need a chip shape nothing else uses.
 *
 *  3. TAGS ARE NOT A FIELD. Unlike Jira's `labels` array and Linear's `labelIds`,
 *     Asana's tags cannot be set on `PUT /tasks/{gid}` at all — they are managed
 *     through dedicated `addTag`/`removeTag` endpoints, one call per tag. So the
 *     lens DIFFS the requested set against the current one and issues only the
 *     changes, which is both the only available shape and the cheapest one.
 */

/**
 * The opt_fields the lens read requests.
 *
 * Asana returns a COMPACT record (`gid` + `resource_type` only) for every nested
 * resource unless the field is named explicitly — so `assignee` alone yields a
 * gid with no name, and `assignee.name` must be asked for separately. Every
 * nested name below is there for that reason, not for completeness.
 */
const LENS_TASK_OPT_FIELDS = [
  'gid',
  'name',
  'completed',
  'permalink_url',
  'due_on',
  'due_at',
  'assignee',
  'assignee.name',
  'assignee.email',
  'projects',
  'projects.name',
  'memberships.project',
  'memberships.project.name',
  'memberships.section',
  'memberships.section.name',
  'tags',
  'tags.name',
].join(',')

/**
 * Asana's three editable lens fields.
 *
 * STATIC, unlike Jira's editmeta-derived set: Asana has no per-task field-level
 * permission model to probe — a user who can see a task can edit its assignee,
 * due date and tags. Priority is false because the field does not exist (see the
 * module docblock), not because it is locked.
 */
export const ASANA_LENS_EDITABLE: LensEditable = {
  assignee: true,
  priority: false,
  due_date: true,
  labels: true,
}

interface AsanaLensTask {
  gid?: string
  name?: unknown
  completed?: boolean
  permalink_url?: unknown
  due_on?: unknown
  due_at?: unknown
  assignee?: { gid?: string; name?: unknown; email?: unknown } | null
  projects?: Array<{ gid?: string; name?: unknown }> | null
  memberships?: Array<{
    project?: { gid?: string; name?: unknown } | null
    section?: { gid?: string; name?: unknown } | null
  }> | null
  tags?: Array<{ gid?: string; name?: unknown }> | null
}

/** `GET /tasks/{gid}` with the lens's expanded opt_fields. */
export async function getTaskForLens(
  accessToken: string,
  taskGid: string,
): Promise<AsanaLensTask | null> {
  const params = new URLSearchParams({ opt_fields: LENS_TASK_OPT_FIELDS })
  const data = (await asanaFetch(
    accessToken,
    // Validated rather than encoded, matching every other gid interpolation in
    // the Asana client: a gid carrying `/` or `?` would not fail, it would
    // silently re-point the request at a different Asana endpoint under this
    // workspace's own token.
    `/tasks/${assertAsanaGid('taskGid', taskGid)}?${params.toString()}`,
  )) as AsanaLensTask | null
  return data ?? null
}

/**
 * `PUT /tasks/{gid}` — set task fields. Returns the updated task.
 *
 * Asana's flat PUT semantics, already proven by `updateTaskCompleted` for one
 * field. Generalized here rather than in asana-api.ts so the lens's expanded
 * opt_fields travel with it: the response is the lens's read-back, so it must
 * carry every field the lens renders, not the four-field `TASK_OPT_FIELDS` the
 * push cares about.
 */
export async function updateTaskFields(
  accessToken: string,
  taskGid: string,
  fields: Record<string, unknown>,
): Promise<AsanaLensTask | null> {
  const params = new URLSearchParams({ opt_fields: LENS_TASK_OPT_FIELDS })
  const data = (await asanaFetch(
    accessToken,
    `/tasks/${assertAsanaGid('taskGid', taskGid)}?${params.toString()}`,
    { method: 'PUT', body: JSON.stringify({ data: fields }) },
  )) as AsanaLensTask | null
  return data ?? null
}

/** `POST /tasks/{gid}/addTag` — attach one tag. */
export async function addTaskTag(
  accessToken: string,
  taskGid: string,
  tagGid: string,
): Promise<void> {
  await asanaFetch(accessToken, `/tasks/${assertAsanaGid('taskGid', taskGid)}/addTag`, {
    method: 'POST',
    body: JSON.stringify({ data: { tag: assertAsanaGid('tagGid', tagGid) } }),
  })
}

/** `POST /tasks/{gid}/removeTag` — detach one tag. */
export async function removeTaskTag(
  accessToken: string,
  taskGid: string,
  tagGid: string,
): Promise<void> {
  await asanaFetch(accessToken, `/tasks/${assertAsanaGid('taskGid', taskGid)}/removeTag`, {
    method: 'POST',
    body: JSON.stringify({ data: { tag: assertAsanaGid('tagGid', tagGid) } }),
  })
}

/**
 * `GET /workspaces/{gid}/tags` — the workspace's tags, for the lens's tag picker.
 *
 * Workspace-scoped, not project-scoped: an Asana tag belongs to a workspace and
 * is applicable to any task in it, which is why the option route this backs takes
 * `workspace` rather than `project`.
 *
 * Single page. Asana's tag lists are small in practice and a tag picker is a
 * filter-as-you-type affordance rather than an exhaustive browse — the same
 * decision `listSections` makes next door.
 */
export async function listWorkspaceTags(
  accessToken: string,
  workspaceGid: string,
  options: { limit?: number } = {},
): Promise<AsanaNamedResource[]> {
  const params = new URLSearchParams({ opt_fields: 'gid,name' })
  if (options.limit) params.set('limit', String(options.limit))
  const data = (await asanaFetch(
    accessToken,
    `/workspaces/${assertAsanaGid('workspaceGid', workspaceGid)}/tags?${params.toString()}`,
  )) as AsanaNamedResource[] | null
  return data ?? []
}

/**
 * Normalize an Asana task into lens fields.
 *
 * The project/section pair comes from the FIRST membership when there is one, and
 * falls back to the first `projects` entry when the task is in a project with no
 * section placement — `memberships` is the richer source (it carries the section)
 * but `projects` is the one always populated.
 */
export function asanaLensFields(task: AsanaLensTask | null | undefined): LensFields {
  const memberships = Array.isArray(task?.memberships) ? task.memberships : []
  const projects = Array.isArray(task?.projects) ? task.projects : []
  const firstMembership = memberships[0]

  const project =
    lensRef(firstMembership?.project?.gid, firstMembership?.project?.name) ??
    lensRef(projects[0]?.gid, projects[0]?.name)

  const labels: LensFields['labels'] = []
  for (const tag of Array.isArray(task?.tags) ? task.tags : []) {
    const ref = lensRef(tag?.gid, tag?.name)
    if (ref) labels.push(ref)
  }

  return {
    project,
    // Asana has neither concept — its closest analogue to a status is `section`,
    // reported below, and to an issue type nothing at all.
    issue_type: null,
    team: null,
    section: lensRef(firstMembership?.section?.gid, firstMembership?.section?.name),
    assignee: lensRef(task?.assignee?.gid, task?.assignee?.name, task?.assignee?.email),
    // See the module docblock: there is no field to read.
    priority: null,
    // `due_on` is the date-only field and `due_at` the timestamp; Asana keeps them
    // mutually exclusive and clears one when the other is set, so either can be
    // the populated one. Both are sliced to a date because the lens chip is a date.
    due_date: lensDateOnly(task?.due_on) ?? lensDateOnly(task?.due_at),
    labels,
  }
}

/**
 * Build the `PUT /tasks/{gid}` payload from a parsed update.
 *
 * Tags are deliberately ABSENT from this payload — Asana does not accept a `tags`
 * array on the task PUT, and they are diffed through addTag/removeTag instead.
 *
 * `due_on: null` is how a due date is cleared. Sending `due_on` alone (never
 * `due_at`) matches the push's own override path: the panel collects a date, and
 * naming one of the two mutually-exclusive fields clears the other for free.
 */
export function asanaLensPayload(update: LensFieldUpdate): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  if ('assignee_id' in update) {
    fields.assignee = update.assignee_id
  }
  if ('due_date' in update) {
    fields.due_on = update.due_date
  }
  return fields
}

/**
 * The add/remove tag diff for a full-replacement `label_ids`.
 *
 * Order-insensitive and duplicate-tolerant on both sides: the panel submits a set
 * and Asana returns a list, and a tag that appears in both is a no-op rather than
 * a remove-then-add (which would churn the task's activity feed with two events
 * for a gesture that changed nothing).
 */
export function diffTags(
  current: Array<{ id: string }>,
  desired: string[],
): { add: string[]; remove: string[] } {
  const currentIds = new Set(current.map((tag) => tag.id))
  const desiredIds = new Set(desired)
  return {
    add: [...desiredIds].filter((id) => !currentIds.has(id)),
    remove: [...currentIds].filter((id) => !desiredIds.has(id)),
  }
}

/**
 * Map a thrown Asana client error into a lens failure.
 *
 * The 404 mapping is where Asana diverges from the other two, and the divergence
 * is correct: an Asana gid is globally unique and permanent, so a 404 really does
 * mean the task is gone — which is why `apply-remote-task-state.ts` already
 * stamps the TERMINAL `task_deleted` for exactly this case. Jira's and Linear's
 * "gone" signals are ambiguous (see their link markers) and stay retryable;
 * Asana's is not, so the panel can honestly say the task was deleted.
 *
 * A 429 is reported rather than slept on, for the same reason as Jira's: the
 * shared transport has already spent its retries, and a panel is waiting.
 */
export function asanaLensFailure(err: unknown, context: string): LensResult {
  if (err instanceof AsanaUnauthorizedError) {
    return { ok: false, code: 'reconnect_required', error: 'Reconnect Asana to continue' }
  }
  if (err instanceof AsanaApiError && err.status === 404) {
    return {
      ok: false,
      code: 'task_deleted',
      error: 'This Asana task was deleted.',
    }
  }
  if (err instanceof AsanaApiError && err.status === 429) {
    return {
      ok: false,
      code: 'provider_error',
      error: 'Asana is rate limiting this workspace right now. Try again in a moment.',
    }
  }
  // A malformed gid is the CALLER's mistake — the link row's external_id, or a
  // tag gid off the picker — so it is reported as a provider_error carrying the
  // field name rather than logged as an outage.
  if (err instanceof AsanaInvalidGidError) {
    return { ok: false, code: 'provider_error', error: err.message }
  }
  console.error(`[asana-lens] ${context} failed:`, err)
  return {
    ok: false,
    code: 'provider_error',
    error: err instanceof Error ? err.message : `Failed to ${context}`,
  }
}

interface AsanaLensArgs {
  workspaceId: string
  link: LensLinkRow
}

async function resolveAsanaLens(
  args: AsanaLensArgs,
): Promise<{ token: string; workspaceGid: string | null } | LensResult> {
  const syncState = await loadAsanaSyncState(args.workspaceId)
  if (!syncState) {
    return {
      ok: false,
      code: 'not_connected',
      error: 'Asana is not connected for this workspace',
    }
  }
  const resolved = await getValidTokenForAccount(syncState.accountId)
  if (!resolved) {
    return { ok: false, code: 'reconnect_required', error: 'Reconnect Asana to continue' }
  }
  return {
    token: resolved.token,
    // The Asana workspace gid is CONFIG-only: `action_external_task` has no
    // `external_scope` for asana (a gid needs no container to be identified), so
    // the user/tag pickers are scoped by the workspace's current destination.
    workspaceGid: syncState.config.asana_workspace_gid ?? null,
  }
}

function asanaOptionScope(
  workspaceGid: string | null,
  task: AsanaLensTask | null | undefined,
): LensOptionScope {
  const scope: LensOptionScope = {}
  if (workspaceGid) scope.workspace_gid = workspaceGid
  const fields = asanaLensFields(task)
  // The task's OWN project, not the config's: the sections picker must offer the
  // columns of the project this task actually lives in, which need not be the
  // project the workspace currently pushes to.
  if (fields.project) scope.project_id = fields.project.id
  return scope
}

function asanaLensDetails(args: {
  link: LensLinkRow
  task: AsanaLensTask
  workspaceGid: string | null
}): LensDetails {
  return {
    ok: true,
    provider: 'asana',
    link_id: args.link.id,
    url: lensText(args.task.permalink_url) ?? args.link.external_url,
    title: lensText(args.task.name) ?? args.link.external_title,
    // Asana has no status enum — completion is a boolean and placement is a
    // section. The section is already a field, so the status line reports the one
    // thing the boolean says.
    status_name: args.task.completed === true ? 'Completed' : 'Incomplete',
    fields: asanaLensFields(args.task),
    editable: ASANA_LENS_EDITABLE,
    option_scope: asanaOptionScope(args.workspaceGid, args.task),
  }
}

/** Read a linked Asana task's current fields. ONE call — Asana needs no meta probe. */
export async function readAsanaTaskDetails(args: AsanaLensArgs): Promise<LensResult> {
  const resolved = await resolveAsanaLens(args)
  if ('ok' in resolved) return resolved

  try {
    const task = await getTaskForLens(resolved.token, args.link.external_id)
    if (!task?.gid) {
      // Asana answers a missing task with a 404, handled below — a 2xx with no
      // task is not a documented shape, but rendering a lens over nothing would
      // be worse than reporting the terminal state its 404 means.
      return { ok: false, code: 'task_deleted', error: 'This Asana task was deleted.' }
    }
    return asanaLensDetails({ link: args.link, task, workspaceGid: resolved.workspaceGid })
  } catch (err) {
    return asanaLensFailure(err, 'read the Asana task')
  }
}

/**
 * Write lens fields to a linked Asana task, then read them back.
 *
 * ORDER MATTERS, and it is: read current tags (only when tags are being changed)
 * → PUT the flat fields → apply the tag diff → read back.
 *
 * The tag diff needs the CURRENT set, and the only place to get it is a read — so
 * a tags-only edit costs an extra round trip that an assignee-only edit does not.
 * That read is skipped entirely when `label_ids` is absent, which is what keeps
 * the common single-chip edit at one write plus one read-back.
 *
 * Tag calls are sequential rather than parallel: they mutate the same task, and
 * Asana's per-object rate limiting is precisely the case its 429 handling exists
 * for — firing ten addTag calls at once against one task is the shape most likely
 * to trip it.
 */
export async function updateAsanaTaskFields(
  args: AsanaLensArgs & { update: LensFieldUpdate },
): Promise<LensResult> {
  const resolved = await resolveAsanaLens(args)
  if ('ok' in resolved) return resolved
  const { token } = resolved

  try {
    const desiredTags = args.update.label_ids
    let tagDiff: { add: string[]; remove: string[] } | null = null
    if (desiredTags !== undefined) {
      const current = await getTaskForLens(token, args.link.external_id)
      if (!current?.gid) {
        return { ok: false, code: 'task_deleted', error: 'This Asana task was deleted.' }
      }
      tagDiff = diffTags(asanaLensFields(current).labels, desiredTags)
    }

    const payload = asanaLensPayload(args.update)
    // An empty payload is an ordinary tags-only edit, and PUTting `{}` would be a
    // wasted round trip that also bumps the task's modified timestamp for nothing.
    let task = Object.keys(payload).length > 0
      ? await updateTaskFields(token, args.link.external_id, payload)
      : null

    if (tagDiff) {
      for (const tagGid of tagDiff.remove) {
        await removeTaskTag(token, args.link.external_id, tagGid)
      }
      for (const tagGid of tagDiff.add) {
        await addTaskTag(token, args.link.external_id, tagGid)
      }
      // The PUT's response predates the tag calls, so it is discarded and the task
      // re-read: reconciling the panel against a body that does not yet carry the
      // tags just added would flash them away and back.
      task = await getTaskForLens(token, args.link.external_id)
    }

    if (!task?.gid) {
      task = await getTaskForLens(token, args.link.external_id)
    }
    if (!task?.gid) {
      return {
        ok: false,
        code: 'task_deleted',
        error: 'The Asana task was updated but could not be read back',
      }
    }

    return asanaLensDetails({ link: args.link, task, workspaceGid: resolved.workspaceGid })
  } catch (err) {
    return asanaLensFailure(err, 'update the Asana task')
  }
}
