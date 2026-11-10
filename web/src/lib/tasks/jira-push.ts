import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/admin'
import {
  assignIssue,
  createIssue,
  deleteIssue,
  getIssue,
  issueStatusCategoryKey,
  issueStatusName,
  searchUsers,
  JiraApiError,
  JiraUnauthorizedError,
  type AdfDoc,
  type CreateIssueInput,
} from '@/lib/integrations/jira-api'
import { getValidTokenForAccount } from '@/lib/oauth/token-manager'
import {
  JIRA_PROVIDER,
  includesJiraAttribution,
  isJiraDestinationConfigured,
  loadJiraSyncState,
} from './jira-config'
import type { JiraPushOverrides } from './push-overrides'
import { appUrl } from '@/lib/app-url'

/**
 * Push ONE Native Intelligence action to Jira as an issue, and record the link.
 *
 * The single implementation behind all three push surfaces — the "Push to…"
 * menu (`PushToTrackerMenu`, in the action detail panel's toolbar and on a
 * capture's extracted action items, both via POST
 * /api/account/actions/[id]/jira), the AI chat tool `push_action_to_jira`, and
 * its MCP twin `ni_push_action_to_jira`. They differ only in how they resolve
 * the action and shape the reply.
 *
 * Step-for-step sibling of asana-push.ts, including the idempotency model: a
 * check-then-act pre-check for an existing link, backed by the real guard —
 * UNIQUE (action_id, provider), deliberately WITHOUT external_id, so two
 * concurrent pushes minting two DIFFERENT issues collide instead of both
 * landing. The loser catches 23505, re-reads the winning row, best-effort
 * DELETEs the issue it just orphaned, and reports the winner with created:false.
 *
 * Three things are genuinely different from Asana and each is deliberate:
 *  - The body is ADF, not HTML (see buildAdfDescription).
 *  - `duedate` is screen-gated per project/issue type, so a 400 naming it earns
 *    one retry WITHOUT it — the same shape as Asana's assignee retry, applied to
 *    the field Jira actually rejects.
 *  - The assignee is set POST-CREATE and is fully best-effort. Jira needs an
 *    accountId (email is not accepted), resolving one over 3LO is unreliable by
 *    platform bug and privacy setting, and an unassigned issue beats a failed
 *    push — so it never touches the create call at all. An OVERRIDDEN assignee
 *    is the one exception to the best-effort part: the compose panel picked a
 *    real accountId from Jira's own assignable list, so there is nothing to
 *    resolve and nothing to guess (the assign call itself stays best-effort —
 *    an issue that exists unassigned still beats a failed push).
 *
 * `overrides` is the compose panel's per-push destination (see push-overrides.ts).
 * ABSENT MEANS TODAY'S BEHAVIOUR, byte for byte: every branch below reads the
 * override with `?? config`, so a push with no overrides builds the exact payload
 * it built before this parameter existed.
 */

export type JiraPushFailureCode =
  | 'action_not_found'
  | 'not_connected'
  | 'not_configured'
  | 'unauthorized'
  /**
   * Jira REJECTED the create over specific fields, and none of them is one we
   * may drop (see OPTIONAL_CREATE_FIELDS) — typically a required custom field
   * the project's create screen demands and Native Intelligence never sends. A destination
   * problem the user has to fix in Jira, so it is reported like every other
   * coded failure instead of thrown into the route's catch-all, where it became
   * an uncoded 500 carrying the raw gateway URL.
   */
  | 'push_failed'

export interface JiraTaskLink {
  id: string
  action_id: string
  provider: string
  /** The Jira issue ID (numeric string) — survives a key rename/project move. */
  external_id: string
  external_url: string | null
  external_title: string | null
  /** The real Jira status name ("In Progress") — Jira's whole point vs Asana. */
  external_state_label?: string | null
  completed: boolean
  created_at?: string
  last_synced_at?: string | null
}

