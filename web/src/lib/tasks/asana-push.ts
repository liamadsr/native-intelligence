import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/admin'
import {
  AsanaApiError,
  AsanaUnauthorizedError,
  createTask,
  deleteTask,
  type CreateTaskInput,
} from '@/lib/integrations/asana-api'
import { getValidTokenForAccount } from '@/lib/oauth/token-manager'
import {
  ASANA_PROVIDER,
  includesAsanaAttribution,
  loadAsanaSyncState,
  sectionForBucket,
} from './asana-config'
import { bucketForCategory } from './lifecycle'
import type { AsanaPushOverrides } from './push-overrides'
import { appUrl } from '@/lib/app-url'

/**
 * Push ONE Native Intelligence action to Asana as a task, and record the link.
 *
 * The single implementation behind all three push surfaces — the "Push to…"
 * menu (`PushToTrackerMenu`, in the action detail panel's toolbar and on a
 * capture's extracted action items, both via POST
 * /api/account/actions/[id]/asana), the AI chat tool `push_action_to_asana`,
 * and its MCP twin `ni_push_action_to_asana`. They differ only in how they
 * resolve the action and shape the reply.
 *
 * v1 is deliberately MANUAL: nothing pushes automatically. Every gate returns a
 * coded, non-throwing result so each caller can render its own hint (the menu
 * offers an "Open settings" CTA into Settings → Connectors → Asana on
 * 'not_configured') rather than showing a stack trace.
 *
 * Idempotency has two layers, and the SECOND one is the real guard. Before
 * creating anything we look for an existing link row for (action_id, 'asana')
 * and return it untouched — one action, one Asana task. That pre-check is a
 * check-then-act, so two pushes started at once (two tabs, or the panel button
 * racing the AI/MCP tool) can both pass it and both create a task. The database
 * settles it: UNIQUE (action_id, provider) — deliberately WITHOUT external_id,
 * so two different gids collide instead of both landing — admits exactly one
 * link row. The loser catches 23505, re-reads the winning row, DELETES the Asana
 * task it just orphaned, and reports the winner with created:false. The same
 * handler absorbs an Inngest/AI retry replaying a create that already landed.
 *
 * `overrides` is the compose panel's per-push destination (see push-overrides.ts).
 * ABSENT MEANS TODAY'S BEHAVIOUR, byte for byte. The one override with a
 * non-obvious consequence is the project: see the section rule at step 5.
 */

export type AsanaPushFailureCode =
  | 'action_not_found'
  | 'not_connected'
  | 'not_configured'
  | 'unauthorized'
  // Asana refused the create over its input — a section that was deleted or
  // belongs to another project, a project the token lost access to. Coded
  // rather than thrown so the route answers 400 with something the panel can
  // render, matching the Jira and Linear siblings; before the compose panel
  // made a stale section an ordinary user-facing event, this escaped as an
  // uncoded 500 carrying Asana's raw message.
  | 'push_failed'

export interface AsanaTaskLink {
  id: string
  action_id: string
  provider: string
  external_id: string
  external_url: string | null
  external_title: string | null
  completed: boolean
  created_at?: string
  last_synced_at?: string | null
}

export type AsanaPushResult =
  | { ok: true; link: AsanaTaskLink; created: boolean }
  | { ok: false; code: AsanaPushFailureCode; error: string }

interface PushArgs {
  actionId: string
  workspaceId: string
  /** auth.users id of the actor — stamped on the link row as created_by. */
  userId: string
  /** Caller's client: RLS-scoped from a route, service-role from Inngest/MCP. */
  supabase: SupabaseClient
  /**
   * One-shot destination overrides from the compose panel. Absent = the
   * workspace config alone, which is the only path that existed before.
   */
  overrides?: AsanaPushOverrides
}

/** Escape a plain-text string for embedding in Asana's HTML notes subset. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** App origin for the "back to Native Intelligence" deep link. */
function appBaseUrl(): string {
  return appUrl()
}

/**
 * Deep link to an action. Matches the `action.url` token Flows put in outbound
 * bodies (src/lib/flows/template.ts) — one URL shape for every outbound
 * reference to an action.
 */
export function actionDeepLink(actionId: string): string {
  return `${appBaseUrl()}/account?action=${actionId}`
}

/**
 * Build the task body. Asana accepts a small HTML subset via `html_notes` and
 * REQUIRES the `<body>` wrapper — a bare fragment is a 400. `notes` (plain
 * text) is the mutually-exclusive alternative; we send html_notes only, so the
 * deep link renders as a real anchor.
 *
 * `attribution` gates Native Intelligence's two fingerprints — the identifier heading and the
 * "Pushed from Native Intelligence" backlink — as ONE unit, because they are one idea: this
 * task came from somewhere, and here is the way back. Defaulted to true so a
 * caller that forgets to thread it gets today's behaviour rather than silently
 * stripping provenance. With it off the notes are the action's own description
 * and nothing else, which can be EMPTY — `<body></body>` is what Asana wants for
 * a task with no notes, and is what an un-attributed action with no description
 * honestly is.
 */
