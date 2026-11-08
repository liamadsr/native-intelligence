import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/admin'
import {
  createIssue,
  deleteIssue,
  findUserByEmail,
  issueStateName,
  issueStateType,
  isLinearInputError,
  listTeamStates,
  LinearUnauthorizedError,
  type CreateIssueInput,
} from '@/lib/integrations/linear-api'
import { getValidTokenForAccount } from '@/lib/oauth/token-manager'
import { deriveLinearStateMap, linearBucketForStateType } from './lifecycle'
import {
  LINEAR_PROVIDER,
  includesLinearAttribution,
  isLinearDestinationConfigured,
  loadLinearSyncState,
  stateForBucket,
} from './linear-config'
import type { LinearPushOverrides } from './push-overrides'

/**
 * Push ONE Native Intelligence action to Linear as an issue, and record the link.
 *
 * The single implementation behind all three push surfaces — the "Push to…"
 * menu (`PushToTrackerMenu`, in the action detail panel's toolbar and on a
 * capture's extracted action items, both via POST
 * /api/account/actions/[id]/linear), the AI chat tool `push_action_to_linear`,
 * and its MCP twin `dial8_push_action_to_linear`. They differ only in how they
 * resolve the action and shape the reply.
 *
 * Step-for-step sibling of jira-push.ts, including the idempotency model: a
 * check-then-act pre-check for an existing link, backed by the real guard —
 * UNIQUE (action_id, provider), deliberately WITHOUT external_id, so two
 * concurrent pushes minting two DIFFERENT issues collide instead of both
 * landing. The loser catches 23505, re-reads the winning row, best-effort
 * DELETEs the issue it just orphaned, and reports the winner with created:false.
 *
 * Four things are genuinely different from the Jira push, all of them Linear
 * being simpler rather than us choosing differently:
 *  - The body is MARKDOWN — a plain string. No ADF tree, no HTML escaping.
 *  - The ASSIGNEE is set ON THE CREATE. Linear's create input takes an
 *    `assigneeId`, so there is no post-create PUT that could fail separately;
 *    resolution is still best-effort and a miss simply omits the field.
 *  - The STATE is set on the create too, when the destination's derived map has
 *    a not_started entry, so a pushed issue lands where the workspace says
 *    not-started lives rather than in the team's default backlog/triage.
 *  - NO status read-back. Linear's create response returns the issue's state
 *    inline, where Jira's returns only `{id, key, self}` and forces a follow-up
 *    GET to learn the landing status.
 *
 * `overrides` is the compose panel's per-push destination (see push-overrides.ts).
 * ABSENT MEANS TODAY'S BEHAVIOUR, byte for byte. The team override is the one
 * that costs a round trip — see resolveStartState below for why the config's
 * state_map cannot travel with it.
 */

export type LinearPushFailureCode =
  | 'action_not_found'
  | 'not_connected'
  | 'not_configured'
  | 'unauthorized'
  /**
   * Linear REJECTED the create over its input, and stripping the optional fields
   * we can live without did not help — typically a team setting that forbids
   * something we sent, or a project/state id that has since been deleted. A
   * destination problem the user has to fix in Linear, so it is reported like
   * every other coded failure instead of thrown into the route's catch-all.
   */
  | 'push_failed'

export interface LinearTaskLink {
  id: string
  action_id: string
  provider: string
  /** The Linear issue UUID — permanent, and unchanged by a team move. */
  external_id: string
  external_url: string | null
  external_title: string | null
  /** The workflow state NAME ("Todo") — Linear's real status, like Jira's. */
  external_state_label?: string | null
  completed: boolean
  created_at?: string
  last_synced_at?: string | null
}

export type LinearPushResult =
  | { ok: true; link: LinearTaskLink; created: boolean }
  | { ok: false; code: LinearPushFailureCode; error: string }

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
  overrides?: LinearPushOverrides
}

