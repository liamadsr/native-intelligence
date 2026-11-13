import type { SupabaseClient } from '@supabase/supabase-js'
import {
  startOfDay,
  endOfDay,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  startOfQuarter,
  endOfQuarter,
  startOfYear,
  endOfYear,
  subDays,
  subWeeks,
  subMonths,
  subYears,
  addDays,
  addWeeks,
  addMonths,
  addYears,
  format,
  parseISO,
} from 'date-fns'
import { resolveMemberIdsForUser } from '@/lib/workspace'
import { toIlikeSearchTerm } from '@/lib/crm/ilike-search-term'
import { inChunks } from '@/lib/supabase/paging'
import type {
  ViewEntityType,
  ViewFilter,
  FilterOperator,
  RelativeDateValue,
  RangeValue,
  SortConfig,
  GroupConfig,
  GroupedResults,
  View,
  WorkspaceScope,
} from './types'
import { DEFAULT_DISPLAY_PROPERTIES, DEFAULT_BOARD_GROUP_BY, FILTERABLE_FIELDS, NO_MATCH_FILTER_VALUE, defaultOrdering, isUnsetFilterValue } from './types'
import { customFieldKeyOf, isCustomFieldPath, orderCustomSelectGroups, viewTakesCustomFields } from './custom-field-columns'
import { DEFAULT_CURRENCY, type CustomFieldType } from '@/lib/crm/custom-field-types'

// Re-export so callers already importing from the query engine (and the route)
// get the sentinel from one place. The value itself lives in ./types so client
// components can import it without pulling in this server-side module.
import { applyVisibilityFence, companyNeedsFenceEmbed, COMPANY_FENCE_SELECT, type VisibilityFence } from './visibility-fence'
import { flowRowForViewer } from '@/lib/flows/types'
export { NO_MATCH_FILTER_VALUE } from './types'

/**
 * Thrown by the filter-application layer when a filter provably matches NOTHING
 * (a contact with zero captures, a label/status-category resolving to zero
 * rows, or a client-sent NO_MATCH_FILTER_VALUE). Callers catch this ABOVE the
 * query builder and return the normal empty success shape WITHOUT touching the
 * DB — this is what keeps the sentinel string from reaching Postgres and
 * raising a 22P02 uuid-cast error. Not a real error: it never surfaces to the
 * client as a 500.
 */
export class NoMatchSignal extends Error {
  constructor() {
    super('Filter resolves to no matches — query short-circuited')
    this.name = 'NoMatchSignal'
  }
}

// ============================================================
// Entity Query Builders
// ============================================================

/**
 * `external_links` is the row's far-left platform mark (ActionPlatformIcon):
 * which task trackers this action already lives in.
 *
 * An EMBEDDED JOIN, exactly like `labels` two lines down, and for the same
 * reason — the alternative is one GET per visible row per provider, which on a
 * 500-row board is 1,500 requests to draw an icon. `provider` alone is selected
 * because that is all the icon reads; the urls and titles live behind the menu,
 * which fetches them when it opens.
 *
 * The join is safe under RLS without any widening: `action_external_task`'s
 * SELECT policy is `is_workspace_member(workspace_id)` (migration 212), which
 * every reader of this query already satisfies.
 *
 * `workspace` is embedded UNCONDITIONALLY, not just in personal scope (every
 * workspace the user belongs to — see WorkspaceScope). It is a many-to-one
 * embed on a column the row already carries, so it costs one join and no extra
 * rows, and having it on every row means the client never has to know which
 * scope produced the list: it draws the workspace badge when a row's workspace
 * differs from the active one and hides it otherwise. Readable across every
 * workspace in scope — `workspace`'s SELECT policy is `is_workspace_member(id)`
 * (migration 013), the same membership the actions themselves are gated on.
 */
const ACTION_VIEW_SELECT = `
  id, identifier, title, description, status_id, team_id, confirmation, priority,
  due_at, all_day, assignee_id, parent_id, estimate, project_id, milestone_id,
  cycle_id, source_capture_id, custom_fields, created_at, updated_at, user_id, workspace_id,
  workflow_state:workflow_state!status_id(id, name, category, color, sort_order),
  labels:action_label(label:label(id, name, color)),
  external_links:action_external_task(provider),
  assignee:member!assignee_id(id, display_name, avatar_url),
  assignees:action_assignee(member:member(id, display_name, avatar_url)),
  project:projects!project_id(id, name),
  milestone:milestone!milestone_id(id, name),
  cycle:cycle!cycle_id(id, name, number),
  team:team!team_id(id, name),
  workspace:workspace!workspace_id(id, name, slug, logo_url)
`

/**
 * `summary` and `participants` are deliberately ABSENT: the list renders
 * neither, yet a grouped captures view fetches up to 500 rows — carrying a
 * multi-KB AI summary plus a participants JSON blob per row put 100KB–1MB of
 * data nobody draws on every list load. The detail panel fetches the full
 * record itself; row-derived consumers (e.g. the history-entry label built in
 * tab-content's buildEntryForItem) degrade to omitting the snippet/names.
 */
const CAPTURE_VIEW_SELECT = `
  id, title, recorded_at, created_at, status, is_pinned,
  duration_seconds, started_at, ended_at, ai_processed, auto_capture_status,
  scheduled_start, scheduled_end, user_id, team_id, project_id, workspace_id, visibility,
  labels:capture_label(label:label(id, name, color))
`

const CONTACT_VIEW_SELECT = `
  id, full_name, email, phone, job_title, department, linkedin_url,
  relationship_type, relationship_strength, member_id,
  company_id, tags, source, last_interaction_at, interaction_count, next_followup_at,
  notes, custom_fields, created_at, updated_at, workspace_id,
  company:company!company_id(id, name, domain, logo_url)
`

const COMPANY_VIEW_SELECT = `
  id, name, domain, industry, employee_count_range, logo_url, tags,
  custom_fields, created_at, updated_at, workspace_id
`


const EMAIL_THREAD_VIEW_SELECT = `
  id, provider_thread_id, provider_message_id, account_id, provider, from_email, folder, is_unread, is_starred, needs_reply,
  has_attachments, auto_classified, message_count, last_message_at,
  linked_contact_id, linked_capture_id, linked_project_id,
  created_at, updated_at, user_id, workspace_id,
  linked_contact:contact!linked_contact_id(id, full_name, company:company!company_id(name)),
  labels:email_thread_label(label:label(id, name, color))
`

const DOCUMENT_VIEW_SELECT = `
  id, title, content, created_by, project_id, team_id, is_pinned, status, kind, visibility,
  custom_fields, created_at, updated_at, workspace_id,
  project:projects!project_id(id, name),
  creator:member!created_by(id, display_name, avatar_url),
  team:team!team_id(id, name)
`

const INITIATIVE_VIEW_SELECT = `
  id, name, description, status, icon, color, owner_id, target_date,
  custom_fields, created_at, updated_at, workspace_id,
  owner:member!owner_id(id, display_name, avatar_url),
  labels:initiative_label(label:label(id, name, color))
`

/**
 * `workspace` is embedded unconditionally for the same reason as on
 * ACTION_VIEW_SELECT: in personal scope (the "Show all workspaces" switch) the
 * Projects list mixes workspaces, and the row's own embed is what draws its
 * badge and routes requests about it (components/views/row-workspace.ts).
 * `workspace`'s SELECT policy is `is_workspace_member(id)`, the same
 * membership `projects_select` gates on (migration 028).
 */
const PROJECT_VIEW_SELECT = `
  id, name, description, icon, color, is_pinned, is_archived, status,
  initiative_id, start_date, target_date, custom_fields, created_at, updated_at, workspace_id,
  lead:member!lead_id(id, display_name, avatar_url),
  initiative:initiative!initiative_id(id, name, color, icon),
  labels:project_label(label:label(id, name, color)),
  workspace:workspace!workspace_id(id, name, slug, logo_url)
`

const FLOW_VIEW_SELECT = `
  id, workspace_id, team_id, name, description, enabled,
  trigger_type, trigger_config, actions,
  created_by, created_at, updated_at, ai_team_member_id,
  team:team!team_id(id, name),
  bot:ai_team_member_id(id, name, bot_character),
  flow_run:flow_run(status, response_status_code, error_message, fired_at, duration_ms)
`

/**
 * Scalar columns only — no embeds. The list's headline numbers (enrolled /
 * active / replied, reply rate) are aggregates over sequence_enrollment, and
 * PostgREST embeds can't express "count by status per parent" without pulling
 * every enrollment row onto every page load. They are merged into rows by the
 * views/query route instead (one grouped count query per page), exactly the
 * way company contact_count is — see the enrichment block there and the same
 * computation in GET /api/account/sequences.
 */
const SEQUENCE_VIEW_SELECT = `
  id, workspace_id, name, description, status, created_by, sending_account_id,
  timezone, send_window, delay_unit, auto_send, created_at, updated_at
`

/**
 * Eval suites. Scalar columns only, and no post-fetch merge either: the three
 * summary facts the index shows (`case_count`, `last_run_at` / `last_run_mode`,
 * `last_outcome`) are REAL columns kept current by migration 255's triggers on
 * eval_case and eval_run. That is what lets a saved view group suites by
 * outcome — a value merged in after the query could be displayed but never
 * grouped, filtered or sorted on.
 *
 * The fat authoring columns live on eval_case (`script`, `chunks`, `expected`),
 * not here, so there is nothing to omit — the whole row is list-sized.
 */
const EVAL_SUITE_VIEW_SELECT = `
  id, workspace_id, name, description, target_kind, target_recipe_id,
  suite_kind, watch, judge_model, created_by, created_at, updated_at,
  case_count, last_run_at, last_run_mode, last_outcome
`

/**
 * Prospect LISTS — the index's own rows.
 *
 * Embeds the single newest `prospecting_run` (ordered + limited via
 * referencedTable options, exactly the way the flow select embeds flow_run) so
 * the Last-run and Spent cells, and the live "Finding…" dot, come out of the
 * same page load rather than one probe per card the way the old card grid did.
 *
 * `progress` is selected because the run line's headline number — "N new" — is
 * `progress.new`, which the run engine defines as "keys THIS run admitted as
 * new entries". Counting `prospect_list_entry` by discovered_by_run_id would
 * be a second query per row to learn something the run already recorded.
 *
 * `icp_snapshot`, `counts` and `exclusion_snapshot` stay OUT: they are the run
 * detail page's material, they are the three largest blobs on the row, and no
 * cell on the index reads them.
 *
 * The per-stage entry tallies are NOT here and cannot be: "count entries by
 * stage per list" is an aggregate over a child table that no PostgREST embed
 * expresses without pulling every entry row onto the page. They are merged in
 * by the views/query route as `entry_counts`, one grouped read per page — the
 * same idiom as company contact_count and sequence enrollment_counts.
 */
export const PROSPECT_LIST_VIEW_SELECT = `
  id, workspace_id, name, description, purpose, icp_version, source_company_id,
  exclude_crm, exclude_other_lists, exclude_contacted,
  max_spend_dollars, target_new_candidates, max_rounds, people_per_company,
  status, created_by, published_at, published_by, created_at, updated_at,
  prospecting_run:prospecting_run(id, kind, status, spent_dollars, progress, started_at, finished_at, created_at)
`

/**
 * Prospect-list entries. Deliberately narrow: the row needs the fit verdict,
 * the stage/kind chips, the promotion pointers, and `candidate` (the jsonb the
 * title, domain and one-liner render from).
 *
 * `research` IS selected, and that is a considered exception rather than an
 * oversight. The list-detail page renders its rows through this select (it
 * embeds `<UnifiedViewLayout entityType="prospect_list_entry">`), and
 * `ProspectEntryRowBody` reads it: the employee-count chip and the citation
 * favicon both come out of the research blob. Because every accessor there
 * degrades to null on a missing key, omitting it did not error — the
 * affordances simply rendered nothing, silently, which is the worst way for a
 * column list to be wrong.
 *
 * `sources` stays out. It is the entry DETAIL panel's citation list, it is the
 * largest of the blobs, and no row cell reads it.
 */
const PROSPECT_ENTRY_VIEW_SELECT = `
  id, workspace_id, list_id, kind, candidate_key, candidate,
  company_id, contact_id, parent_entry_id,
  stage, identity_state, fit_score, fit_rationale,
  research,
  dismissed_reason, dismissed_at, discovered_by_run_id, published_at, created_at, updated_at
`

/**
 * Eval cases, for the suite detail page's Cases tab.
 *
 * `script`, `chunks` and `expected` are DELIBERATELY OMITTED, and this is the
 * one omission on this entity that matters. A case's script is the full
 * synthetic meeting transcript and its frozen flush windows — tens to hundreds
 * of kilobytes each — so a twenty-case suite would ship megabytes of jsonb per
 * page to render a list of names. The single-case GET
 * (/api/account/evals/cases/[id]) returns the full row, which is where the
 * editor gets them; nothing on a ROW reads any of the three.
 *
 * `sort_order` IS selected: it is the list's default sort field (see
 * defaultConfig in use-view), so leaving it out would order on a column the
 * response does not carry.
 */