export function buildHtmlNotes(args: {
  actionId: string
  identifier: string | null
  description: string | null
  attribution?: boolean
}): string {
  const attribution = args.attribution !== false
  const parts: string[] = []
  const label = args.identifier ?? 'this action'
  if (attribution && args.identifier) {
    parts.push(`<strong>${escapeHtml(args.identifier)}</strong>`)
  }
  const description = args.description?.trim()
  if (description) {
    parts.push(escapeHtml(description))
  }
  if (attribution) {
    parts.push(
      `Pushed from Native Intelligence: <a href="${escapeHtml(actionDeepLink(args.actionId))}">` +
        `${escapeHtml(label)}</a>`,
    )
  }
  return `<body>${parts.join('\n\n')}</body>`
}

/**
 * Split a stored due timestamp into the ONE due field Asana accepts.
 *
 * Asana rejects a task carrying both `due_on` and `due_at`, so an all-day
 * action sends the date only and a timed one sends the full ISO instant. The
 * date is sliced off the stored string when it already starts with YYYY-MM-DD
 * (the common case) rather than round-tripped through Date, which would shift
 * an all-day date across a timezone boundary.
 */
export function dueFieldsFor(
  dueAt: string | null | undefined,
  allDay: boolean | null | undefined,
): { due_on?: string; due_at?: string } {
  if (!dueAt) return {}
  if (!allDay) return { due_at: dueAt }
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(dueAt)
  if (match) return { due_on: match[1] }
  const parsed = new Date(dueAt)
  if (Number.isNaN(parsed.getTime())) return {}
  return { due_on: parsed.toISOString().slice(0, 10) }
}

interface ActionRow {
  id: string
  identifier: string | null
  title: string | null
  description: string | null
  due_at: string | null
  all_day: boolean | null
  assignee_id: string | null
  workflow_state: { category: string | null } | null
}

/**
 * Best-effort assignee email.
 *
 * Asana's `assignee` field accepts a user gid OR a plain email address, and we
 * have no Asana gid for a Native Intelligence member — so the email is the only bridge. It
 * lives on auth.users (member carries only display_name), which needs the
 * service client. Returns null on any failure: an unassigned Asana task is a far
 * better outcome than a failed push.
 */
async function resolveAssigneeEmail(
  supabase: SupabaseClient,
  memberId: string,
  workspaceId: string,
): Promise<string | null> {
  try {
    const { data: member } = await supabase
      .from('member')
      .select('user_id')
      .eq('id', memberId)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    const memberUserId = member?.user_id as string | undefined
    if (!memberUserId) return null

    const { data } = await getServiceClient().auth.admin.getUserById(memberUserId)
    return data?.user?.email ?? null
  } catch (err) {
    console.warn('[asana-push] assignee email lookup failed (pushing unassigned):', err)
    return null
  }
}