export type JiraPushResult =
  | {
      ok: true
      link: JiraTaskLink
      created: boolean
      /**
       * Fields the strip-retry gave up to keep the issue, when it fired.
       *
       * The trade itself is deliberate (see OPTIONAL_CREATE_FIELDS) — losing a
       * due date beats losing the issue. What this adds is the ability to SAY
       * so: without it a user who typed a due date got a success chip and an
       * issue without one, and no caller could tell them. ABSENT when nothing
       * was dropped, so the ordinary push is byte-identical.
       */
      dropped_fields?: string[]
      /**
       * False when an OVERRIDDEN assignee could not be applied after the create.
       * Absent when no assignee was overridden or the assign succeeded. Same
       * reasoning: the push still succeeded, but the user's explicit pick did
       * not land and only a reported flag can tell them.
       */
      assignee_set?: boolean
    }
  | { ok: false; code: JiraPushFailureCode; error: string }

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
  overrides?: JiraPushOverrides
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
 * The user-facing Jira permalink for an issue.
 *
 * Built from the site url + the issue KEY (not the id): `/browse/ENG-42` is the
 * canonical human URL. Jira redirects an old key server-side after a move or
 * rename, so a stored link keeps resolving even when the key it displays has
 * gone stale — which is exactly why `external_id` stores the immutable id and
 * only this display URL uses the key.
 *
 * Returns null when either half is missing rather than emitting a broken URL.
 */
export function issueBrowseUrl(
  siteUrl: string | null | undefined,
  issueKey: string | null | undefined,
): string | null {
  if (!siteUrl || !issueKey) return null
  return `${siteUrl.replace(/\/$/, '')}/browse/${issueKey}`
}

/**
 * Build the issue description as an Atlassian Document Format doc.
 *
 * ADF is a JSON tree, not markup — there is no escaping to do because text
 * lives in `text` nodes that are never parsed as anything. That removes the
 * whole class of injection the Asana HTML builder has to defend against.
 *
 * Shape rules that are easy to get wrong and are load-bearing here:
 *  - `version` is the integer 1 and appears ONLY on the root `doc` node.
 *  - A link is a MARK on a text node, not a node type of its own.
 *  - A `paragraph` must not carry an empty `content` array, and a `text` node
 *    must not carry an empty string — both are rejected by ADF validators. So
 *    empty parts are dropped rather than emitted as blanks.
 *
 * Returns null when there is nothing to say, so the caller can OMIT
 * `description` entirely — Jira behaves inconsistently with an empty-but-valid
 * doc, and "no description" is better expressed by not sending one. That path
 * is reachable in exactly one way: attribution off AND no description.
 *
 * `attribution` gates Native Intelligence's two fingerprints — the bold identifier paragraph
 * and the "Pushed from Native Intelligence" provenance paragraph — as ONE unit, because they
 * are one idea: this issue came from somewhere, and here is the way back.
 * Defaulted to true so a caller that forgets to thread it gets today's
 * behaviour rather than silently stripping provenance.
 */
export function buildAdfDescription(args: {
  actionId: string
  identifier: string | null
  description: string | null
  attribution?: boolean
}): AdfDoc | null {
  const attribution = args.attribution !== false
  const content: AdfDoc['content'] = []

  const identifier = args.identifier?.trim()
  if (attribution && identifier) {
    content.push({
      type: 'paragraph',
      content: [{ type: 'text', text: identifier, marks: [{ type: 'strong' }] }],
    })
  }

  const description = args.description?.trim()
  if (description) {
    content.push({ type: 'paragraph', content: [{ type: 'text', text: description }] })
  }

  // The provenance line ships UNLESS the workspace opted out: it is the only way
  // back from the issue to the action, and a Jira issue with no trace of where
  // it came from is exactly the "notes that never become work" problem this
  // integration exists to solve — so it is on by default and off only on
  // purpose.
  if (attribution) {
    content.push({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Pushed from Native Intelligence: ' },
        {
          type: 'text',
          text: identifier || 'this action',
          marks: [{ type: 'link', attrs: { href: actionDeepLink(args.actionId) } }],
        },
      ],
    })
  }

  // An empty `content` array is not a valid doc, and Jira is inconsistent about
  // empty-but-valid ones anyway — so "nothing to say" is expressed by sending no
  // description at all (the caller already spreads it conditionally).
  if (content.length === 0) return null

  return { version: 1, type: 'doc', content }
}