const EVAL_CASE_VIEW_SELECT = `
  id, workspace_id, suite_id, name, polarity, modes, visibility,
  last_outcome, last_run_at, sort_order, created_by, created_at, updated_at
`

/**
 * Eval runs, for the suite detail page's Runs tab.
 *
 * Wider than it first looks, and every field earns its place on a ROW:
 * `scores` is the per-dimension tally line, `progress` and `is_live` are what
 * a queued/running row renders instead of a verdict, `baseline_run_id` is what
 * makes a row comparable to the one before it, and the three `target_*`
 * columns are what a run REMEMBERS about the prompt it graded.
 *
 * What stays out: `target_system_prompt` and `target_agent_config` (the whole
 * frozen prompt, the single largest thing on the row and read only by the run
 * detail's compare view), `error_message` (the row shows `error_code`; the
 * sentence belongs on the detail), and `max_cost_usd`.
 */
const EVAL_RUN_VIEW_SELECT = `
  id, workspace_id, suite_id, mode, speed, driver, status, is_live, outcome,
  scores, progress, cost_usd, estimated_cost_usd, duration_ms,
  tokens_in, tokens_out, trials_per_case, target_prompt_hash, target_model,
  baseline_run_id, started_at, ended_at, error_code
`

/**
 * Claims, for the Knowledge list/board.
 *
 * `text` is the row — a claim has no name — so it ships in full rather than
 * truncated: the row clamps it visually, and the same string is what a text
 * filter matched on the server. There is deliberately NO embed here. A claim's
 * project is an `entity_link` row (source_type='claim', target_type='project'),
 * and PostgREST cannot embed a polymorphic link table that has no foreign key
 * — so the project a row displays is attached by the query route after the
 * fact, the same way it filters by one (see applyClaimProjectFilter).
 *
 * `superseded_by` is not selected: the universe is `status='active'`, so it is
 * null on every row this query can return.
 */
const CLAIM_VIEW_SELECT = `
  id, workspace_id, text, type, confidence, confirmation, status,
  scope, auto_accepted, created_by, created_at, updated_at,
  last_verified_at, event_at
`

/**
 * The resolved membership set behind `workspaceScope: 'all'`.
 *
 * Produced ONLY by `resolvePersonalScope` below, which reads it from the
 * `member` table on the caller's own session client. Nothing here may come
 * from a request body — a hand-built PersonalScope is a request to read
 * arbitrary workspaces, which is precisely what resolving it server-side
 * prevents. `memberIds[i]` is the user's member id in `workspaceIds[i]`.
 */
export interface PersonalScope {
  memberIds: string[]
  workspaceIds: string[]
}

/**
 * Resolve personal scope: every workspace the caller belongs to, and their
 * member id in each.
 *
 * A thin shaping of `resolveMemberIdsForUser` (the fence — see its doc) into
 * the two parallel id lists the query builder filters on. Callers await this
 * once per request and hand the result to `buildEntityQuery`, which stays
 * synchronous: every helper in this module is typed off
 * `ReturnType<typeof buildEntityQuery>`, so making the builder async would
 * turn all of them into Promise-typed no-ops.
 */
export async function resolvePersonalScope(
  supabase: SupabaseClient,
  userId: string,
): Promise<PersonalScope> {
  const memberships = await resolveMemberIdsForUser(supabase, userId)
  return {
    memberIds: memberships.map((m) => m.memberId),
    workspaceIds: memberships.map((m) => m.workspaceId),
  }
}

/** A table's row as every reader of it takes it (src/lib/tables/store.ts reads the same). */
export const DATA_ROW_VIEW_SELECT = 'id, table_id, title, custom_fields, position, archived_at, created_at, updated_at'

export interface QueryOptions {
  memberId?: string
  /** 'assigned' = actions assigned to me, 'created' = actions I created, 'all' = no scope filter */
  actionScope?: 'assigned' | 'created' | 'all'
  /**
   * 'workspace' (default) = the active workspace; 'all' = personal scope, every
   * workspace the user belongs to. Honoured for `action` and `project` — the
   * option is on the shared shape so the other entities can opt in without a
   * signature change, and they ignore it until they do.
   */
  workspaceScope?: WorkspaceScope
  /**
   * The membership set `workspaceScope: 'all'` resolves to. REQUIRED for that
   * scope: without it (or with an empty one) the builder falls back to the
   * single active workspace, so a caller that forgets to resolve it gets a
   * narrower query rather than a wider one.
   */
  personalScope?: PersonalScope
  /**
   * What the person may see, for a caller on a SERVICE-ROLE client (RLS does
   * not apply there): actions of visible teams, visible contacts, companies
   * with a visible contact. See ./visibility-fence.ts. Absent on the session
   * client, where RLS already does this.
   */
  visibility?: VisibilityFence
}

export function buildEntityQuery(
  supabase: SupabaseClient,
  entityType: ViewEntityType,
  workspaceId: string,
  userId: string,
  options?: QueryOptions,
) {
  const query = buildUnfencedEntityQuery(supabase, entityType, workspaceId, userId, options)
  if (options?.visibility) applyVisibilityFence(query as never, entityType, options.visibility)
  return query
}

function buildUnfencedEntityQuery(
  supabase: SupabaseClient,
  entityType: ViewEntityType,
  workspaceId: string,
  userId: string,
  options?: QueryOptions,
) {
  switch (entityType) {
    // The library composes the shared saved-view controls with its existing
    // account/marketplace sources, which carry provenance and fork dedupe.
    case 'agent':
    case 'skill':
      throw new Error('Library views use the agents and skills endpoints')
    case 'action': {
      // Personal scope (all of the user's workspaces) or the active one. The
      // ids come from the `member` table, never from the caller — see
      // PersonalScope. An absent or empty set falls back to the single
      // workspace, so the failure mode is "too narrow", never "too wide".
      //
      // `actions` RLS is `EXISTS (team t WHERE t.id = team_id AND
      // is_workspace_member(t.workspace_id))` (migration 028) — it has no
      // notion of an ACTIVE workspace, so widening this predicate is what
      // makes the other workspaces' rows visible, and private teams (017)
      // still filter through `team`'s own policy inside that EXISTS.
      const personal =
        options?.workspaceScope === 'all' && (options.personalScope?.workspaceIds.length ?? 0) > 0
          ? options.personalScope!
          : null

      const q = supabase
        .from('actions')
        .select(ACTION_VIEW_SELECT, { count: 'exact' })
      if (personal) q.in('workspace_id', personal.workspaceIds)
      else q.eq('workspace_id', workspaceId)
      q.is('parent_id', null) // top-level actions only by default

      // Scope: assigned to me, created by me, or all (no scope = show everything)
      const scope = options?.actionScope
      if (scope === 'created') {
        // `user_id` is the creator's AUTH user id, one value across every
        // workspace, so personal scope needs no widening here.
        q.eq('user_id', userId)
      } else if (scope === 'assigned') {
        // "Me" is a DIFFERENT member row per workspace, so personal scope
        // matches the whole set. This is the same predicate as the
        // single-workspace path, widened — `assignee_id` only, NOT the
        // `action_assignee` join table, because the single-workspace path
        // doesn't consult it either and the two scopes showing different
        // answers to "assigned to me" is worse than both sharing one gap.
        // (Consulting it would also mean an `id.in.(…)` list unbounded by
        // workspace — see the same idiom, and its cost, in GET
        // /api/account/actions.)
        if (personal) q.in('assignee_id', personal.memberIds)
        else if (options?.memberId) q.eq('assignee_id', options.memberId)
      }
      return q
    }

    case 'capture':
      return supabase
        .from('captures')
        .select(CAPTURE_VIEW_SELECT, { count: 'exact' })
        .eq('workspace_id', workspaceId)
        // EVAL captures (`is_eval`, migration 252) are synthetic mock meetings
        // owned by the Evals surface. This builder feeds every capture list,
        // board and grouped COUNT in the app, so without the predicate a mock
        // call would appear in each of them — and inflate the counts even where
        // it isn't rendered. See docs/plans/evals.md §5.2.
        .neq('is_eval', true)
        // 'private' captures ("Only me") are creator-only everywhere — lists,
        // boards, grouping counts. Defence-in-depth alongside the RLS policy.
        .or(`visibility.eq.workspace,user_id.eq.${userId}`)

    case 'contact':
      return supabase
        .from('contact')
        .select(CONTACT_VIEW_SELECT, { count: 'exact' })
        .eq('workspace_id', workspaceId)
        // Hide contacts merged away into another contact.
        .is('merged_into_contact_id', null)

    case 'company':
      return supabase
        .from('company')
        // A fenced query carries the contacts it is fenced on (inner), so a
        // company with no contact the person can see is not counted.
        .select(companyNeedsFenceEmbed(options?.visibility) ? `${COMPANY_VIEW_SELECT}, ${COMPANY_FENCE_SELECT}` : COMPANY_VIEW_SELECT, { count: 'exact' })
        .eq('workspace_id', workspaceId)


    case 'email_thread':
      return supabase
        .from('email_thread_index')
        .select(EMAIL_THREAD_VIEW_SELECT, { count: 'exact' })
        .eq('workspace_id', workspaceId)
        .eq('user_id', userId)

    case 'document':
      return supabase
        .from('document')
        .select(DOCUMENT_VIEW_SELECT, { count: 'exact' })
        .eq('workspace_id', workspaceId)

    case 'initiative':
      return supabase
        .from('initiative')
        .select(INITIATIVE_VIEW_SELECT, { count: 'exact' })
        .eq('workspace_id', workspaceId)

    case 'project': {
      // Personal scope or the active workspace, exactly as for actions above:
      // the set comes from the `member` table, and an absent or empty one
      // falls back to the single workspace. `projects_select` is
      // `is_workspace_member(workspace_id)` (migration 028), so the widened
      // predicate returns only workspaces the caller belongs to.
      const personal =
        options?.workspaceScope === 'all' && (options.personalScope?.workspaceIds.length ?? 0) > 0
          ? options.personalScope!
          : null
      const q = supabase
        .from('projects')
        .select(PROJECT_VIEW_SELECT, { count: 'exact' })
      if (personal) q.in('workspace_id', personal.workspaceIds)
      else q.eq('workspace_id', workspaceId)
      return q.neq('name', '__default__')
    }

    case 'flow': {
      // Embed the team (for the Team column / grouping) and the single most
      // recent run (for the Last-run column). The embedded `flow_run` is
      // ordered + limited via referencedTable options so we get just the
      // latest row instead of the whole history.
      const q = supabase
        .from('flow')
        .select(FLOW_VIEW_SELECT, { count: 'exact' })
        .eq('workspace_id', workspaceId)
        .order('fired_at', { referencedTable: 'flow_run', ascending: false })
        .limit(1, { referencedTable: 'flow_run' })
      return q
    }

    case 'sequence':
      return supabase
        .from('sequence')
        .select(SEQUENCE_VIEW_SELECT, { count: 'exact' })
        .eq('workspace_id', workspaceId)

    case 'eval_suite':
      return supabase
        .from('eval_suite')
        .select(EVAL_SUITE_VIEW_SELECT, { count: 'exact' })
        .eq('workspace_id', workspaceId)

    case 'prospect_list': {
      // Same shape as the flow case: embed the single newest run so the
      // Last-run / Spent cells and the live dot need no per-row probe.
      const q = supabase
        .from('prospect_list')
        .select(PROSPECT_LIST_VIEW_SELECT, { count: 'exact' })
        .eq('workspace_id', workspaceId)
        .order('created_at', { referencedTable: 'prospecting_run', ascending: false })
        .limit(1, { referencedTable: 'prospecting_run' })
      // NOTE: archived lists are hidden by default, but NOT here — the
      // default depends on whether the caller sent a `status` filter, which
      // this function cannot see. `applyEntityDefaults` (below) owns it and
      // every caller of buildEntityQuery must call it.
      return q
    }

    case 'prospect_list_entry':
      // Workspace-scoped like every other entity. The LIST scope is a plain
      // `list_id` filter the detail page sends as a fixed scopeFilter — no
      // synthetic field and no subquery, because list_id is a real column.
      return supabase
        .from('prospect_list_entry')
        .select(PROSPECT_ENTRY_VIEW_SELECT, { count: 'exact' })
        .eq('workspace_id', workspaceId)

    // The two Evals children are workspace-scoped exactly like every other
    // entity here. The SUITE scope is a plain `suite_id` filter the suite
    // detail page sends as a fixed scopeFilter — a real column, so no
    // synthetic field and no subquery, the prospect_list_entry arrangement.
    //
    // No `visibility` predicate on eval_case, unlike the captures branch
    // above: migration 252's own select policy on eval_case already makes a
    // 'private' case creator-only, and this builder is always called on the
    // CALLER's client (never the service one), so RLS is the gate. Adding a
    // second one here would be defence-in-depth on a table that, unlike
    // `captures`, has no service-client readers in the view path.
    case 'eval_case':
      return supabase
        .from('eval_case')
        .select(EVAL_CASE_VIEW_SELECT, { count: 'exact' })
        .eq('workspace_id', workspaceId)

    case 'eval_run':
      return supabase
        .from('eval_run')
        .select(EVAL_RUN_VIEW_SELECT, { count: 'exact' })
        .eq('workspace_id', workspaceId)

    // THE KNOWLEDGE UNIVERSE, defined once here.
    //
    // `status='active'` and `confirmation<>'dismissed'` are not filters the
    // user can clear — they are the boundary of what "knowledge" means, and
    // they are pinned here because the OTHER renderer of this same saved view,
    // the knowledge map, bakes the identical predicate into its layout
    // (graph-map/graph-build.ts `isVisible`). A superseded claim has no
    // position on the canvas, so if the list showed one, the same view would
    // hold different claims depending on which layout you were on — which is
    // the one promise this feature cannot break. Neither field is offered in
    // FILTERABLE_FIELDS.claim, so nothing in the UI can contradict this.
    case 'claim':
      return supabase
        .from('claim')
        .select(CLAIM_VIEW_SELECT, { count: 'exact' })
        .eq('workspace_id', workspaceId)
        .eq('status', 'active')
        .neq('confirmation', 'dismissed')

    // A table's live rows (migration 520). The table is a `table_id` filter
    // the table page sends; RLS gives a row its table's access.
    case 'data_row':
      return supabase
        .from('data_row')
        .select(DATA_ROW_VIEW_SELECT, { count: 'exact' })
        .eq('workspace_id', workspaceId)
        .is('archived_at', null)
  }
}