/** App origin for the "back to Native Intelligence" deep link. */
function appBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || 'https://dial8.ai').replace(/\/$/, '')
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
 * Build the issue description as MARKDOWN.
 *
 * Linear stores descriptions as markdown text, which makes this the simplest of
 * the three builders: no ADF tree to assemble (Jira) and no HTML to escape
 * (Asana). There is also nothing to inject INTO — the action's own description
 * is emitted verbatim as body text, and markdown a user wrote in Native Intelligence rendering
 * as markdown in Linear is the desirable outcome, not a hazard.
 *
 * Returns null when there is nothing to say, so the caller can OMIT
 * `description` entirely rather than sending an empty string. That path is
 * reachable in exactly one way: attribution off AND no description.
 *
 * `attribution` gates Native Intelligence's two fingerprints — the bold identifier line and
 * the "Pushed from Native Intelligence" provenance line — as ONE unit, because they are one
 * idea: this issue came from somewhere, and here is the way back. Defaulted to
 * true so a caller that forgets to thread it gets today's behaviour rather than
 * silently stripping provenance.
 */
export function buildMarkdownDescription(args: {
  actionId: string
  identifier: string | null
  description: string | null
  attribution?: boolean
}): string | null {
  const attribution = args.attribution !== false
  const blocks: string[] = []

  const identifier = args.identifier?.trim()
  if (attribution && identifier) {
    blocks.push(`**${identifier}**`)
  }

  const description = args.description?.trim()
  if (description) {
    blocks.push(description)
  }

  // The provenance line ships UNLESS the workspace opted out: it is the only way
  // back from the issue to the action, and an issue with no trace of where it
  // came from is exactly the "notes that never become work" problem this
  // integration exists to solve — so it is on by default and off only on
  // purpose.
  if (attribution) {
    blocks.push(`Pushed from Native Intelligence: [${identifier || 'this action'}](${actionDeepLink(args.actionId)})`)
  }

  if (blocks.length === 0) return null
  // Blank line between blocks: markdown needs one to keep them separate
  // paragraphs rather than folding them into a single run of text.
  return blocks.join('\n\n')
}

/**
 * The TimelessDate (`YYYY-MM-DD`) Linear accepts for `dueDate`, or undefined.
 *
 * The date is sliced off the stored string when it already starts with
 * YYYY-MM-DD (the common case) rather than round-tripped through Date, which
 * would shift an all-day date across a timezone boundary.
 */
export function dueDateFor(dueAt: string | null | undefined): string | undefined {
  if (!dueAt) return undefined
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(dueAt)
  if (match) return match[1]
  const parsed = new Date(dueAt)
  if (Number.isNaN(parsed.getTime())) return undefined
  return parsed.toISOString().slice(0, 10)
}

/**
 * Fields the create sends that Native Intelligence can do without.
 *
 * Everything NOT on this list — `teamId`, `title` — is structurally required and
 * a rejection naming one is a real problem the user has to see. `stateId`,
 * `projectId`, `assigneeId` and `dueDate` are all droppable: each can be
 * rejected because the id was deleted in Linear since the destination was saved,
 * or because a team setting forbids it, and losing any of them is a far smaller
 * loss than losing the issue.
 *
 * The compose panel's two extra fields (`priority`, `labelIds`) are on the list
 * for the same reason. Membership here means "droppable IN PRINCIPLE"; whether a
 * field is actually dropped is decided at the retry, which re-adds every
 * override-supplied field first and strips only what the config contributed. So
 * `stripped` names what the user would genuinely lose, and an empty `stripped`
 * — nothing optional sent, or everything sent explicitly chosen — is reported as
 * a coded failure rather than silently degraded.
 */
const OPTIONAL_CREATE_FIELDS = [
  'dueDate',
  'assigneeId',
  'projectId',
  'stateId',
  'priority',
  'labelIds',
] as const

interface ActionRow {
  id: string
  identifier: string | null
  title: string | null
  description: string | null
  due_at: string | null
  assignee_id: string | null
  workflow_state: { category: string | null } | null
}