/**
 * The single date-only `duedate` value Jira accepts, or undefined.
 *
 * Jira has ONE due field and it is date-only — no due_on/due_at split to choose
 * between. The date is sliced off the stored string when it already starts with
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
 * The create screen is per project AND per issue type, and admins routinely
 * hide fields from it; anything on this list is worth dropping to keep the
 * issue. Everything NOT on it — `project`, `issuetype`, `summary`, and any
 * required custom field we never sent — is a real configuration problem the
 * user has to see, so a 400 naming one of those still surfaces as an error.
 *
 * The compose panel's own fields are deliberately split across that line, and
 * the split is the point. `labels` and `duedate` stay droppable even when a user
 * typed them: they are refinements, and losing one to keep the issue is the
 * right trade. `priority` and every `customfield_*` are NOT on the list, so a
 * rejection naming one surfaces as `push_failed` rather than being papered over
 * — a required custom field the user answered in the panel and Jira then refused
 * is exactly the case where creating the issue anyway would be worse than
 * failing, because the issue would land missing the field its project requires.
 */
const OPTIONAL_CREATE_FIELDS = new Set(['duedate', 'description', 'labels'])

/**
 * Which of the fields we SENT can be dropped to make this rejected create work,
 * or null when the rejection isn't one we may paper over.
 *
 * Generalized from the original duedate-only recovery, which was one instance of
 * a shape Jira produces constantly: `errors: { <fieldKey>: "Field '<key>' cannot
 * be set. It is not on the appropriate screen, or unknown." }`. The field KEY is
 * the stable half of that (the sentence is localizable), so the rule is "every
 * key Jira named is a field we sent AND is optional to us" — ALL of them, never
 * a subset, because a 400 that also names `summary` is not a screen problem.
 */
function strippableCreateFields(err: unknown, sentFields: Set<string>): string[] | null {
  if (!(err instanceof JiraApiError)) return null
  if (err.status < 400 || err.status >= 500) return null

  const named = Object.keys(err.fieldErrors)
  if (named.length === 0) {
    // A 400 that flattened everything into `errorMessages` — the one case where
    // the message text is all there is. Kept for `duedate` only: it is the field
    // this was observed on, and pattern-matching prose for the others would be
    // guessing.
    return sentFields.has('duedate') && /duedate/i.test(err.message) ? ['duedate'] : null
  }

  const strippable = named.every((f) => OPTIONAL_CREATE_FIELDS.has(f) && sentFields.has(f))
  return strippable ? named : null
}

/**
 * The field keys a 4xx create rejection named, or null when it named none.
 *
 * The keys are the ONLY actionable half of Jira's error envelope: the sentences
 * are localizable prose, but `customfield_10014` is what the user searches for
 * in their project's field configuration. Reported instead of the raw
 * JiraApiError message, which carries the internal gateway URL and reads as an
 * outage rather than as "your create screen requires a field we don't send".
 */
function rejectedCreateFields(err: unknown): string[] | null {
  if (!(err instanceof JiraApiError)) return null
  if (err.status < 400 || err.status >= 500) return null
  const named = Object.keys(err.fieldErrors)
  return named.length > 0 ? named : null
}

/** The coded failure for a create Jira refused over named, undroppable fields. */
function pushFailedOver(fields: string[]): JiraPushResult {
  return {
    ok: false,
    code: 'push_failed',
    error:
      `Jira rejected the issue over ${fields.join(', ')}. ` +
      'Make those fields optional on the project’s create screen, or give them ' +
      'a default, then push again.',
  }
}

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
 * the service client. Returns null on any failure — an unassigned Jira issue is
 * a far better outcome than a failed push.
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
    console.warn('[jira-push] assignee email lookup failed (pushing unassigned):', err)
    return null
  }
}

/**
 * Try to assign the freshly-created issue. FULLY best-effort — every failure
 * path here is a warn + return, never a throw.
 *
 * Two independent reasons this is expected to no-op in the wild, both platform
 * facts rather than bugs on our side:
 *  - `GET /user/search` is reported to return empty over OAuth 3LO even for
 *    users that exist (it works under API-token auth), with no fix committed.
 *  - `emailAddress` is nullable per each Atlassian user's privacy setting, so a
 *    match may come back unidentifiable anyway.
 * An AMBIGUOUS result (more than one candidate) is treated as no match: guessing
 * which colleague a shared-prefix email belongs to and assigning their name to
 * someone else's work is worse than leaving the issue unassigned.
 */