// ============================================================
// Filter Application
// ============================================================

/**
 * The workspaces a query is scoped to, as the helpers below pass them around:
 * one id (every ordinary call) or the personal-scope set.
 *
 * The distinction is deliberate rather than cosmetic. Helpers that filter rows
 * IN JS widen to the whole set; the one helper that puts a workspace id INTO a
 * query keeps the single id, so a single-workspace call emits the exact same
 * PostgREST request it always did — no `in.(one-id)` where an `eq` used to be.
 */
type WorkspaceScopeIds = string | readonly string[]

/** Every workspace in scope, for JS-side matching. */
function scopeIdSet(scope: WorkspaceScopeIds): Set<string> {
  return new Set(typeof scope === 'string' ? [scope] : scope)
}

/**
 * The single workspace a caller means when it is NOT in personal scope. The
 * array form only reaches entities that opt into personal scope (actions and
 * projects), and the one consumer of this — the sequence enrolled-contact
 * subquery — is not one of them, so it keeps its `eq` unchanged.
 */
function primaryScopeId(scope: WorkspaceScopeIds | undefined): string | undefined {
  if (scope === undefined) return undefined
  return typeof scope === 'string' ? scope : scope[0]
}

/**
 * Workflow states, fenced to the workspaces in scope. A state has no
 * workspace_id (it belongs to a team, migration 020), so the fence goes
 * through an inner-joined `team`. Without it the read returned every
 * workspace's states (a cross-tenant read on a service-role client) and was
 * cut at PostgREST's row cap before the JS-side scope match could see the
 * in-scope rows. A single workspace keeps an `eq`; the personal-scope set an
 * `in`. Callers still match the scope in JS, as before.
 */
const SCOPED_STATE_SELECT = 'id, team:team!team_id!inner(workspace_id)'
function scopedWorkflowStates(supabase: SupabaseClient, scope: WorkspaceScopeIds) {
  const base = supabase.from('workflow_state').select(SCOPED_STATE_SELECT)
  return typeof scope === 'string'
    ? base.eq('team.workspace_id', scope)
    : base.in('team.workspace_id', [...scope])
}

// Fields stored in junction tables, not directly on the entity row
const JUNCTION_FIELDS: Record<ViewEntityType, string[]> = {
  agent: [],
  skill: [],
  action: ['labels'],
  capture: ['labels'],
  contact: [],
  company: [],
  email_thread: ['labels'],
  document: [],
  initiative: ['labels'],
  project: ['labels'],
  flow: [],
  sequence: [],
  prospect_list: [],
  prospect_list_entry: [],
  eval_suite: [],
  eval_case: [],
  eval_run: [],
  claim: [],
  data_row: [],
}

// Label junction table name per entity type
const LABEL_JUNCTION_TABLE: Partial<Record<ViewEntityType, string>> = {
  action: 'action_label',
  capture: 'capture_label',
  email_thread: 'email_thread_label',
  initiative: 'initiative_label',
  project: 'project_label',
}

// Entity ID column in each label junction table
const LABEL_JUNCTION_ENTITY_ID: Partial<Record<ViewEntityType, string>> = {
  action: 'action_id',
  capture: 'capture_id',
  email_thread: 'email_thread_id',
  initiative: 'initiative_id',
  project: 'project_id',
}

// Fields that are virtual/computed and need special handling
const SKIP_FIELDS = new Set(['has_sub_actions', 'relations'])

/**
 * Columns an entity no longer has: a saved filter or sort on one degrades
 * (it is ignored) instead of failing the view. email_thread_index dropped its
 * subject, preview, display name and recipient lists (344: no stored mail).
 */
const DROPPED_FIELDS: Partial<Record<ViewEntityType, ReadonlySet<string>>> = {
  email_thread: new Set(['subject', 'snippet', 'from_name', 'to_emails', 'cc_emails']),
}

/** Whether a saved filter or sort names a column the entity no longer has. */
export function isDroppedField(entityType: ViewEntityType | undefined, field: string): boolean {
  return !!entityType && !!DROPPED_FIELDS[entityType]?.has(field)
}

// Fields that are text[] columns in Postgres
const ARRAY_FIELDS: Record<ViewEntityType, string[]> = {
  agent: [],
  skill: [],
  action: [],
  capture: [],
  contact: ['tags', 'prospect_list_ids'],
  company: ['tags', 'prospect_list_ids'],
  email_thread: [],
  document: [],
  initiative: [],
  project: [],
  flow: [],
  sequence: [],
  prospect_list: [],
  prospect_list_entry: [],
  eval_suite: [],
  // `eval_case.modes` is `text[] NOT NULL DEFAULT ARRAY['batch','live']`
  // (migration 252). Without this entry an `is`-filter on it would emit an
  // `eq` against an array column and match only cases whose modes are exactly
  // that one value — i.e. a "Live" filter would silently hide every case that
  // runs in both.
  eval_case: ['modes'],
  eval_run: [],
  // `project_ids` is a uuid[] kept in step with `entity_link` by a trigger
  // (migration 276). Without this entry an `is`-filter would emit an `eq`
  // against an array column and match only claims whose ONLY project is that
  // one — so "claims on Project X" would silently hide every claim that also
  // touches another project.
  claim: ['project_ids'],
  data_row: [],
}

function isJunctionField(entityType: ViewEntityType, field: string): boolean {
  return JUNCTION_FIELDS[entityType]?.includes(field) ?? false
}

/** A filter field whose values are workspace member ids (the "Me" option). */
function isMemberField(entityType: ViewEntityType, field: string): boolean {
  return field !== 'user_id' && (FILTERABLE_FIELDS[entityType] ?? []).some((f) => f.field === field && f.type === 'member')
}

function isArrayField(entityType: ViewEntityType, field: string): boolean {
  return ARRAY_FIELDS[entityType]?.includes(field) ?? false
}

/**
 * The types of a view's custom fields, by key: a table's columns, or a
 * kind's definitions. With them a filter reads each value in its own form
 * (a multi-select's list, a currency's amount, a person's member id); without
 * them the filter's value decides, as before (applyCustomFieldFilter).
 */
export type CustomFieldTypes = ReadonlyMap<string, CustomFieldShape>

/** A custom field as a filter reads it: its type, and a currency's own code. */
export interface CustomFieldShape {
  type: CustomFieldType
  /** currency: the column's code; amounts compare only in it. */
  currency?: string
}

export async function applyFilters(
  query: ReturnType<typeof buildEntityQuery>,
  entityType: ViewEntityType,
  filters: ViewFilter[],
  supabase?: SupabaseClient,
  /** One workspace id, or the personal-scope set (see WorkspaceScopeIds). */
  workspaceId?: WorkspaceScopeIds,
  /** Pass resolved IDs so @me can be expanded to the real member/user ID */
  resolvedIds?: { memberId?: string; userId?: string },
  opts: {
    fieldTypes?: CustomFieldTypes
    /** The reader's IANA zone: a custom date's relative window is that zone's days (a table's rows pass it). */
    timeZone?: string
  } = {},
) {
  for (const filter of filters) {
    const { field, operator } = filter
    let { value } = filter

    // Skip virtual/computed fields that can't be directly filtered, and
    // columns the entity no longer has (a saved filter degrades, never fails).
    if (SKIP_FIELDS.has(field)) continue
    if (isDroppedField(entityType, field)) {
      console.warn(`[views/query] ignoring filter on dropped field "${field}" (${entityType})`)
      continue
    }

    // Resolve @me to the actual member or user ID.
    //
    // WHICH ID depends on the column, not on the word "creator" in its label.
    // `created_by` is a MEMBER id on every table that exposes it as a filter —
    // `document.created_by` (migration 025:260) and `claim.created_by`
    // (migration 109:25) both `REFERENCES public.member(id)` — while
    // `action.user_id` / `capture.user_id` are auth user ids. Resolving
    // `created_by` to the auth user id (as this did until now) compared a user
    // id against a member id: two disjoint UUID spaces, so "Creator is me" on
    // Documents matched nothing at all and reported it as an empty list rather
    // than an error. The explicit-person case was always fine — the member
    // picker emits `member.id` — so only the @me shortcut was broken.
    //
    // Other tables DO have a `created_by` that references auth.users (flow,
    // 107:67), which is why this is keyed on the field rather than applied
    // blanket-wise: none of them expose it as a filter field today, and if one
    // ever does it needs an entity-aware branch here, not a silent inversion.
    //
    // Every other member-typed filter field (initiative `owner_id`, project
    // `lead_id`, …) is a member id too, and the multi-select operators carry
    // '@me' inside an array. Callers only pre-resolve the member id for actions,
    // so it is looked up here (once) for any other entity that needs it.
    const hasMe = value === '@me' || (Array.isArray(value) && value.includes('@me'))
    if (hasMe && resolvedIds) {
      let me: string | undefined
      if (field === 'user_id') {
        me = resolvedIds.userId
      } else if (
        field === 'assignee_id' || field === 'created_by' || isMemberField(entityType, field) ||
        opts.fieldTypes?.get(customFieldKeyOf(field) ?? '')?.type === 'person'
      ) {
        if (resolvedIds.memberId === undefined && resolvedIds.userId && supabase && workspaceId) {
          const { data: member } = await supabase
            .from('member')
            .select('id')
            .eq('user_id', resolvedIds.userId)
            .eq('workspace_id', primaryScopeId(workspaceId) as string)
            .maybeSingle()
          resolvedIds = { ...resolvedIds, memberId: (member?.id as string | undefined) ?? '' }
        }
        me = resolvedIds.memberId
      }
      if (field === 'user_id' || me !== undefined) {
        value = Array.isArray(value)
          ? value.map((v) => (v === '@me' ? me ?? '' : v)).filter((v) => v !== '')
          : me ?? ''
      }
    }

    // Skip filters the user has not filled in yet (`is_empty`/`is_not_empty`
    // carry no value and mean something precise without one). Shared with the
    // knowledge map's own filter translation through `isUnsetFilterValue`, so
    // the two engines cannot disagree about which chips are live.
    if (!['is_empty', 'is_not_empty'].includes(operator) && isUnsetFilterValue(value)) {
      continue
    }
    // A relative window that isn't one (a hand-written or broken view) is skipped like an unset one.
    if (operator === 'is_relative' && !isRelativeDateValue(value)) continue

    // A custom field (`custom_fields.<key>`): read out of the record's jsonb.
    // A malformed key, or a kind that takes no fields, is ignored like a
    // dropped column: a saved filter degrades, it never fails the view.
    if (isCustomFieldPath(field)) {
      const key = customFieldKeyOf(field)
      if (!key || !viewTakesCustomFields(entityType)) {
        console.warn(`[views/query] ignoring filter on custom field "${field}" (${entityType})`)
        continue
      }
      applyCustomFieldFilter(query, key, operator, value, opts.fieldTypes?.get(key), opts.timeZone)
      continue
    }

    // Virtual field: status_type maps to workflow_state.category → status_id
    if (field === 'status_type' && supabase && workspaceId) {
      await applyStatusTypeFilter(query, supabase, workspaceId, operator, value)
      continue
    }

    // Status `is` / `is not` holds ONE workflow_state id, but states are per
    // team and the Status picker offers one option per name. Match every
    // in-scope state with the same name and category, as the board's status
    // columns already merge them, so team B's "Todo" is not silently dropped.
    if (
      entityType === 'action' && field === 'status_id' && (operator === 'is' || operator === 'is_not') &&
      typeof value === 'string' && value !== NO_MATCH_FILTER_VALUE && supabase && workspaceId
    ) {
      await applySameNamedStatusFilter(query, supabase, workspaceId, operator, value)
      continue
    }

    // Flow virtual fields: the trigger entity type lives inside the
    // trigger_config jsonb; last_run_status lives on the embedded latest run.
    if (entityType === 'flow') {
      if (field === 'trigger_entity_type') {
        applyColumnFilter(query, 'trigger_config->>entity_type', operator, value)
        continue
      }
      if (field === 'last_run_status') {
        // Filter on the embedded flow_run's status. PostgREST applies this to
        // the embedded resource; rows with no matching run are still returned
        // with an empty run array, which the row renderer treats as "no runs".
        applyColumnFilter(query, 'flow_run.status', operator, value)
        continue
      }
    }

    // Prospect-list virtual fields: both live on the embedded newest
    // `prospecting_run`, exactly like flow's last_run_status above. PostgREST
    // applies the filter to the embedded resource; a list with no run is still
    // returned, with an empty run array the row renderer reads as "never run".
    if (entityType === 'prospect_list') {
      if (field === 'last_run_status') {
        applyColumnFilter(query, 'prospecting_run.status', operator, value)
        continue
      }
      if (field === 'last_run_kind') {
        applyColumnFilter(query, 'prospecting_run.kind', operator, value)
        continue
      }
    }

    // Sequence internal scope field: "sequences having an enrollment for this
    // contact" (contact detail panel → Sequences embed). Deliberately absent
    // from FILTERABLE_FIELDS — a fixed scope filter, never a user pick.
    if (entityType === 'sequence' && field === 'enrolled_contact_id') {
      await applyEnrolledContactFilter(query, operator, value, supabase, primaryScopeId(workspaceId))
      continue
    }

    // Junction table fields (labels via join tables)
    if (isJunctionField(entityType, field)) {
      await applyJunctionFilter(query, entityType, field, operator, value, supabase)
      continue
    }

    // Postgres text[] array columns (tags)
    if (isArrayField(entityType, field)) {
      applyArrayColumnFilter(query, field, operator, value)
      continue
    }

    // Standard column filters
    applyColumnFilter(query, field, operator, value)
  }
}