/**
 * Best-effort assignee email for a Native Intelligence member.
 *
 * The email lives on auth.users (member carries only display_name), which needs
 * the service client. Returns null on any failure — an unassigned Linear issue
 * is a far better outcome than a failed push.
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
    console.warn('[linear-push] assignee email lookup failed (pushing unassigned):', err)
    return null
  }
}

/**
 * Resolve a Native Intelligence assignee to a Linear user id. FULLY best-effort — every
 * failure path is a warn/null, never a throw.
 *
 * NO MATCH IS THE EXPECTED CASE, not an edge one: the member's Native Intelligence email is
 * whatever they signed up with and need not be the address in the customer's
 * Linear org. findUserByEmail already returns null unless there is exactly one
 * exact match, so there is no guessing to do here — assigning someone else's
 * colleague to their work is worse than leaving the issue unassigned.
 */
async function resolveLinearAssigneeId(
  accessToken: string,
  email: string,
): Promise<string | undefined> {
  try {
    const user = await findUserByEmail(accessToken, email)
    return user?.id ?? undefined
  } catch (err) {
    console.warn(
      '[linear-push] best-effort assignee lookup failed (issue stays unassigned) —',
      err instanceof Error ? err.message : String(err),
    )
    return undefined
  }
}

/**
 * The workflow state a pushed issue should START in, for whichever team it is
 * actually landing on.
 *
 * WHY THIS EXISTS, and why it is not a `??`: `config.state_map` is DERIVED from
 * the configured team's own workflow states (deriveLinearStateMap, run at
 * destination-save time), and a Linear workflow state belongs to exactly one
 * team. So when the compose panel overrides the team, every id in that map is a
 * state of a DIFFERENT team — passing one as `stateId` is at best rejected and
 * at worst, if Linear ever stopped rejecting it, lands the issue in a state its
 * own team cannot show. Inheriting the map across a team change is the single
 * most tempting wrong answer here.
 *
 * So the override path re-derives from source: read the overridden team's states
 * and fold them with the same pure function the settings save funnel uses, which
 * is what keeps a composed push and a configured push agreeing about where
 * "not started" is.
 *
 * BEST-EFFORT, deliberately. Omitting `stateId` lands the issue in the team's
 * own default (backlog or triage) — the same class of state this is trying to
 * pick, just less precisely — so a failed read costs placement, never the push.
 * That is also why it is not the caller's job to handle: there is no failure to
 * report.
 */
async function resolveStartState(
  accessToken: string,
  teamId: string,
): Promise<{ id: string; name: string } | null> {
  try {
    const states = await listTeamStates(accessToken, teamId)
    return deriveLinearStateMap(states).not_started ?? null
  } catch (err) {
    console.warn(
      `[linear-push] could not derive a start state for overridden team ${teamId} ` +
        '(issue lands in the team default) —',
      err instanceof Error ? err.message : String(err),
    )
    return null
  }
}

/** The coded failure for a create Linear refused over its input. */
function pushFailedOver(message: string): LinearPushResult {
  return {
    ok: false,
    code: 'push_failed',
    error:
      `Linear rejected the issue: ${message} ` +
      'Re-pick the team in Settings → Connectors → Linear, then push again.',
  }
}