async function tryAssignByEmail(
  accessToken: string,
  cloudId: string,
  issueIdOrKey: string,
  email: string,
): Promise<boolean> {
  try {
    const candidates = await searchUsers(accessToken, cloudId, email)
    const withAccountId = candidates.filter(
      (u) => typeof u?.accountId === 'string' && u.accountId.length > 0,
    )
    if (withAccountId.length !== 1) return false
    await assignIssue(accessToken, cloudId, issueIdOrKey, withAccountId[0].accountId!)
    return true
  } catch (err) {
    console.warn(
      `[jira-push] best-effort assignee for ${issueIdOrKey} failed (issue stays unassigned) —`,
      err instanceof Error ? err.message : String(err),
    )
    return false
  }
}

export async function pushActionToJira(args: PushArgs): Promise<JiraPushResult> {
  const { actionId, workspaceId, userId, supabase, overrides } = args

  // 1. Load the action. (Its workflow-state category is read for parity with the
  //    Asana push and for the echo that follows; the create itself always lands
  //    in the project's initial status — Jira has no "create it in status X".)
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
  //    Jira issue for the same action.
  const { data: existing } = await supabase
    .from('action_external_task')
    .select('*')
    .eq('action_id', actionId)
    .eq('provider', JIRA_PROVIDER)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (existing) {
    return { ok: true, link: existing as JiraTaskLink, created: false }
  }

  // 3. Destination. No connected account → 'not_connected'; connected but the
  //    site/project/issue-type triple isn't complete → 'not_configured' (the UI
  //    hints differ: connect vs. pick).
  const syncState = await loadJiraSyncState(workspaceId)
  if (!syncState) {
    return {
      ok: false,
      code: 'not_connected',
      error: 'Jira is not connected for this workspace',
    }
  }
  const config = syncState.config
  // The destination triple, override-first. An override supplies the project and
  // issue type TOGETHER or not at all (push-overrides rejects a lone project), so
  // there is no half-overridden pair to reason about here.
  //
  // The SITE is never overridable: `external_scope` on the link row is the
  // config's cloudId, every option route addresses one site, and a cross-site
  // compose would need a different token story. So a workspace with no site
  // picked is still `not_configured` no matter what the panel sent.
  const projectId = overrides?.project_id ?? config.project_id
  const issueTypeId = overrides?.issue_type_id ?? config.issue_type_id
  // With NO override this is exactly isJiraDestinationConfigured(config); with
  // one it is the same predicate over the merged triple, so an override can
  // complete a destination the config left half-picked (a site chosen but no
  // project yet) without ever loosening the site requirement.
  const configured = overrides
    ? !!config.cloud_id && !!projectId && !!issueTypeId
    : isJiraDestinationConfigured(config)
  if (!configured) {
    // The message still points at settings even when an override was supplied:
    // the only way to reach it WITH an override is a missing site, which is a
    // settings problem and nothing the compose panel can fix.
    return {
      ok: false,
      code: 'not_configured',
      error: 'Pick a Jira project and issue type in Settings → Connectors → Jira first',
    }
  }
  const cloudId = config.cloud_id!

  // 4. Token. A dead/absent token reads the same as a revoked app to the user,
  //    and both are fixed by reconnecting.
  const resolvedToken = await getValidTokenForAccount(syncState.accountId)
  if (!resolvedToken) {
    return { ok: false, code: 'unauthorized', error: 'Reconnect Jira to continue' }
  }
  const token = resolvedToken.token

  // 5. Build the create payload. NO assignee — see tryAssignByEmail.
  const summary = overrides?.title ?? (action.title?.trim() || action.identifier || 'Untitled action')
  // The attribution flag comes from the config loaded above and is passed in
  // explicitly, never re-read inside the builder — one load per push, and the
  // builder stays a pure function of its arguments.
  const description = buildAdfDescription({
    actionId: action.id,
    identifier: action.identifier,
    description: action.description,
    attribution: includesJiraAttribution(config),
  })
  // Key presence, not `??`: `due_date: null` is the user clearing the date input,
  // which must mean "no due date" rather than falling back to the action's own.
  // Absent still inherits — the untouched-panel path.
  const duedate =
    overrides && 'due_date' in overrides
      ? (overrides.due_date ?? undefined)
      : dueDateFor(action.due_at)

  const payload: CreateIssueInput = {
    fields: {
      project: { id: projectId! },
      issuetype: { id: issueTypeId! },
      summary,
      ...(description ? { description } : {}),
      ...(duedate ? { duedate } : {}),
      // The three compose-only fields, each sent ONLY when the caller supplied
      // it. The compose PANEL only offers a field compose-meta said is on this
      // project+type's create screen, so panel-driven pushes do not produce the
      // "field cannot be set, it is not on the appropriate screen" 400. The
      // AI/MCP tool consults no such gate, so a model-supplied label or due date
      // on a screen without it still can — which is exactly the case the retry
      // below absorbs.
      ...(overrides?.priority_id ? { priority: { id: overrides.priority_id } } : {}),
      // `?.length`, not truthiness: the parser PRESERVES an empty array (so a
      // future "clear the labels" gesture stays expressible) and `[]` is truthy,
      // so a bare truthiness test would send `labels: []` where absent sends
      // nothing. Jira refuses a field that is off the create screen regardless
      // of its value, so the empty case bought a 400 and a wasted retry.
      ...(overrides?.labels?.length ? { labels: overrides.labels } : {}),
      // Required custom fields the panel rendered from their `allowedValues`,
      // spread at the TOP level of `fields` keyed by fieldId — Jira's own shape,
      // `{ customfield_10041: { id: 'opt-9' } }`.
      ...(overrides?.custom_fields ?? {}),
    },
  }

  // 6. Create. A well-formed request can still be rejected over the fields that
  //    have to be on the issue type's CREATE screen — `duedate` most often, but
  //    `description` on a locked-down screen just as legitimately. A 400 naming
  //    ONLY fields we can live without earns exactly one retry without them:
  //    losing a due date is a far smaller loss than losing the issue. A 400
  //    naming anything else (a required custom field, an issue type that isn't
  //    valid for the project) is a destination the user has to fix, and is
  //    surfaced rather than papered over.
  let issue
  // What the retry gave up, reported on the ok arm so the loss is not silent.
  let droppedFields: string[] | null = null
  try {
    issue = await createIssue(token, cloudId, payload)
  } catch (err) {
    if (err instanceof JiraUnauthorizedError) {
      return { ok: false, code: 'unauthorized', error: 'Reconnect Jira to continue' }
    }
    const strippable = strippableCreateFields(err, new Set(Object.keys(payload.fields)))
    if (!strippable) {
      // Not droppable, but Jira DID name the fields — so this is a destination
      // the user has to fix, reported with the keys they need rather than
      // rethrown into a 500 whose body is a gateway URL.
      const rejected = rejectedCreateFields(err)
      if (rejected) return pushFailedOver(rejected)
      throw err
    }

    console.warn(
      `[jira-push] create rejected over [${strippable.join(', ')}] for action ${actionId}; ` +
        'retrying without those fields.',
    )
    const retryFields = { ...payload.fields }
    for (const field of strippable) delete retryFields[field]
    try {
      issue = await createIssue(token, cloudId, {
        fields: retryFields as CreateIssueInput['fields'],
      })
      droppedFields = strippable
    } catch (retryErr) {
      if (retryErr instanceof JiraUnauthorizedError) {
        return { ok: false, code: 'unauthorized', error: 'Reconnect Jira to continue' }
      }
      // Same rule on the second attempt: named fields we cannot drop are a
      // destination the user has to fix, not an outage to retry.
      const rejected = rejectedCreateFields(retryErr)
      if (rejected) return pushFailedOver(rejected)
      throw retryErr
    }
  }

  // 7. Best-effort assignee, AFTER the issue exists so it can never cost us one.
  //
  // An OVERRIDDEN assignee skips the email bridge entirely: the compose panel
  // picked an accountId out of Jira's own assignable-users list, so there is
  // nobody to search for and nothing to disambiguate. The assign CALL is still
  // best-effort for the same reason the search path's is — an issue that exists
  // unassigned beats a push that failed after creating it.
  let assigneeSet: boolean | null = null
  // An explicit null suppresses the email bridge below: the panel showed
  // "Unassigned" and the user meant it.
  const assigneeCleared =
    !!overrides && 'assignee_account_id' in overrides && overrides.assignee_account_id === null
  if (overrides?.assignee_account_id) {
    try {
      await assignIssue(token, cloudId, issue.id, overrides.assignee_account_id)
    } catch (err) {
      // Reported as well as logged: an assignee the user picked in the panel
      // that never landed is a silent loss otherwise, and the console is not a
      // place the user can see.
      assigneeSet = false
      console.warn(
        `[jira-push] assigning ${overrides.assignee_account_id} to ${issue.id} failed ` +
          '(issue stays unassigned) —',
        err instanceof Error ? err.message : String(err),
      )
    }
  } else if (!assigneeCleared && action.assignee_id) {
    const email = await resolveAssigneeEmail(supabase, action.assignee_id, workspaceId)
    if (email) await tryAssignByEmail(token, cloudId, issue.id, email)
  }

  // 8. Read the landing status back. The create response carries only
  //    { id, key, self } — no status — and which status a new issue starts in is
  //    a property of the project's workflow, so it can only be learned by asking.
  //    Best-effort: the issue already exists and is about to be linked, so a
  //    failed read costs a label, not the push.
  let stateLabel: string | null = null
  let completed = false
  try {
    const fresh = await getIssue(token, cloudId, issue.id, 'status')
    stateLabel = issueStatusName(fresh)
    completed = issueStatusCategoryKey(fresh) === 'done'
  } catch (err) {
    console.warn(
      `[jira-push] could not read back status for issue ${issue.id} —`,
      err instanceof Error ? err.message : String(err),
    )
  }

  // 9. Record the link.
  //    `external_url` is null when the site reported no browsable url —
  //    issueBrowseUrl's own contract. A synthesized one would be WORSE than
  //    none: it is copied onto every row and outlives the config it came from,
  //    so a wrong permalink is permanent while a missing one is just absent.
  const externalUrl = issueBrowseUrl(config.site_url, issue.key)
  const { data: inserted, error: insertError } = await supabase
    .from('action_external_task')
    .insert({
      workspace_id: workspaceId,
      action_id: actionId,
      provider: JIRA_PROVIDER,
      external_id: issue.id,
      // The SITE the issue lives on. Jira issue ids are per-site sequences that
      // all start at 10000, so the id alone does not identify an issue — without
      // this a workspace that re-points its destination would have every
      // existing link silently resolve to an unrelated issue on the new tenant.
      external_scope: cloudId,
      external_url: externalUrl,
      external_title: summary,
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
        .eq('provider', JIRA_PROVIDER)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle()
      if (raced) {
        const winner = raced as JiraTaskLink
        // We lost, so the issue THIS call just created is an orphan. Best-effort
        // delete so the user isn't left with a duplicate (deleteIssue never
        // throws — and note that "Delete Issues" is a separate project
        // permission from create, so a 403 here is entirely expected and leaves
        // the stray issue behind rather than failing a push that succeeded).
        if (winner.external_id !== issue.id) {
          await deleteIssue(token, cloudId, issue.id)
        }
        console.warn(
          `[jira-push] lost the link race for action ${actionId} ` +
            `(kept jira issue ${winner.external_id})` +
            (winner.external_id !== issue.id
              ? `; deleted the orphaned issue ${issue.id}.`
              : '.'),
        )
        return { ok: true, link: winner, created: false }
      }
    }
    throw new Error(insertError.message)
  }

  // Both degradation flags are spread only when they actually happened, so the
  // ordinary push returns exactly the object it always did.
  return {
    ok: true,
    link: inserted as JiraTaskLink,
    created: true,
    ...(droppedFields ? { dropped_fields: droppedFields } : {}),
    ...(assigneeSet === false ? { assignee_set: false } : {}),
  }
}