/**
 * Per-entity defaults that depend on WHICH filters the caller sent, applied
 * after `applyFilters` and before the query is awaited.
 *
 * Today that is one rule: a prospect-list query hides `status='archived'`
 * rows unless the caller filters on `status` explicitly. The card index this
 * view replaces had the same contract (`listLists({ includeArchived })`), and
 * it has to live outside `buildEntityQuery` — which never sees the filters —
 * and outside `applyFilters`, which the query route skips entirely when a view
 * carries no filters at all (the unfiltered index is exactly the case that
 * must still hide archived lists).
 *
 * "Explicitly" means a filter on the `status` FIELD, whatever its operator: a
 * user asking `status is_not active`, or `status is_any_of [active, archived]`,
 * has said what they want to see, and a hidden `.eq('status','active')` on top
 * of it would silently return nothing.
 *
 * The prospect list ENTRY has the same shape of rule: dismissed entries stay
 * hidden unless a filter names `stage` — see the body.
 *
 * Call it once per query, from every caller of buildEntityQuery. Entities with
 * no default are a no-op.
 */
export function applyEntityDefaults(
  query: ReturnType<typeof buildEntityQuery>,
  entityType: ViewEntityType,
  filters: ViewFilter[],
) {
  if (entityType === 'prospect_list') {
    const explicitStatus = filters.some((f) => f.field === 'status')
    if (!explicitStatus) query.eq('status', 'active')
  }
  // A prospect list is something the user WORKS: a dismissed entry has left it
  // (that is what dismissing is for) and lives under the Dismissed tab. So the
  // default is "everything still on the list", and it is enforced HERE rather
  // than by the page's All tab so that a custom view with no opinion about
  // stage inherits it — while one that names `stage` ("Stage is dismissed")
  // has said what it wants to see and is left alone, whatever the operator.
  if (entityType === 'prospect_list_entry') {
    const explicitStage = filters.some((f) => f.field === 'stage')
    if (!explicitStage) query.neq('stage', 'dismissed')
  }
  // Skill and loop reports and meeting preps (document.kind, migration 367)
  // are a third of the documents and drown the ones people keep: a document
  // list shows docs only unless a filter names `kind` ("Kind is report"). A
  // query scoped by `id` already names the documents it wants (a delivered
  // report opened by id, a scope filter): every kind of them.
  if (entityType === 'document') {
    const explicitKind = filters.some((f) => f.field === 'kind' || f.field === 'id')
    if (!explicitKind) query.eq('kind', 'doc')
  }
}

/**
 * Resolves a status_type filter (category like 'completed', 'started', etc.)
 * to actual workflow_state IDs and applies as a status_id filter.
 *
 * `workspaceId` may be the personal-scope SET, in which case the states of
 * every workspace in scope resolve — a workflow state is per TEAM (migration
 * 020), so a cross-workspace board matching on `category` is the only way the
 * categories line up at all. The read is fenced to the scope in SQL
 * (scopedWorkflowStates) and narrowed by category.
 */
async function applyStatusTypeFilter(
  query: ReturnType<typeof buildEntityQuery>,
  supabase: SupabaseClient,
  workspaceId: WorkspaceScopeIds,
  operator: FilterOperator,
  value: unknown,
) {
  // Resolve category values to workflow_state IDs
  const categories = Array.isArray(value) ? value as string[] : [value as string]
  const { data: states } = await scopedWorkflowStates(supabase, workspaceId)
    .in('category', categories)

  const inScope = scopeIdSet(workspaceId)
  const stateIds = (states || [])
    .filter((s) => inScope.has((s.team as unknown as { workspace_id: string })?.workspace_id))
    .map((s) => s.id)

  switch (operator) {
    case 'is':
    case 'is_any_of':
      if (stateIds.length > 0) query.in('status_id', stateIds)
      // No workflow states in the chosen categories → the view provably matches
      // nothing. Signal a short-circuit instead of comparing a sentinel string
      // against the uuid status_id column (which would raise 22P02).
      else throw new NoMatchSignal()
      break
    case 'is_not':
    case 'is_none_of':
      if (stateIds.length > 0) query.not('status_id', 'in', `(${stateIds.join(',')})`)
      // No states to exclude → excluding nothing is vacuously true → no-op.
      break
  }
}

/**
 * `status_id is / is not <state>` widened to every in-scope workflow state with
 * that state's name and category (one per team). An id that does not resolve
 * keeps the plain column comparison.
 */
async function applySameNamedStatusFilter(
  query: ReturnType<typeof buildEntityQuery>,
  supabase: SupabaseClient,
  workspaceId: WorkspaceScopeIds,
  operator: 'is' | 'is_not',
  stateId: string,
) {
  const { data: picked } = await supabase
    .from('workflow_state')
    .select('name, category')
    .eq('id', stateId)
    .maybeSingle()
  let stateIds = [stateId]
  if (picked) {
    const { data: states } = await scopedWorkflowStates(supabase, workspaceId)
      .eq('name', picked.name)
      .eq('category', picked.category)
    const inScope = scopeIdSet(workspaceId)
    stateIds = [...new Set([
      stateId,
      ...(states || [])
        .filter((s) => inScope.has((s.team as unknown as { workspace_id: string })?.workspace_id))
        .map((s) => s.id as string),
    ])]
  }
  if (operator === 'is') query.in('status_id', stateIds)
  else query.not('status_id', 'in', `(${stateIds.join(',')})`)
}

/**
 * True when `value` (or every element of an array value) is the no-match
 * sentinel. Already-deployed clients keep sending the literal string as a
 * filter value (e.g. a contact scope with zero captures), so the generic
 * column path must recognize it here and never let it reach a uuid column.
 */
function isNoMatchValue(value: unknown): boolean {
  if (value === NO_MATCH_FILTER_VALUE) return true
  return Array.isArray(value) && value.length > 0 && value.every((v) => v === NO_MATCH_FILTER_VALUE)
}

function applyColumnFilter(
  query: ReturnType<typeof buildEntityQuery>,
  field: string,
  operator: FilterOperator,
  value: unknown,
) {
  // A client-sent no-match sentinel arriving as a VALUE. For positive operators
  // it means "match nothing" → short-circuit (never cast the string to uuid).
  // For negation operators (is_not / is_none_of) "not the impossible value" is
  // vacuously true for every row, so it's a no-op filter — do NOT nuke the query.
  if (isNoMatchValue(value)) {
    if (operator === 'is' || operator === 'is_any_of') throw new NoMatchSignal()
    if (operator === 'is_not' || operator === 'is_none_of') return
  }
  // A MIXED array (real values alongside the sentinel) still carries elements
  // that can never match — strip them so they never reach a uuid cast; the
  // remaining real values filter normally. (All-sentinel arrays were handled
  // above; an is_not/is_none_of sentinel element is vacuous to exclude.)
  if (Array.isArray(value) && value.some((v) => v === NO_MATCH_FILTER_VALUE)) {
    value = value.filter((v) => v !== NO_MATCH_FILTER_VALUE)
  }

  switch (operator) {
    case 'is':
      query.eq(field, value)
      break
    case 'is_not':
      query.neq(field, value)
      break
    case 'is_any_of':
      query.in(field, value as string[])
      break
    case 'is_none_of':
      query.not(field, 'in', `(${(value as string[]).join(',')})`)
      break
    case 'contains':
      query.ilike(field, `%${value}%`)
      break
    case 'does_not_contain':
      query.not(field, 'ilike', `%${value}%`)
      break
    case 'starts_with':
      query.ilike(field, `${value}%`)
      break
    case 'ends_with':
      query.ilike(field, `%${value}`)
      break
    case 'is_empty':
      query.is(field, null)
      break
    case 'is_not_empty':
      query.not(field, 'is', null)
      break
    case 'gt':
      query.gt(field, value)
      break
    case 'gte':
      query.gte(field, value)
      break
    case 'lt':
      query.lt(field, value)
      break
    case 'lte':
      query.lte(field, value)
      break
    case 'between': {
      // A half-filled range applies only the bound that is set; the unset one
      // would otherwise reach PostgREST as `lte.undefined` and fail the query.
      const range = (value ?? {}) as Partial<RangeValue>
      if (!isUnsetFilterValue(range.from)) query.gte(field, range.from)
      if (!isUnsetFilterValue(range.to)) query.lte(field, range.to)
      break
    }
    case 'is_relative': {
      const resolved = resolveRelativeDate(value as RelativeDateValue)
      query.gte(field, resolved.from).lte(field, resolved.to)
      break
    }
  }
}

// ============================================================
// Custom fields (migrations 473, 496)
// ============================================================

/** A day ("2026-11-10"), or an ISO instant on one ("2026-11-10T08:00:00.000Z"). */
const DAY_OR_INSTANT_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/

/** The day a value names, or null when it is not a day or an instant. */
function dayOf(value: unknown): string | null {
  return typeof value === 'string' && DAY_OR_INSTANT_RE.test(value) ? value.slice(0, 10) : null
}

function numberOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || value.trim() === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** A value for a PostgREST `in` list, quoted so a comma or a bracket in a select option stays inside it. */
function inListItem(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

type ComparisonOperator = 'gt' | 'gte' | 'lt' | 'lte'

/**
 * One comparison bound on a custom field. A number compares through `->`
 * (jsonb, which orders numbers as numbers: 6 < 10), a day through `->>` as
 * `YYYY-MM-DD` text (which orders as the calendar does), anything else as
 * text. Through `->>` a number would compare as text, and "6" > "10".
 */
function applyCustomFieldBound(
  query: ReturnType<typeof buildEntityQuery>,
  key: string,
  operator: ComparisonOperator,
  value: unknown,
) {
  if (isUnsetFilterValue(value)) return
  const n = numberOf(value)
  const day = dayOf(value)
  if (n !== null && (typeof value === 'number' || day === null)) {
    query[operator](`custom_fields->${key}`, n)
  } else if (day !== null) {
    query[operator](`custom_fields->>${key}`, day)
  } else {
    query[operator](`custom_fields->>${key}`, String(value))
  }
}

/**
 * A filter on one of the workspace's own fields, read out of the record's
 * `custom_fields` jsonb by its key (already checked against the definitions'
 * key shape, so it is safe to put in a column string).
 *
 * The field's TYPE comes from the filter itself, not from a definitions read:
 * the chip a type draws decides the value's shape (a number field's input
 * sends a number, a date field's calendar a `YYYY-MM-DD` day, a text or
 * select field a string), so no extra query is needed to pick `->` or `->>`.
 * The values themselves are coerced on write (coerceCustomValue): a number
 * is stored as a JSON number, a date as a `YYYY-MM-DD` string, a select as
 * its option's own spelling, and a cleared field has no key at all, so
 * "is empty" is one `is null`.
 *
 * Verified against DEV's PostgREST: `custom_fields->k=gt.5` compares jsonb
 * numerically, `custom_fields->>k` compares text, and both order.
 */
export function applyCustomFieldFilter(
  query: ReturnType<typeof buildEntityQuery>,
  key: string,
  operator: FilterOperator,
  value: unknown,
  /** The field's type, when the caller knows it (CustomFieldTypes). */
  shape?: CustomFieldShape,
  /** The reader's IANA zone, for a relative window's days. */
  timeZone?: string,
) {
  const text = `custom_fields->>${key}`
  const json = `custom_fields->${key}`
  switch (shape?.type) {
    case 'multi_select':
    case 'relation':
      if (operator === 'is_empty' || operator === 'is_not_empty') break
      return applyCustomListFilter(query, key, operator, value)
    case 'checkbox':
      return applyCustomCheckboxFilter(query, key, operator, value)
    case 'currency':
      if (operator === 'is_empty' || operator === 'is_not_empty') break
      return applyCustomCurrencyFilter(query, key, operator, value, shape?.currency)
    case 'select':
    case 'person':
      if (applyCustomOneOfFilter(query, key, operator, value)) return
      break
  }
  switch (operator) {
    case 'is_empty':
      query.is(text, null)
      return
    case 'is_not_empty':
      query.not(text, 'is', null)
      return
    case 'contains':
    case 'does_not_contain':
    case 'starts_with':
    case 'ends_with':
      if (typeof value === 'string' || typeof value === 'number') applyColumnFilter(query, text, operator, String(value))
      return
    case 'is':
    case 'is_not': {
      const eq = operator === 'is'
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) return
        if (eq) query.eq(json, value)
        else query.neq(json, value)
        return
      }
      if (typeof value !== 'string') return
      // A day picked on a timestamp-shaped chip (an older saved view) is that day.
      const v = dayOf(value) ?? value
      if (eq) query.eq(text, v)
      else query.neq(text, v)
      return
    }
    case 'is_any_of':
    case 'is_none_of': {
      const list = (Array.isArray(value) ? value : [value]).filter(
        (v): v is string | number => (typeof v === 'string' && v !== '') || (typeof v === 'number' && Number.isFinite(v)),
      )
      if (!list.length) return
      const numeric = list.every((v) => typeof v === 'number')
      const column = numeric ? json : text
      // Built here, not with `.in()`: postgrest-js quotes a value with a comma
      // or a bracket but leaves a `"` inside it bare, so an option like
      // `12" pipe, large` would break the whole query. Both operators take
      // the same escaped list.
      const inList = `(${list.map((v) => (numeric ? String(v) : inListItem(String(v)))).join(',')})`
      if (operator === 'is_any_of') query.filter(column, 'in', inList)
      else query.not(column, 'in', inList)
      return
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      applyCustomFieldBound(query, key, operator, value)
      return
    case 'between': {
      const range = (value ?? {}) as Partial<RangeValue>
      applyCustomFieldBound(query, key, 'gte', range.from)
      applyCustomFieldBound(query, key, 'lte', range.to)
      return
    }
    case 'is_relative': {
      // The window as calendar days: the values are days, not instants, in the reader's zone when known.
      const now = timeZone ? wallClockIn(timeZone) : undefined
      const resolved = resolveRelativeDate(value as RelativeDateValue, now)
      query.gte(text, format(new Date(resolved.from), 'yyyy-MM-dd')).lte(text, format(new Date(resolved.to), 'yyyy-MM-dd'))
      return
    }
    default:
      // includes / excludes / equals are label and tag operators: no custom
      // field type offers them.
      return
  }
}

// ── Custom fields by type ───────────────────────────────────────────────────
//
// Where a filter can be a containment on the whole `custom_fields` object
// (`custom_fields @> {"key": …}`), it is one: that is what the jsonb_path_ops
// index on data_row.custom_fields answers (migration 529), and it reads a
// select, a person, a checkbox, a multi-select and a relation alike. "Is not"
// on a select or a person keeps the meaning a column's `neq` has everywhere
// (and custom fields had before): a value, and not this one, so a record with
// none is not counted. "Excludes" on a list counts a record with none, as an
// array column's does. "Any of" is an or=(...) of
// containments, each quoted for PostgREST's list syntax (checked on DEV).

/** `{"key": value}` as JSON, for `cs`. */
function holdsJson(key: string, value: unknown): string {
  return JSON.stringify({ [key]: value })
}