export async function pushActionToLinear(args: PushArgs): Promise<LinearPushResult> {
  const { actionId, workspaceId, userId, supabase, overrides } = args

  // 1. Load the action. (Its workflow-state category is read for parity with the
  //    sibling pushes and for the echo that follows; the create itself always
  //    lands in the destination's not_started state, or the team's default when
  //    the map has no such entry.)
  const { data: actionData } = await supabase
    .from('actions')
    .select(
      'id, identifier, title, description, due_at, assignee_id, ' +
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
    assignee_id: (raw.assignee_id as string | null) ?? null,
    workflow_state: state ?? null,
  }

  // 2. Already linked? Return the existing link rather than minting a second
  //    Linear issue for the same action.
  const { data: existing } = await supabase
    .from('action_external_task')
    .select('*')
    .eq('action_id', actionId)
    .eq('provider', LINEAR_PROVIDER)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (existing) {
    return { ok: true, link: existing as LinearTaskLink, created: false }
  }

  // 3. Destination. No connected account → 'not_connected'; connected but no
  //    team picked → 'not_configured' (the UI hints differ: connect vs. pick).
  const syncState = await loadLinearSyncState(workspaceId)
  if (!syncState) {
    return {
      ok: false,
      code: 'not_connected',
      error: 'Linear is not connected for this workspace',
    }
  }
  const config = syncState.config
  // With NO override this is exactly isLinearDestinationConfigured(config); an
  // overridden team completes a destination the config never had, which is what
  // lets a compose panel push to a team before anyone visits settings.
  const teamId = overrides?.team_id ?? config.team_id
  if (!(overrides ? !!teamId : isLinearDestinationConfigured(config))) {
    return {
      ok: false,
      code: 'not_configured',
      error: 'Pick a Linear team in Settings → Connectors → Linear first',
    }
  }

  // 4. Token. A dead/absent token reads the same as a revoked app to the user,
  //    and both are fixed by reconnecting.
  const resolvedToken = await getValidTokenForAccount(syncState.accountId)
  if (!resolvedToken) {
    return { ok: false, code: 'unauthorized', error: 'Reconnect Linear to continue' }
  }
  const token = resolvedToken.token

  // 5. Build the create payload.
  const title = overrides?.title ?? (action.title?.trim() || action.identifier || 'Untitled action')
  // The attribution flag comes from the config loaded above and is passed in
  // explicitly, never re-read inside the builder — one load per push, and the
  // builder stays a pure function of its arguments.
  const description = buildMarkdownDescription({
    actionId: action.id,
    identifier: action.identifier,
    description: action.description,
    attribution: includesLinearAttribution(config),
  })
  // Key presence again: `due_date: null` is "no due date", not "use the
  // action's". The panel's date input renders empty, and an emptied one must
  // mean what it shows.
  const dueDate =
    overrides && 'due_date' in overrides
      ? (overrides.due_date ?? undefined)
      : dueDateFor(action.due_at)

  // Whether the push is landing on a team OTHER than the configured one. This is
  // the condition that invalidates the config's team-scoped derivations (the
  // state map and the project), and it is deliberately NOT "an override exists":
  // a panel that echoes the configured team back is the common case and must not
  // pay for the extra read below.
  const teamChanged = !!overrides?.team_id && overrides.team_id !== config.team_id

  // The derived not_started state, when the team has one. Absent is ordinary
  // (a team with no unstarted/backlog/triage state), and omitting stateId simply
  // lets Linear use the team's default — which is the same class of state.
  //
  // A CHANGED team re-derives from that team's own states rather than reusing
  // the map — see resolveStartState for why inheriting it is the tempting wrong
  // answer.
  const startState = teamChanged
    ? await resolveStartState(token, overrides!.team_id!)
    : stateForBucket(config, 'not_started')

  // The project is dropped rather than inherited when the team changes: Linear
  // projects are many-to-many with teams, so the configured project need not be
  // associated with the new team at all. An override that wants a project on
  // another team names it explicitly.
  //
  // KEY PRESENCE, not `??`: the panel sends `project_id: null` when the user
  // explicitly picked "No project" on a config that HAS one. `??` folded that
  // to absent and reinstated the config project — the issue landed in P while
  // the form said "No project". Absent still inherits, which is what an
  // untouched panel sends.
  const projectId =
    overrides && 'project_id' in overrides
      ? (overrides.project_id ?? undefined)
      : teamChanged
        ? undefined
        : config.project_id

  // Assignee resolved BEFORE the create, unlike the Jira push: Linear's create
  // input accepts assigneeId directly, so there is no separate call that could
  // fail after the issue exists. An OVERRIDDEN assignee is already a Linear user
  // id picked from that team's members, so it skips the email bridge entirely.
  // An explicit null means "unassigned" and SUPPRESSES the email bridge — the
  // panel showed "Unassigned" and the user left it that way deliberately, so
  // quietly resolving the action's Native Intelligence assignee would contradict the form.
  const assigneeCleared = !!overrides && 'assignee_id' in overrides && overrides.assignee_id === null
  let assigneeId: string | undefined = overrides?.assignee_id ?? undefined
  if (!assigneeId && !assigneeCleared && action.assignee_id) {
    const email = await resolveAssigneeEmail(supabase, action.assignee_id, workspaceId)
    if (email) assigneeId = await resolveLinearAssigneeId(token, email)
  }

  const input: CreateIssueInput = {
    teamId: teamId!,
    title,
    ...(description ? { description } : {}),
    ...(startState ? { stateId: startState.id } : {}),
    ...(projectId ? { projectId } : {}),
    ...(assigneeId ? { assigneeId } : {}),
    ...(dueDate ? { dueDate } : {}),
    // Compose-only fields, each sent ONLY when the panel supplied it. `priority`
    // is tested against undefined rather than truthiness: 0 is "No priority", a
    // real choice a user can make, and a falsy check would silently drop it.
    ...(overrides?.priority !== undefined ? { priority: overrides.priority } : {}),
    // `?.length`, not truthiness: the parser PRESERVES an empty array (so a
    // future "clear the labels" gesture stays expressible) and `[]` is truthy,
    // so a bare truthiness test would send `labelIds: []` where absent sends
    // nothing — the two must produce the same create payload today.
    ...(overrides?.label_ids?.length ? { labelIds: overrides.label_ids } : {}),
  }

  // 6. Create. A well-formed request can still be rejected over an id that has
  //    gone stale since the destination was saved (a deleted project or state)
  //    or a value a team setting forbids. An INPUT rejection earns exactly one
  //    retry with every optional field dropped: losing the due date and the
  //    project placement is a far smaller loss than losing the issue. Anything
  //    that is not an input rejection (a transient failure, a 5xx dressed as a
  //    GraphQL error) is NOT retried that way — the fields were not the problem.
  let issue
  try {
    issue = await createIssue(token, input)
  } catch (err) {
    if (err instanceof LinearUnauthorizedError) {
      return { ok: false, code: 'unauthorized', error: 'Reconnect Linear to continue' }
    }
    if (!isLinearInputError(err)) throw err

    // The retry keeps what the USER chose and gives up only what the CONFIG
    // supplied. "A far smaller loss than losing the issue" is true of a stale
    // config-derived project or state; it is not true of the assignee, project,
    // priority, labels and due date someone just picked in the compose panel —
    // dropping those and answering `created: true` hands back a success chip for
    // an issue nobody is working and no project contains. So explicit picks are
    // re-added below, and when NOTHING is left to strip that the user did not
    // choose, the push fails loudly instead (they are still in the panel, and
    // Linear's message names the offending entity). The Jira sibling protects
    // its explicit priority and custom fields the same way.
    //
    // With `overrides` absent every re-add is a no-op, so the retry input is
    // byte-identical to what it has always been.
    const retryInput: CreateIssueInput = { teamId: input.teamId, title: input.title }
    if (input.description !== undefined) retryInput.description = input.description
    // A cleared field (explicit null) is not re-added: there is nothing to keep,
    // and it was never in `input` to be stripped either.
    if (overrides?.project_id) retryInput.projectId = overrides.project_id
    if (overrides?.assignee_id) retryInput.assigneeId = overrides.assignee_id
    // Against undefined, not truthiness: priority 0 is "No priority", a real
    // choice, and a falsy test would silently drop the one value most likely to
    // have been deliberate.
    if (overrides?.priority !== undefined) retryInput.priority = overrides.priority
    // `?.length`, matching the original payload's test exactly. The parser
    // PRESERVES an empty array and `[]` is truthy, so a bare truthiness check
    // re-added `labelIds: []` to a retry whose first attempt had sent no
    // `labelIds` at all — making the retry payload differ from the original in a
    // field the rejection was not about.
    if (overrides?.label_ids?.length) retryInput.labelIds = overrides.label_ids
    if (overrides?.due_date) retryInput.dueDate = overrides.due_date

    // What the retry would actually give up: sent optional fields that are NOT
    // carried over. Empty means every optional field sent was explicit.
    const stripped = OPTIONAL_CREATE_FIELDS.filter(
      (field) => input[field] !== undefined && retryInput[field] === undefined,
    )
    if (stripped.length === 0) {
      // Either nothing optional was sent at all (the rejection is about teamId
      // or title), or everything sent was the user's own pick. Both are the
      // user's to fix, and neither is improved by a retry that changes nothing.
      return pushFailedOver(err instanceof Error ? err.message : String(err))
    }

    console.warn(
      `[linear-push] create rejected as invalid input for action ${actionId}; ` +
        `retrying without [${stripped.join(', ')}].`,
    )
    try {
      issue = await createIssue(token, retryInput)
    } catch (retryErr) {
      if (retryErr instanceof LinearUnauthorizedError) {
        return { ok: false, code: 'unauthorized', error: 'Reconnect Linear to continue' }
      }
      // Same rule on the second attempt: an input Linear still refuses with
      // nothing left to drop is a destination the user has to fix, not an outage
      // to retry.
      if (isLinearInputError(retryErr)) {
        return pushFailedOver(retryErr instanceof Error ? retryErr.message : String(retryErr))
      }
      throw retryErr
    }
  }

  // 7. Record the link. No status read-back is needed: unlike Jira's create,
  //    Linear's returns the state it landed in inline.
  //
  //    An UNKNOWN state type folds to no bucket, which is reported as
  //    `completed: false` — the conservative reading, and the same one the
  //    read-back takes. A brand-new Linear state type must never mark a
  //    just-created issue complete.
  const stateLabel = issueStateName(issue)
  const bucket = linearBucketForStateType(issueStateType(issue))
  const completed = bucket === 'done' || bucket === 'canceled'

  const { data: inserted, error: insertError } = await supabase
    .from('action_external_task')
    .insert({
      workspace_id: workspaceId,
      action_id: actionId,
      provider: LINEAR_PROVIDER,
      // The UUID, never the identifier: Linear REWRITES the identifier when an
      // issue moves to another team, while the id is permanent and globally
      // unique.
      external_id: issue.id,
      // NULL for linear, and deliberately so. The column exists because Jira
      // issue ids are a per-site sequence that identifies nothing on its own;
      // a Linear UUID needs no container — the Asana stance, not the Jira one.
      external_scope: null,
      external_url: issue.url ?? null,
      external_title: title,
      external_state_label: stateLabel,
      completed,
      created_by: userId,
      last_synced_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (insertError) {
    // 23505 = the UNIQUE (action_id, provider) index fired: a concurrent push
    // (or an Inngest/AI retry replaying a create that already landed) got there
    // first. The row that won is the truth — read it back (by action+provider,
    // NOT by our issue id: the winner almost certainly carries a different one).
    if ((insertError as { code?: string }).code === '23505') {
      const { data: raced } = await supabase
        .from('action_external_task')
        .select('*')
        .eq('action_id', actionId)
        .eq('provider', LINEAR_PROVIDER)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle()
      if (raced) {
        const winner = raced as LinearTaskLink
        // We lost, so the issue THIS call just created is an orphan. Best-effort
        // delete so the user isn't left with a duplicate (deleteIssue never
        // throws — and Linear's delete is a 30-day trash rather than a
        // destruction, so even this is recoverable by the user).
        if (winner.external_id !== issue.id) {
          await deleteIssue(token, issue.id)
        }
        console.warn(
          `[linear-push] lost the link race for action ${actionId} ` +
            `(kept linear issue ${winner.external_id})` +
            (winner.external_id !== issue.id
              ? `; deleted the orphaned issue ${issue.id}.`
              : '.'),
        )
        return { ok: true, link: winner, created: false }
      }
    }
    throw new Error(insertError.message)
  }

  return { ok: true, link: inserted as LinearTaskLink, created: true }
}