export async function pushActionToAsana(args: PushArgs): Promise<AsanaPushResult> {
  const { actionId, workspaceId, userId, supabase, overrides } = args

  // 1. Load the action + the category of its current workflow state (the input
  //    to the lifecycle fold that decides section placement).
  const { data: actionData } = await supabase
    .from('actions')
    .select(
      'id, identifier, title, description, due_at, all_day, assignee_id, ' +
        'workflow_state:workflow_state!status_id(category)',
    )
    .eq('id', actionId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()

  if (!actionData) {
    return { ok: false, code: 'action_not_found', error: 'Action not found' }
  }
  const raw = actionData as unknown as Record<string, unknown>
  const stateRaw = raw.workflow_state
  const state = (Array.isArray(stateRaw) ? stateRaw[0] : stateRaw) as
    | { category: string | null }
    | null
    | undefined
  const action: ActionRow = {
    id: raw.id as string,
    identifier: (raw.identifier as string | null) ?? null,
    title: (raw.title as string | null) ?? null,
    description: (raw.description as string | null) ?? null,
    due_at: (raw.due_at as string | null) ?? null,
    all_day: (raw.all_day as boolean | null) ?? null,
    assignee_id: (raw.assignee_id as string | null) ?? null,
    workflow_state: state ?? null,
  }

  // 2. Already linked? Return the existing link rather than minting a second
  //    Asana task for the same action.
  const { data: existing } = await supabase
    .from('action_external_task')
    .select('*')
    .eq('action_id', actionId)
    .eq('provider', ASANA_PROVIDER)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (existing) {
    return { ok: true, link: existing as AsanaTaskLink, created: false }
  }

  // 3. Destination. No connected account → 'not_connected'; connected but no
  //    project chosen → 'not_configured' (the UI hints differ: connect vs. pick).
  const syncState = await loadAsanaSyncState(workspaceId)
  if (!syncState) {
    return {
      ok: false,
      code: 'not_connected',
      error: 'Asana is not connected for this workspace',
    }
  }
  const projectGid = overrides?.project_gid ?? syncState.config.project_gid
  if (!projectGid) {
    return {
      ok: false,
      code: 'not_configured',
      error: 'Pick an Asana project in Settings → Connectors → Asana first',
    }
  }

  // 4. Token. A dead/absent token reads the same as a revoked app to the user,
  //    and both are fixed by reconnecting.
  const resolvedToken = await getValidTokenForAccount(syncState.accountId)
  if (!resolvedToken) {
    return { ok: false, code: 'unauthorized', error: 'Reconnect Asana to continue' }
  }

  // 5. Build the create payload.
  //
  // THE SECTION RULE, and the one override consequence worth spelling out: a
  // section gid belongs to exactly ONE project. So an overridden project makes
  // the config's section_map meaningless — the section it maps the action's
  // lifecycle bucket to lives in a different project and Asana would reject it.
  // The map is therefore SUPPRESSED wholesale when the project is overridden,
  // and the only section that can apply is one the panel explicitly picked from
  // the overridden project's own sections. Landing unsectioned in the right
  // project is the honest outcome; landing in the wrong project's column is not
  // an outcome at all.
  const bucket = bucketForCategory(action.workflow_state?.category ?? '')
  const mappedSectionGid = overrides?.project_gid
    ? null
    : sectionForBucket(syncState.config, bucket)
  // Key presence, not `??`: `section_gid: null` is the user picking "No section"
  // on a config whose section_map WOULD have placed the task. Folding that to
  // absent reinstated the mapped section, so the task landed in a column the
  // panel said it would not. Absent still inherits the map.
  const sectionGid =
    overrides && 'section_gid' in overrides
      ? (overrides.section_gid ?? null)
      : mappedSectionGid

  // An OVERRIDDEN assignee is a real Asana user gid picked from that workspace's
  // own list, so it bypasses the email bridge entirely. Asana's `assignee` field
  // accepts a gid or an email interchangeably, which is what lets one field carry
  // both paths.
  // An explicit null means "unassigned" and suppresses the email bridge — the
  // panel showed Unassigned and the user left it that way on purpose.
  const assigneeCleared =
    !!overrides && 'assignee_gid' in overrides && overrides.assignee_gid === null
  const assigneeEmail =
    !overrides?.assignee_gid && !assigneeCleared && action.assignee_id
      ? await resolveAssigneeEmail(supabase, action.assignee_id, workspaceId)
      : null
  const assignee = overrides?.assignee_gid ?? assigneeEmail

  const payload: CreateTaskInput = {
    name: overrides?.title ?? (action.title?.trim() || action.identifier || 'Untitled action'),
    // memberships places the task in a SECTION at create time; projects is the
    // plain "just put it in the project" form. Asana rejects both together, and
    // either one is what resolves the create to a single workspace.
    ...(sectionGid
      ? { memberships: [{ project: projectGid, section: sectionGid }] }
      : { projects: [projectGid] }),
    // The attribution flag is read from the config loaded ABOVE and passed in
    // explicitly, never re-read inside the builder: one load per push, and the
    // builder stays a pure function of its arguments (which is what lets the
    // tests pin its exact output both ways).
    html_notes: buildHtmlNotes({
      actionId: action.id,
      identifier: action.identifier,
      description: action.description,
      attribution: includesAsanaAttribution(syncState.config),
    }),
    // An overridden due date is always date-only: the panel collects a date, and
    // `due_on`/`due_at` are mutually exclusive (Asana clears one when the other
    // is set), so sending `due_on` alone is both correct and complete. Without
    // an override the action's own all-day flag picks between the two, exactly
    // as before.
    // An explicit null clears it: no due field at all, rather than the action's.
    ...(overrides && 'due_on' in overrides
      ? overrides.due_on
        ? { due_on: overrides.due_on }
        : {}
      : dueFieldsFor(action.due_at, action.all_day)),
    ...(assignee ? { assignee } : {}),
  }

  // 6. Create. The assignee is the one field Asana can reject for reasons we
  //    can't predict (the email isn't a member of that Asana workspace, or is a
  //    guest without project access) — and it's the least important field on the
  //    task. So a 4xx while an assignee is set earns exactly one retry WITHOUT
  //    it; anything else propagates.
  let task
  try {
    task = await createTask(resolvedToken.token, payload)
  } catch (err) {
    // Covers BOTH assignee shapes: a resolved Native Intelligence email that isn't a member of
    // the Asana workspace, and a picked gid that has since lost project access.
    // Either way the task matters more than who it lands on.
    //
    // The MESSAGE is inspected, not just the status: a 4xx over a stale section
    // has nothing to do with the assignee, and retrying without the assignee
    // keeps the bad section — burning a round trip on a misdiagnosis and then
    // failing anyway. Asana names the offending field in its message.
    const isAssigneeCandidate =
      !!assignee &&
      err instanceof AsanaApiError &&
      err.status >= 400 &&
      err.status < 500 &&
      /assignee/i.test(err.message)
    if (!isAssigneeCandidate) {
      if (err instanceof AsanaUnauthorizedError) {
        return { ok: false, code: 'unauthorized', error: 'Reconnect Asana to continue' }
      }
      // A 4xx is Asana refusing the INPUT — a section that no longer exists or
      // sits in another project, a project the token can't write. That is the
      // user's to fix, so it is reported as a coded failure the panel can render
      // (the Jira and Linear pushes both do this) rather than thrown into the
      // route's catch-all, where it became a 500 carrying Asana's raw message.
      // A 5xx still propagates: transient, and worth a retry at a higher level.
      if (err instanceof AsanaApiError && err.status >= 400 && err.status < 500) {
        return {
          ok: false,
          code: 'push_failed',
          error:
            `Asana rejected the task: ${err.message} ` +
            'Re-pick the project and section, then push again.',
        }
      }
      throw err
    }
    console.warn(
      `[asana-push] create rejected with assignee ${assignee} for action ` +
        `${actionId}; retrying unassigned.`,
    )
    const { assignee: _assignee, ...withoutAssignee } = payload
    void _assignee
    try {
      task = await createTask(resolvedToken.token, withoutAssignee)
    } catch (retryErr) {
      if (retryErr instanceof AsanaUnauthorizedError) {
        return { ok: false, code: 'unauthorized', error: 'Reconnect Asana to continue' }
      }
      // Same rule on the second attempt: dropping the assignee did not help, so
      // whatever Asana is refusing is in the rest of the input and the user has
      // to fix it. Coded, not thrown.
      if (retryErr instanceof AsanaApiError && retryErr.status >= 400 && retryErr.status < 500) {
        return {
          ok: false,
          code: 'push_failed',
          error:
            `Asana rejected the task: ${retryErr.message} ` +
            'Re-pick the project and section, then push again.',
        }
      }
      throw retryErr
    }
  }

  // 7. Record the link.
  const { data: inserted, error: insertError } = await supabase
    .from('action_external_task')
    .insert({
      workspace_id: workspaceId,
      action_id: actionId,
      provider: ASANA_PROVIDER,
      external_id: task.gid,
      external_url: task.permalink_url ?? null,
      external_title: task.name ?? payload.name,
      completed: task.completed ?? false,
      created_by: userId,
      last_synced_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (insertError) {
    // 23505 = the UNIQUE (action_id, provider) index fired: a concurrent push
    // (or an Inngest/AI retry replaying a create that already landed) got there
    // first. The row that won is the truth — read it back (by action+provider,
    // NOT by our gid: the winner almost certainly carries a different one) and
    // report the link rather than surfacing a constraint error for a state the
    // caller actually wanted.
    if ((insertError as { code?: string }).code === '23505') {
      const { data: raced } = await supabase
        .from('action_external_task')
        .select('*')
        .eq('action_id', actionId)
        .eq('provider', ASANA_PROVIDER)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle()
      if (raced) {
        const winner = raced as AsanaTaskLink
        // We lost, so the task THIS call just created is an orphan: nothing
        // links to it and the action already points at the winner's task.
        // Best-effort delete so the user isn't left with a duplicate in Asana
        // (deleteTask never throws — a tidy-up failure must not fail the push).
        if (winner.external_id !== task.gid) {
          await deleteTask(resolvedToken.token, task.gid)
        }
        console.warn(
          `[asana-push] lost the link race for action ${actionId} ` +
            `(kept asana task ${winner.external_id})` +
            (winner.external_id !== task.gid
              ? `; deleted the orphaned task ${task.gid}.`
              : '.'),
        )
        return { ok: true, link: winner, created: false }
      }
    }
    throw new Error(insertError.message)
  }

  return { ok: true, link: inserted as AsanaTaskLink, created: true }
}