/** One containment as a term of an or=(...) list: quoted, with its quotes and backslashes escaped. */
export function holdsTerm(key: string, value: unknown): string {
  return `custom_fields.cs."${holdsJson(key, value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function stringsOf(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value]
  return list.filter((v): v is string => typeof v === 'string' && v !== '')
}

/** A select or a person: one value. False for an operator the generic path handles. */
function applyCustomOneOfFilter(
  query: ReturnType<typeof buildEntityQuery>,
  key: string,
  operator: FilterOperator,
  value: unknown,
): boolean {
  const list = stringsOf(value)
  switch (operator) {
    case 'is':
      if (list.length) query.contains('custom_fields', { [key]: list[0] })
      return true
    case 'is_not':
      if (!list.length) return true
      query.not(`custom_fields->>${key}`, 'is', null)
      query.not('custom_fields', 'cs', holdsJson(key, list[0]))
      return true
    case 'is_any_of':
      if (list.length === 1) query.contains('custom_fields', { [key]: list[0] })
      else if (list.length) query.or(list.map((v) => holdsTerm(key, v)).join(','))
      return true
    case 'is_none_of':
      if (!list.length) return true
      query.not(`custom_fields->>${key}`, 'is', null)
      for (const v of list) query.not('custom_fields', 'cs', holdsJson(key, v))
      return true
    default:
      return false
  }
}

/**
 * A multi-select or a relation: a list. "Includes" holds every value picked
 * (as an array field's `includes` does), "excludes" holds none of them, "any
 * of" holds at least one.
 */
function applyCustomListFilter(
  query: ReturnType<typeof buildEntityQuery>,
  key: string,
  operator: FilterOperator,
  value: unknown,
) {
  const list = stringsOf(value)
  if (!list.length) return
  switch (operator) {
    case 'is':
    case 'includes':
    case 'equals':
      query.contains('custom_fields', { [key]: list })
      return
    case 'is_any_of':
      if (list.length === 1) query.contains('custom_fields', { [key]: list })
      else query.or(list.map((v) => holdsTerm(key, [v])).join(','))
      return
    case 'is_not':
    case 'excludes':
    case 'is_none_of':
      for (const v of list) query.not('custom_fields', 'cs', holdsJson(key, [v]))
      return
  }
}

/** A checkbox: checked, or not (a row never ticked is not). */
function applyCustomCheckboxFilter(
  query: ReturnType<typeof buildEntityQuery>,
  key: string,
  operator: FilterOperator,
  value: unknown,
) {
  if (operator !== 'is' && operator !== 'is_not') return
  const checked = value === true || value === 'true'
  if (checked === (operator === 'is')) query.contains('custom_fields', { [key]: true })
  else query.not('custom_fields', 'cs', holdsJson(key, true))
}

/**
 * A currency: its amount compares as a number (`->amount`, jsonb), and only
 * in the column's own code (a containment on it), so $1,000 is never weighed
 * against ¥1,000. Without a code (a caller that doesn't know it) every
 * amount compares.
 */
function applyCustomCurrencyFilter(
  query: ReturnType<typeof buildEntityQuery>,
  key: string,
  operator: FilterOperator,
  value: unknown,
  currency?: string,
) {
  const amount = `custom_fields->${key}->amount`
  let inCode = false
  const sameCode = () => {
    if (inCode || !currency) return
    inCode = true
    query.contains('custom_fields', { [key]: { currency } })
  }
  const bound = (op: ComparisonOperator, v: unknown) => {
    const n = numberOf(v)
    if (n === null) return
    sameCode()
    query[op](amount, n)
  }
  switch (operator) {
    case 'is':
    case 'is_not': {
      const n = numberOf(value)
      if (n === null) return
      sameCode()
      if (operator === 'is') query.eq(amount, n)
      else query.neq(amount, n)
      return
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      bound(operator, value)
      return
    case 'between': {
      const range = (value ?? {}) as Partial<RangeValue>
      bound('gte', range.from)
      bound('lte', range.to)
      return
    }
  }
}

/**
 * Sequence membership by enrolled contact — an EXISTS on sequence_enrollment
 * by contact_id, expressed the only way PostgREST allows for a non-embedded
 * table: resolve the enrolled sequence ids first, then `id in (...)` — the
 * same two-step shape as the label 'equals' subquery below.
 *
 * Only positive membership ('is' / 'is_any_of') is meaningful; the field is
 * internal — the contact panel embed is its only writer and always sends
 * 'is'. Every degenerate input fails CLOSED via NoMatchSignal: an unsupported
 * operator, a contact with zero enrollments, a no-match sentinel, or a
 * missing supabase client. A silent return here would mean "no filter", i.e.
 * the full unscoped workspace list — the opposite of what the caller asked
 * for — and unlike a real column there is no vacuous-truth reading for
 * negation on a synthetic scope field. Failing closed also keeps sentinel
 * strings away from the uuid `id` column (22P02).
 */
async function applyEnrolledContactFilter(
  query: ReturnType<typeof buildEntityQuery>,
  operator: FilterOperator,
  value: unknown,
  supabase?: SupabaseClient,
  workspaceId?: string,
) {
  if (operator !== 'is' && operator !== 'is_any_of') throw new NoMatchSignal()
  if (isNoMatchValue(value) || !supabase) throw new NoMatchSignal()
  const contactIds = (Array.isArray(value) ? value : [value]).filter(
    (v): v is string => typeof v === 'string' && v !== '' && v !== NO_MATCH_FILTER_VALUE,
  )
  if (contactIds.length === 0) throw new NoMatchSignal()

  let sub = supabase
    .from('sequence_enrollment')
    .select('sequence_id')
    .in('contact_id', contactIds)
  // Defence-in-depth beside RLS — the outer query is already workspace-scoped.
  if (workspaceId) sub = sub.eq('workspace_id', workspaceId)
  const { data } = await sub

  const sequenceIds = [
    ...new Set(((data ?? []) as { sequence_id: string }[]).map((r) => r.sequence_id)),
  ]
  if (sequenceIds.length === 0) throw new NoMatchSignal()
  query.in('id', sequenceIds)
}

/**
 * Append an aliased embed to a PostgREST query's `select`, so a filter can be
 * written as a join in SQL instead of an entity-id list in the URL. Returns
 * the alias used, or null when the query is not a PostgREST builder (no
 * request URL to extend). Each call gets its own alias (`label_match`,
 * `label_match_2`, …): two label filters on one view (a saved filter plus an
 * ad-hoc one) must be two joins, or both would constrain the same junction
 * row and "has A and has B" could never match.
 */
function addFilterEmbed(
  query: ReturnType<typeof buildEntityQuery>,
  baseAlias: string,
  embed: string,
): string | null {
  const url = (query as unknown as { url?: unknown }).url
  if (!(url instanceof URL)) return null
  const select = url.searchParams.get('select') || '*'
  const taken = new Set(select.split(',').map((part) => part.split(':')[0]))
  let alias = baseAlias
  for (let n = 2; taken.has(alias); n++) alias = `${baseAlias}_${n}`
  url.searchParams.set('select', `${select},${alias}:${embed}`)
  return alias
}

async function applyJunctionFilter(
  query: ReturnType<typeof buildEntityQuery>,
  entityType: ViewEntityType,
  field: string,
  operator: FilterOperator,
  value: unknown,
  supabase?: SupabaseClient,
) {
  if (field === 'labels') {
    const junctionTable = LABEL_JUNCTION_TABLE[entityType]
    if (!junctionTable) return // Entity type doesn't support labels
    // A label can tag thousands of rows: resolving them to an `id=in.(…)` list
    // overflowed the request URL past a few hundred ids (the view errored) and
    // stopped at 1000 junction rows (the filter silently missed the rest). So
    // the filter is a join on its own aliased embed of the junction: `!inner`
    // keeps only rows holding one of the labels; a plain embed filtered to the
    // labels plus `alias=is.null` keeps only rows holding none of them. The
    // `labels:` display embed is a separate alias and is left untouched.
    if (operator === 'includes' || operator === 'equals' || operator === 'excludes') {
      const labelIds = (Array.isArray(value) ? value : [value]).filter(
        (v): v is string => typeof v === 'string' && v !== '',
      )
      const include = operator !== 'excludes'
      if (labelIds.length === 0) {
        if (include) throw new NoMatchSignal()
        return
      }
      const alias = addFilterEmbed(
        query,
        include ? 'label_match' : 'label_exclude',
        `${junctionTable}${include ? '!inner' : ''}(label_id)`,
      )
      if (alias) {
        query.in(`${alias}.label_id`, labelIds)
        if (!include) query.is(alias, null)
        return
      }
    }
    switch (operator) {
      // includes / excludes / equals all resolve through a junction subquery:
      // PostgREST embedded filters (`action_label.label_id=eq.X`) only filter
      // the EMBEDDED array — every parent row still comes back, just with a
      // thinner labels list, so an embedded-filter "includes" silently showed
      // everything. The multi-select picker sends arrays; single values are
      // normalized into one-element arrays.
      case 'includes':
      case 'equals': {
        const entityIdCol = LABEL_JUNCTION_ENTITY_ID[entityType]
        if (!supabase || !entityIdCol) {
          // Fallback to embedded filter if supabase not available
          query.filter(`${junctionTable}.label_id`, 'eq', value as string)
          break
        }
        const labelIds = (Array.isArray(value) ? value : [value]) as string[]
        const { data: matchingRows } = await supabase
          .from(junctionTable)
          .select(entityIdCol)
          .in('label_id', labelIds)
        const matchingIds = [...new Set(
          (matchingRows || []).map((r) => (r as unknown as Record<string, string>)[entityIdCol]),
        )]
        if (matchingIds.length === 0) {
          // No entities carry any of these labels — the view provably matches
          // nothing. Signal a short-circuit instead of comparing a sentinel
          // string against the uuid id column (which would raise 22P02).
          throw new NoMatchSignal()
        } else {
          query.in('id', matchingIds)
        }
        break
      }
      case 'excludes': {
        const entityIdCol = LABEL_JUNCTION_ENTITY_ID[entityType]
        if (!supabase || !entityIdCol) {
          query.not(`${junctionTable}.label_id`, 'eq', value as string)
          break
        }
        const labelIds = (Array.isArray(value) ? value : [value]) as string[]
        const { data: matchingRows } = await supabase
          .from(junctionTable)
          .select(entityIdCol)
          .in('label_id', labelIds)
        const matchingIds = [...new Set(
          (matchingRows || []).map((r) => (r as unknown as Record<string, string>)[entityIdCol]),
        )]
        // Nothing carries the label → nothing to exclude.
        if (matchingIds.length > 0) {
          query.not('id', 'in', `(${matchingIds.join(',')})`)
        }
        break
      }
      case 'is_empty':
        query.is(junctionTable as string, null)
        break
      case 'is_not_empty':
        query.not(junctionTable as string, 'is', null)
        break
    }
  }
}

function applyArrayColumnFilter(
  query: ReturnType<typeof buildEntityQuery>,
  field: string,
  operator: FilterOperator,
  value: unknown,
) {
  const values = Array.isArray(value) ? (value as string[]) : [value as string]
  switch (operator) {
    // An array field declared as `enum` (eval_case.modes) is offered the ENUM
    // operators, never includes/excludes — the filter UI derives the dropdown
    // from OPERATORS_BY_TYPE[type] alone. Without these four cases an
    // enum-typed array filter falls off the switch and emits NO predicate at
    // all: the chip renders active while the list stays unfiltered.
    // `is`/`is_not` = "the row's array HOLDS this value" (contains), which is
    // what a user picking "Live" means for a case that runs batch+live.
    case 'is':
    case 'includes':
      query.contains(field, values)
      break
    case 'is_not':
    case 'excludes':
      query.not(field, 'cs', `{${values.join(',')}}`)
      break
    // `is_any_of`/`is_none_of` = "holds ANY of these" — overlaps, not contains,
    // which would demand the row hold every one of them.
    case 'is_any_of':
      query.overlaps(field, values)
      break
    case 'is_none_of':
      query.not(field, 'ov', `{${values.join(',')}}`)
      break
    // AN ARRAY COLUMN IS EMPTY WHEN IT IS `{}`, NOT WHEN IT IS NULL.
    //
    // Every array field in the schema is `NOT NULL DEFAULT '{}'` —
    // `claim.project_ids` (migration 276), `contact.prospect_list_ids` and
    // `company.prospect_list_ids` (259), `eval_case.modes` (252). So the scalar
    // NULL test these used to share matched nothing at all: "Project is empty"
    // returned zero rows while "is not empty" returned EVERY row, both silently.
    //
    // For claims this was worse than a wrong list, because the knowledge map
    // answers the same saved view from its own mask, where "no project hub" is
    // a real and correctly-computed state — so one view drew a canvas full of
    // un-projected claims and a list that said "No claims".
    case 'is_empty':
      query.eq(field, '{}')
      break
    case 'is_not_empty':
      query.neq(field, '{}')
      break
  }
}

// ============================================================
// Relative Date Resolution
// ============================================================

const RELATIVE_UNITS = new Set(['day', 'week', 'month', 'quarter', 'year'])
const RELATIVE_DIRECTIONS = new Set(['past', 'future', 'this'])

/** A relative window a filter can hold: a known unit and direction, and a whole count of at least 1 when it has one. */
export function isRelativeDateValue(value: unknown): value is RelativeDateValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Partial<RelativeDateValue>
  if (!RELATIVE_UNITS.has(String(v.unit)) || !RELATIVE_DIRECTIONS.has(String(v.direction))) return false
  return v.count === undefined || (typeof v.count === 'number' && Number.isInteger(v.count) && v.count >= 1 && v.count <= 10_000)
}

/**
 * Now as a wall clock in an IANA time zone (a Date whose local fields read
 * that zone's date and time), or undefined for a zone the runtime doesn't know.
 */
export function wallClockIn(timeZone: string, at: Date = new Date()): Date | undefined {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
        .formatToParts(at)
        .map((p) => [p.type, p.value]),
    )
    return new Date(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second))
  } catch {
    return undefined
  }
}

/**
 * Exported for the knowledge map's service layer.
 *
 * A saved claim view can be drawn as a SQL list or as the WebGL map, and an
 * `is_relative` filter has to mean the same window in both. The map therefore
 * resolves its relative predicates through THIS function rather than
 * reimplementing "last 30 days" over epoch milliseconds — two implementations
 * of a window that starts at `startOfDay` would agree until the first DST
 * boundary and then quietly disagree by an hour.
 */
export function resolveRelativeDate(value: RelativeDateValue, now: Date = new Date()): { from: string; to: string } {
  switch (value.direction) {
    case 'past': {
      const count = value.count ?? 1
      let from: Date
      switch (value.unit) {
        case 'day':
          from = subDays(now, count)
          break
        case 'week':
          from = subWeeks(now, count)
          break
        case 'month':
          from = subMonths(now, count)
          break
        case 'quarter':
          from = subMonths(now, count * 3)
          break
        case 'year':
          from = subYears(now, count)
          break
      }
      return { from: startOfDay(from).toISOString(), to: now.toISOString() }
    }
    case 'future': {
      const count = value.count ?? 1
      let to: Date
      switch (value.unit) {
        case 'day':
          to = addDays(now, count)
          break
        case 'week':
          to = addWeeks(now, count)
          break
        case 'month':
          to = addMonths(now, count)
          break
        case 'quarter':
          to = addMonths(now, count * 3)
          break
        case 'year':
          to = addYears(now, count)
          break
      }
      return { from: now.toISOString(), to: endOfDay(to).toISOString() }
    }
    case 'this': {
      switch (value.unit) {
        case 'day':
          return { from: startOfDay(now).toISOString(), to: endOfDay(now).toISOString() }
        case 'week':
          return { from: startOfWeek(now).toISOString(), to: endOfWeek(now).toISOString() }
        case 'month':
          return { from: startOfMonth(now).toISOString(), to: endOfMonth(now).toISOString() }
        case 'quarter':
          return { from: startOfQuarter(now).toISOString(), to: endOfQuarter(now).toISOString() }
        case 'year':
          return { from: startOfYear(now).toISOString(), to: endOfYear(now).toISOString() }
      }
    }
  }
}

// ============================================================
// Completed Filter (action-specific)
// ============================================================

/**
 * `workspaceId` may be the personal-scope SET (see WorkspaceScopeIds), in which
 * case "done" resolves across every workspace in scope. The match is by
 * CATEGORY — a workflow state belongs to one team (migration 020), so there is
 * no state, and no name, that several workspaces share; only the category is
 * common vocabulary. The read is fenced to the scope in SQL
 * (scopedWorkflowStates) and narrowed by category.
 */
export async function applyCompletedFilter(
  supabase: SupabaseClient,
  query: ReturnType<typeof buildEntityQuery>,
  completedFilter: string,
  showCompleted: boolean,
  workspaceId: WorkspaceScopeIds,
) {
  if (showCompleted && completedFilter === 'all') return

  // Get completed + canceled state IDs for every workspace in scope
  const categories = ['completed', 'canceled']
  const { data: doneStates } = await scopedWorkflowStates(supabase, workspaceId)
    .in('category', categories)

  const inScope = scopeIdSet(workspaceId)
  const doneIds = (doneStates || [])
    .filter((s) => inScope.has((s.team as unknown as { workspace_id: string })?.workspace_id))
    .map((s) => s.id)

  if (!showCompleted || completedFilter === 'none') {
    // Exclude all completed/canceled
    if (doneIds.length > 0) {
      query.not('status_id', 'in', `(${doneIds.join(',')})`)
    }
  } else if (completedFilter === 'recent') {
    // Include completed only from last 2 weeks
    const twoWeeksAgo = subDays(new Date(), 14).toISOString()
    // This is complex with PostgREST — we use an OR: not-done OR (done AND updated recently)
    query.or(
      `status_id.not.in.(${doneIds.join(',')}),and(status_id.in.(${doneIds.join(',')}),updated_at.gte.${twoWeeksAgo})`,
    )
  }
}

// ============================================================
// Team Scope
// ============================================================

export function applyTeamScope(
  query: ReturnType<typeof buildEntityQuery>,
  entityType: ViewEntityType,
  teamId: string,
) {
  switch (entityType) {
    case 'action':
    case 'flow':
      // Actions and flows always have team_id (NOT NULL) — safe to scope by team.
      query.eq('team_id', teamId)
      break
    // captures and documents have nullable team_id — many records won't
    // have it set, so team scoping would silently exclude them. These
    // entities are better scoped via project_id or workspace_id.
  }
}

// ============================================================
// Ordering
// ============================================================

/**
 * `entityType` is optional only so the two in-repo callers could be migrated
 * without a flag day; pass it. Without it, a saved view ordering on a VIRTUAL
 * field (flow / prospect_list `last_run_status`, prospect_list
 * `last_run_kind`) reaches PostgREST as `order=last_run_status`, which is a
 * 400 — the column is on an embedded resource, not the queried table. The sort
 * picker already leaves virtual fields out (FilterFieldDefinition.virtual), so
 * this is the belt for the braces: a view saved before the flag existed, or a
 * hand-written API call, degrades to "unordered" instead of failing the page.
 */
export function applyOrdering(
  query: ReturnType<typeof buildEntityQuery>,
  ordering: SortConfig[],
  entityType?: ViewEntityType,
  options?: { tieBreakOnId?: boolean; fieldTypes?: CustomFieldTypes },
) {
  const virtualFields = entityType
    ? new Set(FILTERABLE_FIELDS[entityType].filter((f) => f.virtual).map((f) => f.field))
    : null
  for (const sort of ordering) {
    if (virtualFields?.has(sort.field)) {
      console.warn(`[views/query] ignoring sort on virtual field "${sort.field}" (${entityType})`)
      continue
    }
    if (isDroppedField(entityType, sort.field)) {
      console.warn(`[views/query] ignoring sort on dropped field "${sort.field}" (${entityType})`)
      continue
    }
    // A custom field sorts through `->` (jsonb): numbers as numbers, days and
    // text as text, records without the field last.
    if (isCustomFieldPath(sort.field)) {
      const key = customFieldKeyOf(sort.field)
      if (!key || !entityType || !viewTakesCustomFields(entityType)) {
        console.warn(`[views/query] ignoring sort on custom field "${sort.field}" (${entityType})`)
        continue
      }
      // A currency by its amount. A person, a relation and a multi-select
      // hold ids and lists, which order as nothing a reader would recognise.
      // A currency by its code, then its amount: amounts order only within one code.
      const type = options?.fieldTypes?.get(key)?.type
      if (type === 'person' || type === 'relation' || type === 'multi_select') continue
      if (type === 'currency') {
        query.order(`custom_fields->${key}->currency`, { ascending: true, nullsFirst: false })
        query.order(`custom_fields->${key}->amount`, { ascending: sort.direction === 'asc', nullsFirst: false })
        continue
      }
      query.order(`custom_fields->${key}`, { ascending: sort.direction === 'asc', nullsFirst: false })
      continue
    }
    query.order(sort.field, { ascending: sort.direction === 'asc', nullsFirst: false })
  }
  // Personal scope breaks the uniqueness that paging quietly leans on:
  // `identifier` is unique per (workspace_id, identifier) (migration 022), so
  // across workspaces two rows can both be ENG-1 and a sort on it is no longer
  // a total order. Postgres is then free to order the tied rows differently per
  // statement, and offset pagination shows one row twice while skipping
  // another. `id` is unique everywhere, so appending it makes ANY ordering
  // total — for `identifier` and for every other non-unique sort key.
  // Off by default: a single-workspace query must emit the ordering it always
  // did, and there its sort keys are workspace-unique already.
  if (options?.tieBreakOnId && !ordering.some((sort) => sort.field === 'id')) {
    query.order('id', { ascending: true, nullsFirst: false })
  }
}

// ============================================================
// Pagination
// ============================================================

export function applyPagination(
  query: ReturnType<typeof buildEntityQuery>,
  page: number,
  perPage: number,
) {
  query.range((page - 1) * perPage, page * perPage - 1)
}

// ============================================================
// Search
// ============================================================

export function applySearch(
  query: ReturnType<typeof buildEntityQuery>,
  entityType: ViewEntityType,
  search: string,
) {
  const term = search.trim()
  if (!term) return
  switch (entityType) {
    case 'contact': {
      // `.or()` parses its string as a filter tree: strip `,()"` so the user's
      // text cannot end the condition (a "Smith, John" search was a 400).
      const safe = toIlikeSearchTerm(term)
      if (safe) query.or(`full_name.ilike.%${safe}%,email.ilike.%${safe}%`)
      break
    }
    case 'company':
      query.ilike('name', `%${term}%`)
      break
    case 'capture':
    case 'document':
    case 'action':
      query.ilike('title', `%${term}%`)
      break
    case 'flow':
    case 'sequence':
    case 'eval_suite':
      query.ilike('name', `%${term}%`)
      break

    case 'eval_case':
      query.ilike('name', `%${term}%`)
      break

    case 'eval_run':
      // A RUN HAS NO NAME. Its identity in the UI is composed
      // ("Batch run · Sep 8, 3:38 PM") from mode + started_at, and neither is
      // a text column a substring search can reach. `target_prompt_hash` is
      // the one text column that identifies a run in a way someone would
      // actually type — it is what the compare view and the run detail both
      // print, so pasting a hash prefix from either finds its runs. Anchored
      // as a PREFIX (no leading %) because a hash's tail is not a thing anyone
      // holds in their hand.
      query.ilike('target_prompt_hash', `${term}%`)
      break

    case 'prospect_list': {
      // Name AND description: a list's description is the prose ICP seed the
      // user typed ("seed-stage fintech founders in EMEA"), so it is the half
      // of the row they are most likely to remember and search by. Same
      // `.or()` hazard as contact: strip the filter-syntax characters.
      const safe = toIlikeSearchTerm(term)
      if (safe) query.or(`name.ilike.%${safe}%,description.ilike.%${safe}%`)
      break
    }

    case 'claim':
      // A claim IS its text — long-form prose, often a paragraph — so search
      // goes through the generated `fts` tsvector and its GIN index (migration
      // 109:29,36) rather than `ilike '%term%'`, which cannot use an index and
      // would seq-scan every active claim in the workspace on each keystroke.
      // `websearch` is the query grammar a person already types: bare words are
      // ANDed, "quoted phrases" stay phrases, and a stray operator is treated
      // as text instead of raising 42601 mid-typing.
      query.textSearch('fts', term, { type: 'websearch' })
      break

    case 'prospect_list_entry':
      // The candidate's name and domain live inside the `candidate` jsonb, so
      // there is no plain text column to ilike. `candidate_key` IS the
      // normalized identity (a domain for companies, a linkedin slug / email /
      // name@domain for people) and is a real indexed text column — searching
      // it hits the same substrings a user types without a jsonb path scan.
      query.ilike('candidate_key', `%${term.toLowerCase()}%`)
      break
  }
}

// ============================================================
// Grouping (client-side)
// ============================================================

/**
 * Canonical order + display labels for workflow categories. Used by the
 * CROSS-TEAM (multi-team) board, which groups by category alone rather than
 * by `category::name` — because two teams' "Todo" states are distinct rows
 * that only share a category. Modelled on Linear, whose cross-team boards
 * show one column per workflow-state type. The fixed order makes column
 * ordering deterministic, eliminating the flip caused by tied per-team
 * sort_orders.
 */
export const CATEGORY_ORDER: Record<string, number> = {
  backlog: 0,
  unstarted: 1,
  started: 2,
  completed: 3,
  canceled: 4,
}
export const CATEGORY_LABELS: Record<string, string> = {
  backlog: 'Backlog',
  unstarted: 'Todo',
  started: 'In Progress',
  completed: 'Done',
  canceled: 'Canceled',
}

/**
 * Canonical column order + labels for the sequence lifecycle board (grouped by
 * `status`). Shared by the views/query empty-column injection so every status
 * column is always visible, in lifecycle order, whether or not it has rows —
 * mirrors CATEGORY_ORDER/CATEGORY_LABELS for the action board.
 */
export const SEQUENCE_STATUS_ORDER: Record<string, number> = {
  draft: 0,
  active: 1,
  paused: 2,
  archived: 3,
}
export const SEQUENCE_STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  active: 'Active',
  paused: 'Paused',
  archived: 'Archived',
}

// Which status→status moves a bare PATCH may perform (draft→active only via
// launch, archived terminal, …). The value lives in @/lib/sequences/types so
// client components (the board's drag guard) can import it without pulling in
// this server-side module — same arrangement as NO_MATCH_FILTER_VALUE above.
export { SEQUENCE_ALLOWED_TRANSITIONS } from '@/lib/sequences/types'

/**
 * Canonical column order + labels for the eval-suite outcome board (grouped by
 * `last_outcome`). Same job as SEQUENCE_STATUS_ORDER: the views/query route
 * injects an empty column for every outcome so the whole verdict vocabulary is
 * visible whether or not a suite currently sits in it.
 *
 * Best → worst, with `errored` last because it is a HARNESS failure rather
 * than a worse grade — the same distinction OutcomeChip draws by rendering it
 * grey instead of red. Suites with no settled run land in the `__none__`
 * column the grouper already produces, which sorts to the end.
 *
 * The labels are duplicated from evals/ui-helpers OUTCOME_LABELS rather than
 * imported: this module is server-side and the Evals UI helpers are a client
 * bundle. The registration test asserts the two agree.
 */
export const EVAL_OUTCOME_ORDER: Record<string, number> = {
  passed: 0,
  scored: 1,
  failed: 2,
  errored: 3,
}
export const EVAL_OUTCOME_LABELS: Record<string, string> = {
  passed: 'Passed',
  scored: 'Scored',
  failed: 'Failed',
  errored: 'Errored',
}

export function groupResults(
  data: Record<string, unknown>[],
  grouping: GroupConfig,
  subGrouping?: GroupConfig | null,
  // When true and grouping by status_id, columns are keyed by category alone
  // (one column per category) instead of `category::name`. Set for the
  // cross-team board where states from multiple teams must collapse cleanly.
  mergeByCategory = false,
): GroupedResults[] {
  const groups: Map<string, GroupedResults> = new Map()
  // Track sort_order for status_id grouping
  const groupSortOrder: Map<string, number> = new Map()
  // Track whether status grouping is keyed by category alone (cross-team).
  let categoryKeyed = false

  for (const item of data) {
    let key = getGroupKey(item, grouping.field)
    let label = getGroupLabel(item, grouping.field, key)

    // For status_id, merge groups across teams. Cross-team boards merge by
    // category alone (one column per category); single-team boards merge by
    // name+category so distinct custom statuses stay separate.
    if (grouping.field === 'status_id' && item.workflow_state) {
      const ws = item.workflow_state as { name?: string; category?: string; sort_order?: number }
      if (mergeByCategory && ws.category) {
        categoryKeyed = true
        key = ws.category
        label = CATEGORY_LABELS[ws.category] ?? ws.category
      } else if (ws.name && ws.category) {
        key = `${ws.category}::${ws.name}`
      }
      if (ws.sort_order !== undefined && !groupSortOrder.has(key)) {
        groupSortOrder.set(key, ws.sort_order)
      }
    }

    if (!groups.has(key)) {
      groups.set(key, { key, label, items: [] })
    }
    groups.get(key)!.items.push(item)
  }

  const hasSortOrder = groupSortOrder.size > 0
  const isDateGroup = isDateGroupField(grouping.field)
  const sortedGroups = Array.from(groups.values()).sort((a, b) => {
    if (a.key === '__none__') return 1
    if (b.key === '__none__') return -1
    // Cross-team status board: fixed canonical category order, deterministic.
    if (categoryKeyed) {
      const orderA = CATEGORY_ORDER[a.key] ?? 999
      const orderB = CATEGORY_ORDER[b.key] ?? 999
      return grouping.direction === 'asc' ? orderA - orderB : orderB - orderA
    }
    // Use workflow sort_order when available (status_id grouping)
    if (hasSortOrder) {
      const orderA = groupSortOrder.get(a.key) ?? 999
      const orderB = groupSortOrder.get(b.key) ?? 999
      return grouping.direction === 'asc' ? orderA - orderB : orderB - orderA
    }
    // Date groups: sort by YYYY-MM-DD key (lexicographic = chronological)
    if (isDateGroup) {
      return grouping.direction === 'asc' ? a.key.localeCompare(b.key) : b.key.localeCompare(a.key)
    }
    if (grouping.direction === 'asc') return a.label.localeCompare(b.label)
    return b.label.localeCompare(a.label)
  })

  if (subGrouping) {
    for (const group of sortedGroups) {
      group.subGroups = groupResults(group.items, subGrouping, null, mergeByCategory)
      group.items = []
    }
  }

  return sortedGroups
}

/**
 * The types of the custom fields a view's filters and sorts name, read from
 * the kind's definitions (one read, under the caller's RLS), or undefined
 * when it names none. A table's rows take their own table's live columns
 * (`tableId`); without one there are none to read.
 */
export async function customFieldTypesFor(
  supabase: SupabaseClient,
  workspaceId: string,
  entityType: ViewEntityType,
  fields: readonly string[],
  tableId?: string | null,
): Promise<CustomFieldTypes | undefined> {
  if (!viewTakesCustomFields(entityType)) return undefined
  if (entityType === 'data_row' && !tableId) return undefined
  const keys = [...new Set(fields.map((f) => customFieldKeyOf(f)).filter((k): k is string => !!k))]
  if (!keys.length) return undefined
  let q = supabase
    .from('custom_field_definition')
    .select('key, field_type, config')
    .eq('workspace_id', workspaceId)
    .eq('entity_type', entityType)
  q = entityType === 'data_row' ? q.eq('table_id', tableId as string).is('deleted_at', null) : q.is('table_id', null)
  const { data, error } = await q
    .in('key', keys)
  if (error || !data) return undefined
  return fieldShapes(data as Array<{ key: string; field_type: CustomFieldType; config?: { currency?: string } | null }>)
}

/** Definitions (a kind's, or a table's columns) as the shapes a filter reads. */
export function fieldShapes(defs: ReadonlyArray<{ key: string; field_type: CustomFieldType; config?: { currency?: string } | null }>): CustomFieldTypes {
  return new Map(
    defs.map((d) => [d.key, d.field_type === 'currency' ? { type: d.field_type, currency: d.config?.currency || DEFAULT_CURRENCY } : { type: d.field_type }]),
  )
}

/** Every field a view's filters and sorts name. */
export function viewFieldsOf(filters: readonly ViewFilter[] | null | undefined, ordering: readonly SortConfig[] | null | undefined): string[] {
  return [...(filters ?? []).map((f) => f.field), ...(ordering ?? []).map((s) => s.field)]
}

/**
 * Groups by a custom SELECT field (`custom_fields.<key>`) laid out by its
 * definition: a group per option in option order, empty ones included, "No
 * value" last (orderCustomSelectGroups). One read of the one definition,
 * under the caller's RLS. Anything else, or a definition that is not there
 * or not a select, leaves the groups as groupResults made them.
 */
export async function layoutCustomSelectGroups(
  supabase: SupabaseClient,
  workspaceId: string,
  entityType: ViewEntityType,
  grouping: GroupConfig,
  groups: GroupedResults[],
  /** A table's rows: the table whose column it is (every table has its own keys). */
  tableId?: string | null,
): Promise<GroupedResults[]> {
  const key = customFieldKeyOf(grouping.field)
  if (!key || !viewTakesCustomFields(entityType)) return groups
  if (entityType === 'data_row' && !tableId) return groups
  let q = supabase
    .from('custom_field_definition')
    .select('field_type, options')
    .eq('workspace_id', workspaceId)
    .eq('entity_type', entityType)
    .eq('key', key)
  if (entityType === 'data_row') q = q.eq('table_id', tableId as string).is('deleted_at', null)
  const { data, error } = await q.maybeSingle()
  if (error || !data || (data as { field_type?: string }).field_type !== 'select') return groups
  const options = Array.isArray((data as { options?: unknown }).options)
    ? ((data as { options: unknown[] }).options.filter((o): o is string => typeof o === 'string'))
    : []
  return orderCustomSelectGroups(groups, options, grouping.direction)
}

/** Date fields that should be grouped by calendar day instead of raw value */
const DATE_GROUP_FIELDS = new Set([
  'created_at', 'updated_at', 'due_at', 'started_at', 'ended_at',
  'scheduled_start', 'scheduled_end', 'recorded_at',
  'last_interaction_at', 'next_followup_at', 'last_message_at',
  'target_date', 'start_date', 'expected_close_date', 'closed_at',
])

function isDateGroupField(field: string): boolean {
  return DATE_GROUP_FIELDS.has(field)
}

/**
 * A bare `YYYY-MM-DD` (a `date` column: target_date, start_date) names a
 * calendar day, not an instant: read it as that local day. `new Date()` would
 * read it as UTC midnight, the previous day anywhere west of UTC.
 */
function parseGroupDate(dateStr: string): Date {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? parseISO(dateStr) : new Date(dateStr)
}

/** Returns a YYYY-MM-DD key for date grouping */
function getDateGroupKey(dateStr: string): string {
  const d = parseGroupDate(dateStr)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Returns a human-readable day label: "Today", "Yesterday", "Wed, Apr 2", "March 25", "March 25, 2024" */
function getDateGroupLabel(dateStr: string): string {
  const date = parseGroupDate(dateStr)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const diffDays = Math.floor((today.getTime() - dateOnly.getTime()) / 86400000)

  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays >= 2 && diffDays < 7) {
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
  }
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

function getGroupKey(item: Record<string, unknown>, field: string): string {
  // Flow synthetic group fields read from nested jsonb / embedded resources.
  if (field === 'trigger_entity_type') {
    const cfg = item.trigger_config as { entity_type?: string } | null
    return cfg?.entity_type || 'action'
  }
  if (field === 'last_run_status') {
    // Flow embeds `flow_run`, prospect_list embeds `prospecting_run`; both
    // limit the embed to the newest single row, so index 0 IS the last run.
    // Keyed off which embed the item actually carries rather than off
    // entityType, which getGroupKey is not given.
    const runs = (item.flow_run ?? item.prospecting_run) as Array<{ status?: string }> | null | undefined
    return runs && runs.length > 0 ? String(runs[0].status ?? '__none__') : '__none__'
  }
  if (field === 'last_run_kind') {
    const runs = item.prospecting_run as Array<{ kind?: string }> | null | undefined
    return runs && runs.length > 0 ? String(runs[0].kind ?? '__none__') : '__none__'
  }
  const value = getNestedValue(item, field)
  if (value === null || value === undefined) return '__none__'
  if (isDateGroupField(field) && typeof value === 'string') {
    return getDateGroupKey(value)
  }
  return String(value)
}

const FLOW_ENTITY_TYPE_LABELS: Record<string, string> = {
  action: 'Action',
  project: 'Project',
  initiative: 'Initiative',
  milestone: 'Milestone',
}

const FLOW_RUN_STATUS_LABELS: Record<string, string> = {
  success: 'Succeeded',
  failed: 'Failed',
  pending: 'Pending',
}

/**
 * `prospecting_run.status`, in the run's own words. Shares the
 * `last_run_status` group field with flow — the two vocabularies are disjoint
 * (flow: success/failed/pending; prospecting: the AgentRunStatus set plus
 * budget_exhausted), so one merged lookup would be ambiguous. They are kept
 * separate and consulted in order, flow first, matching getGroupKey's
 * embed-shaped dispatch.
 */
const PROSPECTING_RUN_STATUS_LABELS: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  needs_input: 'Needs input',
  canceling: 'Canceling',
  completed: 'Completed',
  failed: 'Failed',
  canceled: 'Canceled',
  // An OUTCOME, not a failure (§9): the run kept every partial result.
  budget_exhausted: 'Hit cap',
}

const PROSPECTING_RUN_KIND_LABELS: Record<string, string> = {
  discover: 'Discovery',
  account_card: 'Account research',
  people: 'People',
}

/**
 * `prospect_list.purpose` — the default board grouping, so these ARE the
 * column headers. In lockstep with PROSPECT_PURPOSE_LABELS in
 * @/lib/prospecting/types (pinned by prospect-list-view-registration.test.ts);
 * spelled as a literal here for the same reason FILTERABLE_FIELDS spells its
 * option arrays as literals — one label map, two vocabularies, no import of a
 * server-shaped module into a file the whole views system loads.
 *
 * Note 'buyers' → "Customers": the column says who they are to you, not what
 * the seed field is called.
 */
const PROSPECT_PURPOSE_GROUP_LABELS: Record<string, string> = {
  buyers: 'Customers',
  investors: 'Investors',
  partners: 'Partners',
  talent: 'Talent',
  custom: 'Custom',
}

const PROSPECT_LIST_STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  archived: 'Archived',
}

function getGroupLabel(item: Record<string, unknown>, field: string, key: string): string {
  // Flow grouping labels (enabled → Active/Paused, trigger → entity name, etc.)
  if (field === 'enabled') return key === 'true' ? 'Active' : 'Paused'
  if (field === 'trigger_entity_type') return FLOW_ENTITY_TYPE_LABELS[key] ?? key
  if (field === 'last_run_status') {
    if (key === '__none__') return 'Never run'
    return FLOW_RUN_STATUS_LABELS[key] ?? PROSPECTING_RUN_STATUS_LABELS[key] ?? key
  }
  if (field === 'last_run_kind') {
    return key === '__none__' ? 'Never run' : (PROSPECTING_RUN_KIND_LABELS[key] ?? key)
  }
  // `purpose` is prospect_list's default board grouping and is unique to it,
  // so no entity dispatch is needed. `status` IS shared (project/initiative/
  // capture/document/sequence all group by it), so it is looked up last and
  // only for keys nothing else claimed — the two prospect values are not in
  // any other entity's status vocabulary.
  if (field === 'purpose') return PROSPECT_PURPOSE_GROUP_LABELS[key] ?? key

  if (key === '__none__') {
    // An eval suite with no settled run has never been graded — "No value"
    // would read as a missing field rather than a suite nobody has run.
    if (field === 'last_outcome') return 'Never run'
    if (field === 'last_run_mode') return 'Never run'
    if (field === 'project_id') return 'No project'
    if (field === 'team_id') return 'No team'
    if (field === 'assignee_id') return 'Unassigned'
    if (field === 'milestone_id') return 'No milestone'
    if (field === 'initiative_id') return 'No initiative'
    return 'No value'
  }

  // Date fields: convert YYYY-MM-DD key to human-readable label
  if (isDateGroupField(field)) {
    const value = getNestedValue(item, field)
    if (typeof value === 'string') return getDateGroupLabel(value)
    return key
  }

  // For joined fields, try to get the display name
  if (field === 'status_id') {
    const ws = item.workflow_state as { name?: string } | null
    return ws?.name || key
  }
  if (field === 'owner_id') {
    const owner = item.owner as { display_name?: string } | null
    return owner?.display_name || key
  }
  if (field === 'assignee_id') {
    const assignee = item.assignee as { display_name?: string } | null
    return assignee?.display_name || key
  }
  if (field === 'project_id') {
    const project = item.project as { name?: string } | null
    return project?.name || key
  }
  if (field === 'team_id') {
    const team = item.team as { name?: string } | null
    return team?.name || key
  }
  // Joined on every action row (ACTION_VIEW_SELECT's `milestone`): a group by
  // milestone reads its name, not its id (the Tasks sub-nav's Milestones).
  if (field === 'milestone_id') {
    const milestone = item.milestone as { name?: string } | null
    return milestone?.name || key
  }
  if (field === 'company_id') {
    const company = item.company as { name?: string } | null
    return company?.name || key
  }
  if (field === 'status' && key in PROSPECT_LIST_STATUS_LABELS && 'purpose' in item) {
    return PROSPECT_LIST_STATUS_LABELS[key]
  }
  return key
}

function getNestedValue(item: Record<string, unknown>, field: string): unknown {
  if (field.includes('.')) {
    const parts = field.split('.')
    let current: unknown = item
    for (const part of parts) {
      if (current === null || current === undefined) return null
      current = (current as Record<string, unknown>)[part]
    }
    return current
  }
  return item[field]
}

// ============================================================
// Full View Execution
// ============================================================

export async function executeView(
  supabase: SupabaseClient,
  view: View,
  userId: string,
  params: { page?: number; per_page?: number; override_filters?: ViewFilter[]; queryOptions?: QueryOptions } = {},
) {
  const page = params.page ?? 1
  const perPage = params.per_page ?? 50

  // Build base query
  const query = buildEntityQuery(supabase, view.entity_type, view.workspace_id, userId, params.queryOptions)
  // A table's rows are its one table's: a view that names none shows none.
  const tableId = view.entity_type === 'data_row' && view.scope_type === 'data_table' ? view.scope_id : null
  if (view.entity_type === 'data_row') {
    if (!tableId) {
      return { data: [], total: 0, page, per_page: perPage, view: { id: view.id, name: view.name, entity_type: view.entity_type, layout: view.layout, display_properties: view.display_properties || [], grouping: view.grouping, sub_grouping: view.sub_grouping } }
    }
    query.eq('table_id', tableId)
  }

  // Resolve member ID for @me filter support
  let memberId: string | undefined
  if (view.entity_type === 'action') {
    const { data: member } = await supabase
      .from('member')
      .select('id')
      .eq('user_id', userId)
      .eq('workspace_id', view.workspace_id)
      .single()
    memberId = member?.id
  }

  // View metadata is identical whether the result is empty or populated, so
  // build it once and reuse it for both the normal and short-circuit paths.
  const viewMeta = {
    id: view.id,
    name: view.name,
    entity_type: view.entity_type,
    layout: view.layout,
    display_properties: view.display_properties || DEFAULT_DISPLAY_PROPERTIES[view.entity_type],
    grouping: view.grouping,
    sub_grouping: view.sub_grouping,
  }

  // Apply filters. A filter that provably matches nothing (e.g. a label mapping
  // to zero rows) throws NoMatchSignal — we return the normal empty success
  // shape WITHOUT hitting the DB, mirroring a genuinely-empty result. Grouping
  // an empty array flows through groupResults naturally (empty groups list).
  const allFilters = [...(view.filters || []), ...(params.override_filters || [])]
  const fieldTypes = await customFieldTypesFor(supabase, view.workspace_id, view.entity_type, viewFieldsOf(allFilters, view.ordering), tableId)
  try {
    await applyFilters(query, view.entity_type, allFilters, supabase, view.workspace_id, {
      memberId,
      userId,
    }, { fieldTypes })
  } catch (err) {
    if (err instanceof NoMatchSignal) {
      const emptyGrouped = view.grouping
        ? groupResults([], view.grouping, view.sub_grouping && view.sub_grouping.field ? view.sub_grouping : null)
        : null
      return {
        data: emptyGrouped || [],
        total: 0,
        page,
        per_page: perPage,
        view: viewMeta,
      }
    }
    throw err
  }

  // Filter-dependent per-entity defaults (archived prospect lists stay hidden
  // unless the view filters on status). MUST run after applyFilters.
  applyEntityDefaults(query, view.entity_type, allFilters)

  // Action-specific completed filter
  if (view.entity_type === 'action') {
    await applyCompletedFilter(
      supabase,
      query,
      view.completed_filter || 'all',
      view.show_completed,
      view.workspace_id,
    )
  }

  // Team scope
  if (view.team_id) {
    applyTeamScope(query, view.entity_type, view.team_id)
  }

  // Ordering
  applyOrdering(query, view.ordering || defaultOrdering(view.entity_type), view.entity_type, { fieldTypes })

  // Pagination
  applyPagination(query, page, perPage)

  const { data, count, error } = await query

  if (error) throw error

  let items = (data || []) as Record<string, unknown>[]
  // Another member's mail or chat loop shows without its sender filter or channel.
  if (view.entity_type === 'flow') items = items.map((row) => flowRowForViewer(row, userId))

  // Enrich items with project names when not already joined (e.g. captures)
  const firstItem = items.length > 0 ? items[0] : null
  if (firstItem && 'project_id' in firstItem
    && !(firstItem.project && typeof firstItem.project === 'object' && 'name' in (firstItem.project as Record<string, unknown>))) {
    const projectIds = [...new Set(items.map(i => i.project_id).filter(Boolean))] as string[]
    if (projectIds.length > 0) {
      // A grouped board reads up to 500 rows: chunk the ids out of one URL.
      const { data: projects } = await inChunks(projectIds, 100, (ids) =>
        supabase.from('projects').select('id, name').in('id', ids),
      )
      const projectMap = new Map((projects || []).map(p => [p.id, p.name]))
      items = items.map(item => {
        if (!item.project_id) return { ...item, project: null }
        const projName = projectMap.get(item.project_id as string)
        const displayName = projName === '__default__' ? 'General' : (projName || null)
        return { ...item, project: { id: item.project_id, name: displayName } }
      })
    }
  }

  // Group if configured
  let grouped: GroupedResults[] | null = null
  if (view.grouping) {
    const validSubGrouping = view.sub_grouping && view.sub_grouping.field ? view.sub_grouping : null
    grouped = groupResults(items, view.grouping, validSubGrouping)
    grouped = await layoutCustomSelectGroups(supabase, view.workspace_id, view.entity_type, view.grouping, grouped, tableId)
  }

  return {
    data: grouped || items,
    total: count ?? 0,
    page,
    per_page: perPage,
    view: viewMeta,
  }
}
