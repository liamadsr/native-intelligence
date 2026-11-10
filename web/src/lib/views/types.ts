// ============================================================
// View System Types
// ============================================================

import type { EntityTypeSubset } from '@/lib/knowledge/entity-registry'

/**
 * Sentinel filter value meaning "match nothing". Lives here (not in
 * query-engine) so client components can import it without pulling in the
 * server-side query builder. When a filter resolves to a guaranteed no-match
 * — e.g. a contact with zero captures, or a label/status-category that maps to
 * zero rows — this value is used as a signal, NOT as a literal DB value. It
 * must never reach Postgres: `id`/`status_id` are uuid columns and comparing
 * them against this string raises 22P02 (invalid input syntax for type uuid)
 * instead of yielding zero rows. The query engine short-circuits above the
 * query builder when it sees it. `query-engine` re-exports this symbol.
 */
export const NO_MATCH_FILTER_VALUE = '__no_match__'

/**
 * Most ids one POST /api/account/bulk request accepts. The route refuses more,
 * so `useBulkActions` sends a larger selection as consecutive chunks of this
 * size — a select-all on a grouped view can hold several hundred rows.
 */
export const BULK_MAX_IDS = 100

/**
 * Registered entity kinds a view can list, plus two view-only names, 'agent'
 * and 'skill' (recipes, listed as two libraries). Mail is `email_thread`, the
 * same name as everywhere else (migration 503).
 */
export type ViewEntityType =
  | EntityTypeSubset<
      | 'action'
      | 'capture'
      | 'contact'
      | 'company'
      | 'document'
      | 'initiative'
      | 'project'
      | 'flow'
      | 'sequence'
      | 'prospect_list'
      | 'prospect_list_entry'
      | 'eval_suite'
      | 'eval_case'
      | 'eval_run'
      | 'claim'
      | 'deal'
      | 'email_thread'
    >
  | 'agent'
  | 'skill'
export type LibraryScope = 'all' | 'mine' | 'workspace' | 'discover'
/**
 * How a view is drawn. `graph` is the knowledge map — a WebGL canvas of claims
 * clustered around the captures, documents and projects they came from — and is
 * only meaningful for `claim`. It is a LAYOUT rather than a separate page mode
 * so that one saved view ("open questions, last 30 days") can be read as a
 * canvas, a list or a board without rebuilding its filters. See migration 275.
 */
export type ViewLayout = 'list' | 'board' | 'graph'
export type ViewVisibility = 'personal' | 'team' | 'workspace'
export type CrmScope = 'contacts' | 'internal' | 'external' | 'companies'

// ============================================================
// Filter Types
// ============================================================

export type FilterOperator =
  | 'is'
  | 'is_not'
  | 'is_any_of'
  | 'is_none_of'
  | 'contains'
  | 'does_not_contain'
  | 'starts_with'
  | 'ends_with'
  | 'is_empty'
  | 'is_not_empty'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'is_relative'
  | 'includes'
  | 'excludes'
  | 'equals'

export interface RelativeDateValue {
  unit: 'day' | 'week' | 'month' | 'quarter' | 'year'
  direction: 'past' | 'future' | 'this'
  count?: number
}

export interface RangeValue {
  from: string | number
  to: string | number
}

export type FilterValue = string | number | boolean | string[] | RelativeDateValue | RangeValue

/**
 * Is a filter's value "not set yet"?
 *
 * A chip exists from the moment the user picks a field, before they have typed
 * anything — so `{field:'confidence', operator:'gte', value:''}` is a normal,
 * transient state, not a malformed filter.
 *
 * BOTH query engines must agree on what it means, and this is the definition
 * they share. When they disagreed, an untouched Confidence chip applied
 * `confidence >= 0` to the knowledge map (because `Number('')` is 0) while the
 * SQL list skipped it entirely — so one saved view drew a canvas of only
 * SCORED claims beside a list that included the un-scored ones, with no error
 * and no visible difference in the chrome.
 *
 * `is_empty` / `is_not_empty` are excluded by the caller: those operators carry
 * no value and mean something precise without one.
 */
export function isUnsetFilterValue(value: unknown): boolean {
  if (value === '' || value === null || value === undefined) return true
  if (Array.isArray(value) && value.length === 0) return true
  return false
}

export interface ViewFilter {
  id: string
  field: string
  operator: FilterOperator
  value: FilterValue
  conjunction?: 'and' | 'or'
}

// ============================================================
// Sort & Group Config
// ============================================================

export interface SortConfig {
  field: string
  direction: 'asc' | 'desc'
}

export interface GroupConfig {
  field: string
  direction: 'asc' | 'desc'
}

// ============================================================
// View Model (matches DB)
// ============================================================

export interface View {
  id: string
  workspace_id: string
  team_id: string | null
  created_by: string

  name: string
  description: string | null
  icon: string | null
  color: string | null
  slug: string | null

  entity_type: ViewEntityType
  visibility: ViewVisibility
  layout: ViewLayout

  filters: ViewFilter[]
  grouping: GroupConfig | null
  sub_grouping: GroupConfig | null
  ordering: SortConfig[]
  display_properties: string[]

  board_group_by: string | null

  show_completed: boolean
  completed_filter: 'all' | 'recent' | 'none'

  show_sub_items: boolean
  nested_sub_items: boolean
  show_empty_groups: boolean

  is_pinned: boolean
  pin_order: number

  /** Parent entity this view is bound to. Null for global views. */
  /** Must stay in sync with ViewScope['type'] and view_scope_type_check (mig 250). */
  scope_type: ViewScope['type'] | null
  scope_id: string | null

  metadata: Record<string, unknown>
  created_at: string
  updated_at: string

  // Joined fields (optional)
  is_favorited?: boolean
}

/**
 * Identifies a parent entity that a view is scoped to. Scoped views are
 * persisted separately so "Project A → Actions" views don't appear in
 * "Project B → Actions" or in the global "My Actions" tab.
 */
export interface ViewScope {
  // 'prospect_list' scopes the entries view to ONE list: the list detail page
  // embeds <UnifiedViewLayout entityType="prospect_list_entry"> with a fixed
  // `list_id` scopeFilter, and saved views made there must not leak into the
  // next list's picker.
  // 'eval_suite' scopes the CASES and RUNS views to ONE suite: the suite
  // detail page embeds <UnifiedViewLayout entityType="eval_case"> and
  // entityType="eval_run" with a fixed `suite_id` scopeFilter, exactly as a
  // project's Actions tab embeds a scoped actions view. Saved views made
  // inside one suite must not appear in the next suite's picker.
  type: 'project' | 'initiative' | 'contact' | 'company' | 'prospect_list' | 'eval_suite'
  id: string
}

/**
 * How many WORKSPACES a query spans.
 *
 *  - 'workspace' (the default, and every pre-existing caller): the active
 *    workspace alone — the query is `workspace_id = <active>`.
 *  - 'all': PERSONAL SCOPE — every workspace the user is a member of, resolved
 *    SERVER-side from the `member` table (see `resolveMemberIdsForUser`). The
 *    client asks for the scope; it never names the workspaces.
 *
 * Orthogonal to both `ViewScope` above (which parent ENTITY a saved view hangs
 * off) and to `action_scope` ('assigned' | 'created' | 'all' — which of the
 * user's actions, within whatever workspaces are in scope). "All" means a
 * different thing in each: here it is workspaces, there it is people.
 */
export type WorkspaceScope = 'workspace' | 'all'

export interface ViewFavorite {
  id: string
  user_id: string
  view_id: string
  sort_order: number
  created_at: string
}

// ============================================================
// Filter Field Definitions — used by the filter UI
// ============================================================

export type FilterFieldType =
  | 'enum'
  | 'member'
  | 'label'
  | 'tag'
  | 'date'
  | 'number'
  | 'text'
  | 'boolean'
  | 'project'
  | 'team'
  | 'cycle'
  | 'milestone'
  | 'initiative'
  | 'capture'
  | 'action'
  | 'contact'
  | 'company'
  | 'contact_email'
  | 'relation'
  /** A prospect list (migration 259): contacts and companies carry the ids of
   *  the lists they were published from, so the CRM can filter "everyone from
   *  US B2B SaaS Outbound Teams". An array column; picked by list name. */
  | 'prospect_list'

export interface FilterFieldDefinition {
  field: string
  label: string
  type: FilterFieldType
  options?: string[] | string // static options array or dynamic source name
  isArray?: boolean
  allowEmpty?: boolean
  /**
   * NOT a column on the entity's own table — the query engine resolves it
   * against an embedded resource (e.g. flow's `last_run_status` →
   * `flow_run.status`, a prospect list's `last_run_status` →
   * `prospecting_run.status`).
   *
   * Filterable and groupable; NOT sortable. PostgREST's `order` takes a column
   * of the queried table, so `.order('last_run_status')` is a 400 — the sort
   * picker reads this flag to leave virtual fields out, and `applyOrdering`
   * drops them defensively in case a saved view already carries one.
   */
  virtual?: boolean
}

// ============================================================
// Operators available per field type
// ============================================================

export const OPERATORS_BY_TYPE: Record<FilterFieldType, FilterOperator[]> = {
  enum: ['is', 'is_not', 'is_any_of', 'is_none_of'],
  member: ['is', 'is_not', 'is_any_of', 'is_none_of', 'is_empty', 'is_not_empty'],
  label: ['includes', 'excludes', 'equals', 'is_empty', 'is_not_empty'],
  tag: ['includes', 'excludes', 'is_empty', 'is_not_empty'],
  prospect_list: ['includes', 'excludes', 'is_empty', 'is_not_empty'],
  date: ['is', 'is_not', 'gt', 'gte', 'lt', 'lte', 'between', 'is_relative', 'is_empty', 'is_not_empty'],
  // `is_empty` / `is_not_empty` because a nullable number is a real state — a
  // match score that has not been computed yet is "no score", not zero.
  number: ['is', 'is_not', 'gt', 'gte', 'lt', 'lte', 'between', 'is_empty', 'is_not_empty'],
  text: ['is', 'is_not', 'contains', 'does_not_contain', 'starts_with', 'ends_with', 'is_empty', 'is_not_empty'],
  boolean: ['is'],
  project: ['is', 'is_not', 'is_any_of', 'is_none_of', 'is_empty', 'is_not_empty'],
  team: ['is', 'is_not', 'is_any_of', 'is_none_of'],
  cycle: ['is', 'is_not', 'is_any_of', 'is_none_of', 'is_empty', 'is_not_empty'],
  milestone: ['is', 'is_not', 'is_any_of', 'is_none_of', 'is_empty', 'is_not_empty'],
  initiative: ['is', 'is_not', 'is_any_of', 'is_none_of', 'is_empty', 'is_not_empty'],
  capture: ['is', 'is_not', 'is_empty', 'is_not_empty'],
  action: ['is', 'is_not', 'is_empty', 'is_not_empty'],
  contact: ['is', 'is_not', 'is_empty', 'is_not_empty'],
  company: ['is', 'is_not', 'is_any_of', 'is_none_of'],
  contact_email: ['is', 'is_any_of', 'contains'],
  relation: ['is_empty', 'is_not_empty'],
}

// ============================================================
// Operator display labels
// ============================================================

export const OPERATOR_LABELS: Record<FilterOperator, string> = {
  is: 'is',
  is_not: 'is not',
  is_any_of: 'is any of',
  is_none_of: 'is none of',
  contains: 'contains',
  does_not_contain: 'does not contain',
  starts_with: 'starts with',
  ends_with: 'ends with',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
  gt: 'after',
  gte: 'on or after',
  lt: 'before',
  lte: 'on or before',
  between: 'between',
  is_relative: 'in the',
  includes: 'includes',
  excludes: 'excludes',
  equals: 'is exactly',
}

/**
 * The comparison words a NUMBER uses. `gt`/`lt` are shared between dates and
 * numbers, and the shared labels above are the date ones — a match score
 * offered "after" and "on or before" read as a date field (Liam, 2026-09-06).
 */
const NUMBER_OPERATOR_LABELS: Partial<Record<FilterOperator, string>> = {
  gt: 'greater than',
  gte: 'at least',
  lt: 'less than',
  lte: 'at most',
  between: 'between',
  is_empty: 'has no value',
  is_not_empty: 'has a value',
}

/** The label for an operator ON A FIELD — the field's type decides whether
 *  `gt` means "after" or "greater than". Every chip and summary goes through
 *  this rather than reading `OPERATOR_LABELS` directly. */
export function operatorLabel(operator: FilterOperator, fieldType?: FilterFieldType): string {
  if (fieldType === 'number') return NUMBER_OPERATOR_LABELS[operator] ?? OPERATOR_LABELS[operator] ?? operator
  return OPERATOR_LABELS[operator] ?? operator
}

// ============================================================
// Filterable Fields Per Entity Type
// ============================================================

const LIBRARY_FILTER_FIELDS: FilterFieldDefinition[] = [
  { field: 'library_scope', label: 'Collection', type: 'enum', options: ['all', 'mine', 'workspace', 'discover'], virtual: true },
  { field: 'name', label: 'Name', type: 'text' },
  { field: 'description', label: 'Description', type: 'text' },
  { field: 'slug', label: 'Command', type: 'text' },
  { field: 'visibility', label: 'Visibility', type: 'enum', options: ['personal', 'workspace', 'public'] },
  { field: 'is_system', label: 'Built-in', type: 'boolean' },
]

export const FILTERABLE_FIELDS: Record<ViewEntityType, FilterFieldDefinition[]> = {
  agent: LIBRARY_FILTER_FIELDS,
  skill: LIBRARY_FILTER_FIELDS,
  action: [
    { field: 'status_id', label: 'Status', type: 'enum', options: 'workflow_states' },
    { field: 'status_type', label: 'Status type', type: 'enum', options: ['backlog', 'unstarted', 'started', 'completed', 'canceled'] },
    { field: 'assignee_id', label: 'Assignee', type: 'member', allowEmpty: true },
    { field: 'user_id', label: 'Creator', type: 'member' },
    { field: 'priority', label: 'Priority', type: 'enum', options: ['urgent', 'high', 'medium', 'low', 'none'] },
    { field: 'labels', label: 'Labels', type: 'label', isArray: true },
    { field: 'due_at', label: 'Due date', type: 'date' },
    { field: 'created_at', label: 'Created', type: 'date' },
    { field: 'updated_at', label: 'Updated', type: 'date' },
    { field: 'project_id', label: 'Project', type: 'project' },
    { field: 'milestone_id', label: 'Milestone', type: 'milestone' },
    { field: 'initiative_id', label: 'Initiative', type: 'initiative' },
    { field: 'cycle_id', label: 'Cycle', type: 'cycle' },
    { field: 'team_id', label: 'Team', type: 'team' },
    { field: 'source_capture_id', label: 'Source capture', type: 'capture', allowEmpty: true },
    { field: 'confirmation', label: 'Confirmation', type: 'enum', options: ['suggested', 'confirmed', 'dismissed'] },
    { field: 'parent_id', label: 'Parent action', type: 'action', allowEmpty: true },
    { field: 'title', label: 'Title', type: 'text' },
    { field: 'identifier', label: 'Identifier', type: 'text' },
  ],

  capture: [
    { field: 'status', label: 'Status', type: 'enum', options: ['active', 'archived'] },
    { field: 'auto_capture_status', label: 'Capture status', type: 'enum', options: ['pending', 'ready', 'recording', 'completed', 'skipped'] },
    { field: 'ai_processed', label: 'AI processed', type: 'boolean' },
    { field: 'labels', label: 'Labels', type: 'label', isArray: true },
    { field: 'user_id', label: 'Creator', type: 'member' },
    { field: 'team_id', label: 'Team', type: 'team' },
    { field: 'project_id', label: 'Project', type: 'project' },
    { field: 'started_at', label: 'Started', type: 'date' },
    { field: 'ended_at', label: 'Ended', type: 'date' },
    { field: 'scheduled_start', label: 'Scheduled start', type: 'date' },
    { field: 'created_at', label: 'Created', type: 'date' },
    { field: 'title', label: 'Title', type: 'text' },
    { field: 'calendar_provider', label: 'Calendar provider', type: 'enum', options: ['google', 'microsoft'] },
  ],

  contact: [
    // Mirrors contact_relationship_type_check (migration 266) — the DB list is
    // the source of truth; a value missing here is unselectable in the UI.
    { field: 'relationship_type', label: 'Relationship type', type: 'enum', options: ['contact', 'lead', 'customer', 'partner', 'vendor', 'internal', 'candidate'] },
    { field: 'relationship_strength', label: 'Relationship strength', type: 'enum', options: ['strong', 'warm', 'neutral', 'cold', 'stale'] },
    { field: 'company_id', label: 'Company', type: 'company' },
    { field: 'job_title', label: 'Job title', type: 'text' },
    { field: 'tags', label: 'Tags', type: 'tag', isArray: true },
    { field: 'prospect_list_ids', label: 'List', type: 'prospect_list', isArray: true },
    { field: 'source', label: 'Source', type: 'enum', options: ['manual', 'email_sync', 'calendar_sync', 'capture_participant', 'csv_import', 'prospecting'] },
    { field: 'last_interaction_at', label: 'Last interaction', type: 'date' },
    { field: 'interaction_count', label: 'Interaction count', type: 'number' },
    { field: 'next_followup_at', label: 'Next follow-up', type: 'date' },
    { field: 'created_at', label: 'Created', type: 'date' },
    { field: 'full_name', label: 'Name', type: 'text' },
    { field: 'email', label: 'Email', type: 'text' },
  ],

  // Deals (roadmap #8, migration 473). `stage_id` reads its options from the
  // workspace's pipelines (DynamicEnumPicker's 'deal_stages'); `contact_ids`
  // is an array column, filtered with `@>` like prospect_list_ids.
  deal: [
    { field: 'stage_id', label: 'Stage', type: 'enum', options: 'deal_stages' },
    // The board's pipeline: a fixed scope a pipeline's board sends (and the
    // views/query route reads to pick its columns). Kept out of
    // FIELD_CATEGORIES, like prospect_list_entry's `list_id`.
    { field: 'pipeline_id', label: 'Pipeline', type: 'text' },
    { field: 'owner_id', label: 'Owner', type: 'member', allowEmpty: true },
    { field: 'company_id', label: 'Company', type: 'company' },
    { field: 'contact_ids', label: 'Contact', type: 'contact', isArray: true },
    { field: 'value', label: 'Value', type: 'number', allowEmpty: true },
    { field: 'currency', label: 'Currency', type: 'text' },
    { field: 'expected_close_date', label: 'Expected close', type: 'date', allowEmpty: true },
    { field: 'closed_at', label: 'Closed', type: 'date', allowEmpty: true },
    { field: 'source', label: 'Source', type: 'enum', options: ['manual', 'agent', 'email', 'capture', 'sms', 'import'] },
    { field: 'created_at', label: 'Created', type: 'date' },
    { field: 'updated_at', label: 'Updated', type: 'date' },
    { field: 'name', label: 'Name', type: 'text' },
  ],

  company: [
    { field: 'industry', label: 'Industry', type: 'text' },
    { field: 'domain', label: 'Domain', type: 'text' },
    { field: 'employee_count_range', label: 'Employee count', type: 'enum', options: ['1-10', '11-50', '51-200', '201-500', '501-1000', '1000+'] },
    { field: 'tags', label: 'Tags', type: 'tag', isArray: true },
    { field: 'prospect_list_ids', label: 'List', type: 'prospect_list', isArray: true },
    { field: 'created_at', label: 'Created', type: 'date' },
    { field: 'name', label: 'Name', type: 'text' },
  ],

  email_thread: [
    { field: 'folder', label: 'Folder', type: 'enum', options: ['inbox', 'sent', 'drafts', 'starred', 'archive', 'spam', 'trash'] },
    { field: 'is_unread', label: 'Unread', type: 'boolean' },
    { field: 'is_starred', label: 'Starred', type: 'boolean' },
    { field: 'needs_reply', label: 'Needs reply', type: 'boolean' },
    { field: 'has_attachments', label: 'Has attachments', type: 'boolean' },
    { field: 'auto_classified', label: 'Classification', type: 'enum', options: ['newsletter', 'notification', 'personal', 'transactional', 'important'] },
    { field: 'labels', label: 'Labels', type: 'label', isArray: true },
    // No subject or display name: the index keeps ids, flags and addresses only (344).
    { field: 'from_email', label: 'From', type: 'text' },
    { field: 'linked_contact_id', label: 'Contact', type: 'contact' },
    { field: 'linked_capture_id', label: 'Linked capture', type: 'capture', allowEmpty: true },
    { field: 'linked_project_id', label: 'Linked project', type: 'project', allowEmpty: true },
    { field: 'message_count', label: 'Message count', type: 'number' },
    { field: 'last_message_at', label: 'Last message', type: 'date' },
    { field: 'created_at', label: 'Created', type: 'date' },
  ],

  document: [
    { field: 'created_by', label: 'Creator', type: 'member' },
    { field: 'project_id', label: 'Project', type: 'project', allowEmpty: true },
    { field: 'team_id', label: 'Team', type: 'team', allowEmpty: true },
    { field: 'is_pinned', label: 'Pinned', type: 'boolean' },
    { field: 'status', label: 'Status', type: 'enum', options: ['active', 'archived'] },
    // doc / report (a skill or loop report) / prep (a meeting prep), migration
    // 367. With no Kind filter a list shows docs only (applyEntityDefaults).
    { field: 'kind', label: 'Kind', type: 'enum', options: ['doc', 'report', 'prep'] },
    { field: 'title', label: 'Title', type: 'text' },
    { field: 'created_at', label: 'Created', type: 'date' },
    { field: 'updated_at', label: 'Updated', type: 'date' },
  ],

  initiative: [
    { field: 'status', label: 'Status', type: 'enum', options: ['planned', 'active', 'completed', 'archived'] },
    { field: 'owner_id', label: 'Owner', type: 'member', allowEmpty: true },
    { field: 'labels', label: 'Labels', type: 'label', isArray: true },
    { field: 'target_date', label: 'Target date', type: 'date' },
    { field: 'created_at', label: 'Created', type: 'date' },
    { field: 'updated_at', label: 'Updated', type: 'date' },
    { field: 'name', label: 'Name', type: 'text' },
  ],

  project: [
    { field: 'status', label: 'Status', type: 'enum', options: ['planned', 'active', 'paused', 'completed', 'canceled'] },
    { field: 'lead_id', label: 'Lead', type: 'member', allowEmpty: true },
    { field: 'initiative_id', label: 'Initiative', type: 'initiative', allowEmpty: true },
    { field: 'labels', label: 'Labels', type: 'label', isArray: true },
    { field: 'target_date', label: 'Target date', type: 'date' },
    { field: 'start_date', label: 'Start date', type: 'date' },
    { field: 'created_at', label: 'Created', type: 'date' },
    { field: 'updated_at', label: 'Updated', type: 'date' },
    { field: 'is_pinned', label: 'Pinned', type: 'boolean' },
    { field: 'is_archived', label: 'Archived', type: 'boolean' },
    { field: 'name', label: 'Name', type: 'text' },
  ],

  flow: [
    { field: 'enabled', label: 'Status', type: 'boolean' },
    { field: 'trigger_entity_type', label: 'Trigger', type: 'enum', options: ['action', 'project', 'initiative', 'milestone'] },
    { field: 'team_id', label: 'Team', type: 'team' },
    { field: 'last_run_status', label: 'Last run', type: 'enum', options: ['success', 'failed', 'pending'], allowEmpty: true, virtual: true },
    { field: 'created_at', label: 'Created', type: 'date' },
    { field: 'updated_at', label: 'Updated', type: 'date' },
    { field: 'name', label: 'Name', type: 'text' },
  ],

  sequence: [
    // NOTE: 'enrolled_contact_id' (sequences having an enrollment for one
    // contact) is deliberately NOT declared here. It is an internal scope
    // field the contact detail panel's embedded view sends as a fixed
    // scopeFilter — the query engine resolves it via a sequence_enrollment
    // subquery. Hidden from the filter picker the same way the id-based
    // contact scopes on the sibling Actions/Captures embeds are.
    // Mirrors the CHECK constraint on public.sequence (migration 227).
    { field: 'status', label: 'Status', type: 'enum', options: ['draft', 'active', 'paused', 'archived'] },
    // NO 'created_by' Creator filter, deliberately (same as flow): the shared
    // member picker emits `member.id`, but sequence.created_by (migration 227)
    // references auth.users(id) — a different UUID space — so an eq() filter
    // could never match a row and every selection would render an empty list.
    // Add it back only with member→user_id translation in the query route.
    { field: 'created_at', label: 'Created', type: 'date' },
    { field: 'updated_at', label: 'Updated', type: 'date' },
    { field: 'name', label: 'Name', type: 'text' },
  ],

  // Mirrors the CHECK constraints on public.prospect_list (migration 248) and,
  // for the two virtual last-run fields, on public.prospecting_run. Same
  // literal-array discipline as prospect_list_entry below: this file is loaded
  // by client components, so it must not import the server-shaped prospecting
  // module — __tests__/prospect-list-view-registration.test.ts pins the option
  // arrays against BOTH the consts and the migration text instead.
  prospect_list: [
    { field: 'purpose', label: 'Purpose', type: 'enum', options: ['buyers', 'investors', 'partners', 'talent', 'custom'] },
    // NOT allowEmpty: `status` is NOT NULL with a default in 248, so an empty
    // option would name a state no row can be in. It is also the field that
    // reveals archived lists — the query engine hides them by default, and
    // filtering `status is archived` is how you get them back.
    { field: 'status', label: 'Status', type: 'enum', options: ['active', 'archived'] },
    { field: 'exclude_contacted', label: 'Excludes contacted', type: 'enum', options: ['off', 'active', 'ever'] },
    // VIRTUAL, both of them: resolved against the embedded newest
    // `prospecting_run` (applyFilters maps them to `prospecting_run.status` /
    // `prospecting_run.kind`), exactly the way flow's last_run_status is.
    // Filterable and groupable, never sortable — see `virtual` on
    // FilterFieldDefinition.
    { field: 'last_run_status', label: 'Last run', type: 'enum', options: ['queued', 'running', 'needs_input', 'canceling', 'completed', 'failed', 'canceled', 'budget_exhausted'], allowEmpty: true, virtual: true },
    { field: 'last_run_kind', label: 'Last run kind', type: 'enum', options: ['discover', 'account_card', 'people'], allowEmpty: true, virtual: true },
    { field: 'created_at', label: 'Created', type: 'date' },
    { field: 'updated_at', label: 'Updated', type: 'date' },
    { field: 'name', label: 'Name', type: 'text' },
  ],

  // Mirrors the CHECK constraints on public.prospect_list_entry (migration
  // 248). The enum option arrays are asserted in lockstep with the const
  // arrays in @/lib/prospecting/types AND with the migration text by
  // __tests__/prospect-entry-view-registration.test.ts — this file must not
  // import them, because it is loaded by client components and the prospecting
  // module is server-shaped.
  prospect_list_entry: [
    { field: 'stage', label: 'Stage', type: 'enum', options: ['discovered', 'shortlisted', 'saved', 'dismissed'] },
    // The profile's 0–100 match score (migration 256). NULL until a company
    // has been profiled, so `allowEmpty`; a number so "at least 80" is a
    // filter a user can build in the picker.
    { field: 'fit_score', label: 'Match score', type: 'number', allowEmpty: true },
    { field: 'identity_state', label: 'Identity', type: 'enum', options: ['resolved', 'unresolved', 'anchored', 'needs_review'] },
    { field: 'kind', label: 'Kind', type: 'enum', options: ['company', 'person'] },
    // `list_id` is the internal SCOPE the list detail page sends as a fixed
    // scopeFilter (prospectListScopeFilters in @/lib/prospecting/urls). It is
    // declared here because it is a real column and the generic eq filter path
    // handles it with no new engine seam — but it is deliberately kept OUT of
    // FIELD_CATEGORIES so it never appears in the user-facing filter picker,
    // the same treatment the sibling embeds' scope fields get.
    { field: 'list_id', label: 'List', type: 'text' },
    { field: 'dismissed_reason', label: 'Dismissed reason', type: 'enum', options: ['not_icp', 'too_small', 'too_big', 'competitor', 'already_customer', 'no_contact', 'other'], allowEmpty: true },
    { field: 'created_at', label: 'Created', type: 'date' },
  ],

  // Every field here is a REAL column on public.eval_suite. The three summary
  // facts (case_count, last_run_*, last_outcome) used to be computed at read
  // time from eval_case / eval_run; migration 255 denormalized them onto the
  // suite behind triggers precisely so a view can filter, group and sort on
  // them — a PostgREST predicate cannot touch a derived value.
  //
  // The enum option arrays are asserted in lockstep with migrations 252 and
  // 255 by __tests__/eval-suite-view-registration.test.ts, the way the
  // prospect entry's are against 248.
  eval_suite: [
    { field: 'target_kind', label: 'Target', type: 'enum', options: ['agent', 'skill'] },
    { field: 'suite_kind', label: 'Kind', type: 'enum', options: ['capability', 'regression'] },
    // NULL = the suite has never had a run SETTLE. That is a real state a user
    // filters for ("show me what has never been graded"), so allowEmpty.
    { field: 'last_outcome', label: 'Outcome', type: 'enum', options: ['passed', 'scored', 'failed', 'errored'], allowEmpty: true },
    { field: 'last_run_mode', label: 'Last mode', type: 'enum', options: ['batch', 'live'], allowEmpty: true },
    { field: 'last_run_at', label: 'Last run', type: 'date', allowEmpty: true },
    { field: 'case_count', label: 'Cases', type: 'number' },
    { field: 'judge_model', label: 'Judge', type: 'text', allowEmpty: true },
    // NO 'created_by' Creator filter, deliberately — the same trap sequence and
    // flow document: the shared member picker emits `member.id`, but
    // eval_suite.created_by (migration 252) references auth.users(id), a
    // different UUID space, so every selection would render an empty list.
    { field: 'created_at', label: 'Created', type: 'date' },
    { field: 'updated_at', label: 'Updated', type: 'date' },
    { field: 'name', label: 'Name', type: 'text' },
  ],

  // Every field here is a REAL column on public.eval_case: 252 declares the
  // authoring columns, 257 the two denormalized summary ones (`last_outcome`,
  // `last_run_at`), for the same reason 255 did it for the suite — a
  // PostgREST predicate cannot touch a value computed at read time.
  //
  // The enum option arrays are asserted in lockstep with the const arrays in
  // @/lib/evals/types AND with migrations 252/257 by
  // __tests__/eval-case-view-registration.test.ts. This file spells them as
  // literals rather than importing the evals consts because it is loaded by
  // client components and that module is server-shaped.
  eval_case: [
    { field: 'polarity', label: 'Polarity', type: 'enum', options: ['positive', 'negative'] },
    // `modes` is a text[] column (252), so it needs the ARRAY_FIELDS treatment
    // in query-engine: `is` becomes a `contains` predicate, not an eq.
    { field: 'modes', label: 'Modes', type: 'enum', options: ['batch', 'live'], isArray: true },
    // NULL = no trial on this case has SETTLED yet — a real state a user
    // filters for ("which cases has nothing ever graded"), so allowEmpty.
    { field: 'last_outcome', label: 'Outcome', type: 'enum', options: ['passed', 'scored', 'failed', 'errored'], allowEmpty: true },
    { field: 'last_run_at', label: 'Last run', type: 'date', allowEmpty: true },
    { field: 'visibility', label: 'Visibility', type: 'enum', options: ['workspace', 'private'] },
    // `suite_id` is the internal SCOPE the suite detail page locks as a fixed
    // scopeFilter. Declared here because it is a real column the generic eq
    // path handles with no new engine seam — but kept OUT of FIELD_CATEGORIES
    // so it never appears in the user-facing filter picker, exactly the
    // treatment prospect_list_entry's `list_id` gets.
    { field: 'suite_id', label: 'Suite', type: 'text' },
    // The suite's canonical case sequence (252) and the DEFAULT ordering for
    // this entity. Declared here because ViewSettingsPopover builds its
    // Ordering select from FILTERABLE_FIELDS alone — without an entry the
    // control renders blank and any click silently rewrites the ordering.
    // Kept OUT of FIELD_CATEGORIES like `suite_id`, so it never reaches the
    // filter picker.
    { field: 'sort_order', label: 'Order', type: 'number' },
    { field: 'created_at', label: 'Created', type: 'date' },
    { field: 'updated_at', label: 'Updated', type: 'date' },
    { field: 'name', label: 'Name', type: 'text' },
  ],

  // Mirrors the CHECK constraints on public.eval_run (migration 252). A run is
  // an immutable RECORD of one execution, so every field here is read-only —
  // see DISPLAY_PROPERTIES.eval_run.
  eval_run: [
    { field: 'mode', label: 'Mode', type: 'enum', options: ['batch', 'live'] },
    { field: 'speed', label: 'Speed', type: 'enum', options: ['realtime', 'fast', 'instant'] },
    { field: 'status', label: 'Status', type: 'enum', options: ['queued', 'running', 'completed', 'failed', 'cancelled'] },
    // NULL while the run has not settled — queued, running, or ended without a
    // verdict (cancelled). allowEmpty so "runs with no verdict" is filterable.
    { field: 'outcome', label: 'Outcome', type: 'enum', options: ['passed', 'scored', 'failed'], allowEmpty: true },
    { field: 'started_at', label: 'Started', type: 'date' },
    { field: 'cost_usd', label: 'Cost', type: 'number' },
    { field: 'duration_ms', label: 'Duration', type: 'number' },
    { field: 'trials_per_case', label: 'Trials per case', type: 'number' },
    { field: 'target_prompt_hash', label: 'Prompt', type: 'text' },
    // The SCOPE field, hidden from the picker — same treatment as
    // eval_case.suite_id above.
    { field: 'suite_id', label: 'Suite', type: 'text' },
    // NO 'started_by' Creator filter, deliberately — the same trap eval_suite,
    // sequence and flow all document: the shared member picker emits
    // `member.id`, but eval_run.started_by (migration 252) references
    // auth.users(id), a disjoint UUID space, so every selection would render
    // an empty list. eval_run has no `created_by` at all.
  ],

  // ── claim ──────────────────────────────────────────────────────────────
  //
  // THE CONSTRAINT THAT SHAPES THIS LIST: a claim view can be drawn as the
  // knowledge map (layout 'graph'), and the map filters by masking typed arrays
  // held in memory over an already-laid-out graph — not by running SQL
  // (graph-map/tiling.ts). So every field here has to be answerable from BOTH
  // Postgres and that mask, or the same saved view would select different
  // claims depending on which layout you happened to be on. Fields that only
  // one side can answer are left out on purpose; see the notes below.
  //
  // Mirrors the CHECK constraints on public.claim (migrations 109, 117, 180).
  claim: [
    { field: 'type', label: 'Type', type: 'enum', options: ['fact', 'decision_summary', 'open_question', 'inference'] },
    // NO 'dismissed' — a dismissed claim is not in the knowledge universe at
    // all (see the note on `status` below), so offering it would be a filter
    // that always returns nothing.
    { field: 'confirmation', label: 'Status', type: 'enum', options: ['confirmed', 'suggested'] },
    // Nullable: an un-scored claim is a real state ("what has no confidence
    // yet"), and it fails every comparison rather than counting as zero —
    // matching the map's mask, which treats a null as "not at least N".
    { field: 'confidence', label: 'Confidence', type: 'number', allowEmpty: true },
    { field: 'auto_accepted', label: 'Auto-accepted', type: 'boolean' },
    { field: 'scope', label: 'Scope', type: 'enum', options: ['workspace', 'personal'] },
    { field: 'created_by', label: 'Creator', type: 'member', allowEmpty: true },
    // A claim can belong to SEVERAL projects, so this is an array column
    // (`claim.project_ids`, migration 276) filtered with `@>`, exactly like the
    // CRM's "From list" chip over `contact.prospect_list_ids`. The underlying
    // truth is still an `entity_link` row — a trigger keeps the column in step,
    // because PostgREST cannot embed a polymorphic link table with no foreign
    // key, and pre-resolving claim ids into an `.in(...)` is an unbounded URL
    // that breaks at exactly the workspace size where the filter matters.
    { field: 'project_ids', label: 'Project', type: 'project', isArray: true, allowEmpty: true },
    { field: 'created_at', label: 'Created', type: 'date' },
    // When the claim's evidence actually HAPPENED, backfilled from its sources
    // (migration 180) — the date a reader means by "what did we learn in
    // August", as opposed to when the weaver got round to extracting it.
    { field: 'event_at', label: 'Happened', type: 'date', allowEmpty: true },
    { field: 'last_verified_at', label: 'Last verified', type: 'date', allowEmpty: true },
    { field: 'text', label: 'Text', type: 'text' },
    // DELIBERATELY ABSENT:
    //  - `status` (active | superseded | disputed | archived): every knowledge
    //    surface reads only `status='active'` and the map bakes that into its
    //    layout (graph-build.ts), because a superseded claim has no position.
    //    It is a universe boundary, not a filter — offering it would produce a
    //    list the graph could never show. Superseded claims are reached through
    //    the claim they were replaced by.
    //  - `subject_member_id` and `woven_at`: no product surface reads either,
    //    and every field here is permanent weight in the in-memory map.
  ],
}

// ============================================================
// Display Properties Per Entity Type
// ============================================================

export const DEFAULT_DISPLAY_PROPERTIES: Record<ViewEntityType, string[]> = {
  agent: [],
  skill: [],
  // Ordered left (rare) → right (always present)
  action: ['labels', 'project', 'priority', 'due_at', 'assignee', 'status', 'identifier'],
  capture: ['action_count', 'participant_count', 'recipe', 'project', 'started_at', 'status'],
  contact: ['interaction_count', 'last_interaction_at', 'relationship_type', 'job_title', 'company'],
  company: ['contact_count', 'industry', 'domain'],
  // Rare → common: who owns it, which account, when it should close, its
  // stage, then the money — the number a pipeline is read for.
  deal: ['owner', 'company', 'expected_close_date', 'stage', 'value'],
  email_thread: ['labels', 'is_unread', 'folder', 'last_message_at', 'from_email'],
  document: ['project', 'created_by', 'updated_at'],
  initiative: ['target_date', 'project', 'status'],
  project: ['labels', 'target_date', 'progress', 'initiative', 'lead', 'status'],
  flow: ['trigger', 'action_target', 'team', 'last_run', 'enabled'],
  // Deliberately NO 'enrollment' here: it is a scope-only property (see
  // `scopeOnly` on its DISPLAY_PROPERTIES entry) that only renders under an
  // enrolled_contact_id scope. Global defaults must stay scope-free — use
  // defaultDisplayProperties() to build defaults for a scoped instance.
  sequence: ['enrolled', 'replied', 'reply_rate', 'created_at', 'status'],
  // What a list IS at a glance: what it's for, how big it got, how much of
  // that is real (people you can email), and what the last run did. `spend`,
  // `status` and the timestamps are one tick away in the picker — `status` in
  // particular stays OFF because the default query hides archived lists, so
  // the column would read "active" on every row it could ever render.
  prospect_list: ['purpose', 'candidates', 'saved', 'last_run'],
  // SLIM BY DEFAULT: the score and where the candidate stands, nothing else.
  //
  // 'fit_rationale' ("Why") is deliberately OFF. It gates the whole reasoning
  // strip on a prospect row — the rationale sentence, the employee range and
  // the citation link — and all of that lives in the detail panel beside the
  // list, where there is room to read it. Ticking "Why" in the picker brings
  // the inline strip back, so nothing was removed: it moved, and the row went
  // from unreadable at 40px to icon · name · score.
  prospect_list_entry: ['fit_score', 'stage'],
  // Rare → common: what the suite grades, how big it is, then the three
  // facts about its last run — the rightmost being the one a user scans for.
  eval_suite: ['target_kind', 'case_count', 'last_outcome', 'last_run_mode', 'last_run_at'],
  // What the case IS (a positive expectation or a negative control), which
  // modes it runs in, then its last verdict and when — the rightmost being
  // what a reader scans a Cases list for.
  eval_case: ['polarity', 'modes', 'last_outcome', 'last_run_at'],
  // A claim row is mostly PROSE — the text is the row. So the meta line stays
  // to three chips: what kind of statement it is, how sure we are, and where it
  // came from. Everything else is one tick away in the picker, and the full
  // record (evidence excerpts, every link, the source it was extracted from) is
  // in the detail panel, which is the same inspector the graph opens.
  claim: ['type', 'confidence', 'project'],
  // Outcome LEADS: the verdict is the single most important thing about a
  // run, so the OutcomeChip opens the meta line. Then what distinguishes two
  // runs of the same suite: which mode, how it scored per dimension, what it
  // cost, how long. `started_at` is deliberately absent — the row title
  // already carries the absolute start time ("Batch run · Sep 8, 3:38 PM"),
  // so it stays available in the display picker rather than duplicating it.
  eval_run: ['outcome', 'mode', 'scores', 'cost_usd', 'duration_ms'],
}

/**
 * Default display properties for a view instance, scope-aware.
 *
 * Scope-only properties (DISPLAY_PROPERTIES entries with `scopeOnly`) are
 * excluded from DEFAULT_DISPLAY_PROPERTIES because on an unscoped list the
 * query route never merges their data and the cell would be permanently
 * blank. When the instance IS scoped by the required field (e.g. the contact
 * panel's Sequences embed locks `enrolled_contact_id`), they are prepended —
 * leftmost, matching the rare→common ordering of the defaults.
 */
export function defaultDisplayProperties(
  entityType: ViewEntityType,
  scopeFields?: ReadonlySet<string>,
): string[] {
  const base = DEFAULT_DISPLAY_PROPERTIES[entityType] || []
  if (!scopeFields?.size) return base
  const scopedExtras = (DISPLAY_PROPERTIES[entityType] || [])
    .filter((d) => d.scopeOnly && scopeFields.has(d.scopeOnly) && !base.includes(d.field))
    .map((d) => d.field)
  return scopedExtras.length ? [...scopedExtras, ...base] : base
}

export type EditablePickerKind =
  | 'priority'
  | 'status'
  | 'member'
  | 'project'
  | 'initiative'
  | 'company'
  | 'label'
  | 'date'
  | 'enum'
  | 'boolean'
  | 'text'

/**
 * Declares that this row-property can be edited inline via the named picker.
 * `apiField` is the request body key sent to PATCH /api/account/{entity}/:id
 * (e.g. the displayed "status" property patches `status_id`).
 */
export interface EditableDescriptor {
  picker: EditablePickerKind
  apiField: string
  /** Optional hint — 'none' skips pickers when value is null/empty */
  allowEmpty?: boolean
}

export interface DisplayPropertyDefinition {
  field: string
  label: string
  editable?: EditableDescriptor
  /**
   * Scope-only property: only meaningful when the view instance is scoped by
   * this filter field (the query route merges the backing data only under
   * that scope). Excluded from the display-property picker and from default
   * configs on instances that do not lock this field — on an unscoped list
   * the cell could never render anything.
   */
  scopeOnly?: string
}

export const DISPLAY_PROPERTIES: Record<ViewEntityType, DisplayPropertyDefinition[]> = {
  agent: [],
  skill: [],
  action: [
    { field: 'identifier', label: 'ID' },
    { field: 'status', label: 'Status', editable: { picker: 'status', apiField: 'status_id' } },
    { field: 'assignee', label: 'Assignee', editable: { picker: 'member', apiField: 'assignee_id', allowEmpty: true } },
    { field: 'priority', label: 'Priority', editable: { picker: 'priority', apiField: 'priority' } },
    { field: 'project', label: 'Project', editable: { picker: 'project', apiField: 'project_id', allowEmpty: true } },
    { field: 'milestone', label: 'Milestone' },
    { field: 'cycle', label: 'Cycle' },
    { field: 'due_at', label: 'Due date', editable: { picker: 'date', apiField: 'due_at' } },
    { field: 'labels', label: 'Labels', editable: { picker: 'label', apiField: 'labels' } },
    { field: 'created_at', label: 'Created' },
    { field: 'updated_at', label: 'Updated' },
    { field: 'estimate', label: 'Estimate' },
    { field: 'confirmation', label: 'Confirmation' },
  ],
  capture: [
    { field: 'project', label: 'Project', editable: { picker: 'project', apiField: 'project_id', allowEmpty: true } },
    { field: 'status', label: 'Status' },
    { field: 'recipe', label: 'Meeting Type' },
    { field: 'started_at', label: 'Started' },
    { field: 'ended_at', label: 'Ended' },
    { field: 'duration', label: 'Duration' },
    { field: 'participant_count', label: 'Participants' },
    { field: 'action_count', label: 'Actions' },
    { field: 'ai_processed', label: 'AI processed' },
    // Display-only, deliberately no `editable`: the captures PATCH route has no
    // label_ids handling, so an inline label picker would silently no-op.
    { field: 'labels', label: 'Labels' },
    { field: 'created_at', label: 'Created' },
  ],
  contact: [
    { field: 'company', label: 'Company', editable: { picker: 'company', apiField: 'company_id', allowEmpty: true } },
    { field: 'job_title', label: 'Job title', editable: { picker: 'text', apiField: 'job_title' } },
    { field: 'department', label: 'Department', editable: { picker: 'text', apiField: 'department' } },
    { field: 'email', label: 'Email', editable: { picker: 'text', apiField: 'email' } },
    { field: 'phone', label: 'Phone', editable: { picker: 'text', apiField: 'phone' } },
    { field: 'linkedin_url', label: 'LinkedIn', editable: { picker: 'text', apiField: 'linkedin_url' } },
    { field: 'relationship_type', label: 'Relationship', editable: { picker: 'enum', apiField: 'relationship_type' } },
    { field: 'relationship_strength', label: 'Strength', editable: { picker: 'enum', apiField: 'relationship_strength' } },
    { field: 'last_interaction_at', label: 'Last interaction' },
    { field: 'interaction_count', label: 'Interactions' },
    { field: 'next_followup_at', label: 'Next follow-up', editable: { picker: 'date', apiField: 'next_followup_at' } },
    { field: 'tags', label: 'Tags' },
    { field: 'source', label: 'Source' },
    { field: 'created_at', label: 'Created' },
  ],
  company: [
    { field: 'domain', label: 'Domain', editable: { picker: 'text', apiField: 'domain' } },
    { field: 'industry', label: 'Industry', editable: { picker: 'text', apiField: 'industry' } },
    { field: 'employee_count_range', label: 'Size', editable: { picker: 'enum', apiField: 'employee_count_range' } },
    { field: 'contact_count', label: 'Contacts' },
    { field: 'tags', label: 'Tags' },
    { field: 'created_at', label: 'Created' },
  ],
  deal: [
    // `stage` is display-only in a cell: the board's drag is how a deal moves
    // (it PATCHes stage_id), and the stage picker needs the pipeline's own
    // stages, which no generic enum picker knows.
    { field: 'stage', label: 'Stage' },
    { field: 'value', label: 'Value' },
    { field: 'owner', label: 'Owner', editable: { picker: 'member', apiField: 'owner_id', allowEmpty: true } },
    { field: 'company', label: 'Company', editable: { picker: 'company', apiField: 'company_id', allowEmpty: true } },
    { field: 'expected_close_date', label: 'Expected close', editable: { picker: 'date', apiField: 'expected_close_date' } },
    { field: 'closed_at', label: 'Closed' },
    { field: 'created_at', label: 'Created' },
    { field: 'updated_at', label: 'Updated' },
  ],
  email_thread: [
    { field: 'from_email', label: 'From' },
    { field: 'folder', label: 'Folder', editable: { picker: 'enum', apiField: 'folder' } },
    { field: 'is_unread', label: 'Unread', editable: { picker: 'boolean', apiField: 'is_unread' } },
    { field: 'is_starred', label: 'Starred', editable: { picker: 'boolean', apiField: 'is_starred' } },
    { field: 'labels', label: 'Labels', editable: { picker: 'label', apiField: 'labels' } },
    { field: 'message_count', label: 'Messages' },
    { field: 'last_message_at', label: 'Last message' },
    { field: 'auto_classified', label: 'Classification' },
    { field: 'created_at', label: 'Created' },
  ],
  document: [
    { field: 'project', label: 'Project', editable: { picker: 'project', apiField: 'project_id', allowEmpty: true } },
    { field: 'team', label: 'Team' },
    { field: 'created_by', label: 'Creator' },
    { field: 'is_pinned', label: 'Pinned', editable: { picker: 'boolean', apiField: 'is_pinned' } },
    { field: 'status', label: 'Status', editable: { picker: 'enum', apiField: 'status' } },
    { field: 'created_at', label: 'Created' },
    { field: 'updated_at', label: 'Updated' },
  ],
  initiative: [
    { field: 'status', label: 'Status', editable: { picker: 'enum', apiField: 'status' } },
    { field: 'owner', label: 'Owner', editable: { picker: 'member', apiField: 'owner_id', allowEmpty: true } },
    { field: 'target_date', label: 'Target date', editable: { picker: 'date', apiField: 'target_date' } },
    { field: 'labels', label: 'Labels', editable: { picker: 'label', apiField: 'labels' } },
    { field: 'created_at', label: 'Created' },
    { field: 'updated_at', label: 'Updated' },
  ],
  project: [
    { field: 'status', label: 'Status', editable: { picker: 'enum', apiField: 'status' } },
    { field: 'lead', label: 'Lead', editable: { picker: 'member', apiField: 'lead_id', allowEmpty: true } },
    { field: 'initiative', label: 'Initiative', editable: { picker: 'initiative', apiField: 'initiative_id', allowEmpty: true } },
    { field: 'progress', label: 'Progress' },
    { field: 'target_date', label: 'Target date', editable: { picker: 'date', apiField: 'target_date' } },
    { field: 'start_date', label: 'Start date', editable: { picker: 'date', apiField: 'start_date' } },
    { field: 'labels', label: 'Labels', editable: { picker: 'label', apiField: 'labels' } },
    { field: 'is_pinned', label: 'Pinned', editable: { picker: 'boolean', apiField: 'is_pinned' } },
    { field: 'created_at', label: 'Created' },
    { field: 'updated_at', label: 'Updated' },
  ],
  flow: [
    // `trigger` and `action_target` are synthetic, read-only summary cells
    // derived from trigger_config / action_config (see entity-row.tsx).
    { field: 'trigger', label: 'Trigger' },
    { field: 'action_target', label: 'Action' },
    { field: 'team', label: 'Team' },
    { field: 'last_run', label: 'Last run' },
    { field: 'enabled', label: 'Status', editable: { picker: 'boolean', apiField: 'enabled' } },
    { field: 'created_at', label: 'Created' },
    { field: 'updated_at', label: 'Updated' },
  ],
  sequence: [
    // `status` is deliberately NOT inline-editable: transitions carry
    // semantics a bare enum picker can't express — draft→active only via
    // Review & Launch, resume recomputes past-due schedules, archive exits
    // every active enrollment (see /api/account/sequences/[id] PATCH). The
    // detail page's lifecycle actions are the write path.
    // `enrolled`/`active`/`replied`/`reply_rate` are synthetic, read-only
    // cells derived from enrollment_counts (merged in the views/query route
    // the same way company contact_count is — see entity-row.tsx).
    // `enrollment` is the scoped contact's own enrollment (status / progress /
    // next send), merged from `contact_enrollment` only under a contact scope
    // — hence scopeOnly: it is hidden from the picker and omitted from
    // defaults unless the instance locks `enrolled_contact_id`.
    { field: 'status', label: 'Status' },
    { field: 'enrollment', label: 'Enrollment', scopeOnly: 'enrolled_contact_id' },
    { field: 'enrolled', label: 'Enrolled' },
    { field: 'active', label: 'Active' },
    { field: 'replied', label: 'Replied' },
    { field: 'reply_rate', label: 'Reply rate' },
    { field: 'created_at', label: 'Created' },
    { field: 'updated_at', label: 'Updated' },
  ],
  prospect_list: [
    // Read-only, every one of them, and deliberately so. `purpose` and
    // `status` LOOK like enum cells the generic picker could edit, but a
    // purpose change re-seeds the ICP draft and the angle templates the next
    // run uses (see updateList), and archiving is the destructive verb the
    // DELETE route maps to — neither is a thing to flip by mis-clicking a
    // dropdown in a row. Renaming, re-purposing and archiving live on the
    // list's own page, which can explain what they do.
    //
    // `candidates`, `saved`, `last_run` and `spend` are synthetic, read-only
    // summary cells: the first two come from `entry_counts` (merged by the
    // views/query route the same way company contact_count is), the last two
    // from the embedded newest `prospecting_run`.
    { field: 'purpose', label: 'Purpose' },
    { field: 'candidates', label: 'Candidates' },
    { field: 'saved', label: 'Saved' },
    { field: 'last_run', label: 'Last run' },
    { field: 'status', label: 'Status' },
    { field: 'updated_at', label: 'Updated' },
    { field: 'created_at', label: 'Created' },
  ],
  prospect_list_entry: [
    // NOTHING here is inline-editable, `stage` included. The generic enum-cell
    // and board-drag paths both PATCH /api/account/prospecting/entries/[id],
    // which refuses stage='saved' outright (saving means a CRM record exists —
    // only entries/save may claim it) and refuses stage='dismissed' without a
    // reason. A picker offering all four values would 400 on two of them and
    // roll the cell back. The honest affordances in this PR are the explicit
    // Save / Dismiss-with-reason controls; a stage cell (and the board that
    // needs it) lands with the write path that supports it in PR 7.
    { field: 'stage', label: 'Stage' },
    // Both FIT fields are deliberately read-only. They are a machine's score
    // and its reason; a bare number picker on the row would imply a human can
    // overrule the model in place, when the honest affordances are dismiss
    // (with a reason) and re-profile. Pinned by
    // __tests__/prospect-entry-view-registration.test.ts.
    { field: 'fit_score', label: 'Match score' },
    { field: 'fit_rationale', label: 'Why' },
    { field: 'identity_state', label: 'Identity' },
    { field: 'kind', label: 'Kind' },
    { field: 'dismissed_reason', label: 'Dismissed reason' },
    { field: 'created_at', label: 'Created' },
    { field: 'updated_at', label: 'Updated' },
  ],
  eval_suite: [
    // `suite_kind` is the ONE editable cell: capability vs regression is a
    // plain authoring choice, and the suites PATCH route already accepts it
    // (UpdateSuiteSchema). Everything else is read-only on purpose —
    // `case_count` and the three `last_*` columns are owned by migration 255's
    // triggers, so a picker over them would write a value the next child-table
    // change silently overwrites, and `target_kind` is what the suite grades:
    // re-pointing it would invalidate every run already recorded against it.
    { field: 'target_kind', label: 'Target' },
    { field: 'suite_kind', label: 'Kind', editable: { picker: 'enum', apiField: 'suite_kind' } },
    { field: 'case_count', label: 'Cases' },
    { field: 'last_outcome', label: 'Outcome' },
    { field: 'last_run_mode', label: 'Last mode' },
    { field: 'last_run_at', label: 'Last run' },
    { field: 'judge_model', label: 'Judge' },
    { field: 'created_at', label: 'Created' },
    { field: 'updated_at', label: 'Updated' },
  ],
  eval_case: [
    // `polarity` is the ONE editable cell: positive-vs-negative-control is a
    // plain authoring choice with no derived state behind it, and
    // UpdateCaseSchema accepts it.
    //
    // `modes` is NOT editable even though the schema accepts it — it is a
    // multi-value text[] and the generic enum picker writes ONE value, so a
    // picker here would silently narrow a batch+live case to one mode.
    // `visibility` is NOT editable because UpdateCaseSchema does not accept
    // it at all: the cell would 400 and roll back. `last_outcome` and
    // `last_run_at` are owned by migration 257's triggers on eval_trial — a
    // picker over either would write a value the next trial silently reverts.
    { field: 'polarity', label: 'Polarity', editable: { picker: 'enum', apiField: 'polarity' } },
    { field: 'modes', label: 'Modes' },
    { field: 'last_outcome', label: 'Outcome' },
    { field: 'last_run_at', label: 'Last run' },
    { field: 'visibility', label: 'Visibility' },
    { field: 'created_at', label: 'Created' },
  ],
  eval_run: [
    // NOTHING here is editable, and that is structural rather than a gap: a
    // run is the immutable RECORD of one execution against one prompt hash.
    // There is no PATCH /api/account/evals/runs/[id] at all (ENTITY_ENDPOINTS
    // maps eval_run to null), so every cell here is read-only by construction.
    { field: 'mode', label: 'Mode' },
    { field: 'speed', label: 'Speed' },
    { field: 'status', label: 'Status' },
    { field: 'outcome', label: 'Outcome' },
    { field: 'scores', label: 'Scores' },
    { field: 'cost_usd', label: 'Cost' },
    { field: 'duration_ms', label: 'Duration' },
    { field: 'trials_per_case', label: 'Trials per case' },
    { field: 'target_prompt_hash', label: 'Prompt' },
    { field: 'started_at', label: 'Started' },
    { field: 'ended_at', label: 'Ended' },
  ],
  claim: [
    // `confirmation` is the ONE editable cell, and it is the only field on a
    // claim a person is allowed to set: everything else here is extraction
    // output. Letting a row editor rewrite `text`, `type` or `confidence`
    // would break the provenance the graph is built on — so PATCH
    // /api/account/claims/[id] accepts `confirmation` and refuses the rest,
    // and no other property here carries an `editable`.
    { field: 'confirmation', label: 'Status', editable: { picker: 'enum', apiField: 'confirmation' } },
    { field: 'type', label: 'Type' },
    { field: 'confidence', label: 'Confidence' },
    { field: 'auto_accepted', label: 'Auto-accepted' },
    { field: 'scope', label: 'Scope' },
    // Resolved by the query route from `entity_link`, not selected from the
    // claim row — a claim has no project column.
    { field: 'project', label: 'Project' },
    { field: 'source', label: 'Source' },
    { field: 'created_by', label: 'Creator' },
    { field: 'created_at', label: 'Created' },
    { field: 'event_at', label: 'Happened' },
    { field: 'last_verified_at', label: 'Last verified' },
  ],
}

// ============================================================
// Default board group-by per entity type
// ============================================================

/**
 * The sort a view opens on when it does not carry one of its own.
 *
 * Almost everything is a feed — the newest thing first — so `created_at desc`
 * is the fallback and the map only names the exceptions. `prospect_list` is
 * one: a list is a WORKING SURFACE that is run again and again, not a record
 * filed once, so the one you touched last is the one you want at the top, and
 * creation date sinks a list you use weekly under lists you made and forgot.
 *
 * Read through `defaultOrdering()` rather than directly, so an entity that
 * wants the fallback simply stays out of the map.
 */
export const DEFAULT_ORDERING: Partial<Record<ViewEntityType, SortConfig[]>> = {
  // Preserve the library endpoints' ordering until the user chooses a sort.
  agent: [],
  skill: [],
  prospect_list: [{ field: 'updated_at', direction: 'desc' }],
  // The biggest deals first: what a pipeline is read for. Newest breaks ties
  // (and orders the deals with no value yet, which sort last).
  deal: [
    { field: 'value', direction: 'desc' },
    { field: 'created_at', direction: 'desc' },
  ],
  // Hottest first — the score is the point of profiling. `applyOrdering`
  // sends NULLS LAST, so the rows nobody has profiled yet sit under every
  // scored one, newest first among themselves.
  prospect_list_entry: [
    { field: 'fit_score', direction: 'desc' },
    { field: 'created_at', direction: 'desc' },
  ],
  // `eval_run` HAS NO created_at COLUMN AT ALL (migration 252 — a run's birth
  // time is `started_at`). Falling through to the newest-first default would
  // order on it and raise a PostgREST 42703, so the Runs list would 500 on its
  // very first load rather than sort oddly. Newest run first is also the only
  // useful default: the run at the top is the one whose number the reader came
  // to check.
  eval_run: [{ field: 'started_at', direction: 'desc' }],
  // `eval_case` is an ORDERED set. Cases carry an explicit `sort_order` (252,
  // and its suite index is on `(suite_id, sort_order, created_at)`), which is
  // the sequence the case editor and every replay walk them in. Sorting the
  // Cases tab by recency instead would show the suite's cases in an order
  // nothing else in the feature uses. `created_at` is the tie-break: nothing
  // writes `sort_order` yet, so every row holds the DEFAULT 0 and a single-key
  // sort is a total tie — Postgres could then return a different order per
  // statement, and offset pagination would show a case twice or skip it
  // entirely. This matches listCases and the 252 index.
  eval_case: [
    { field: 'sort_order', direction: 'asc' },
    { field: 'created_at', direction: 'asc' },
  ],
}

/** The default sort for an entity — its own, or the newest-first fallback. */
export function defaultOrdering(entityType: ViewEntityType): SortConfig[] {
  return DEFAULT_ORDERING[entityType] ?? [{ field: 'created_at', direction: 'desc' }]
}

/**
 * The layout a view opens in when it does not carry one of its own.
 *
 * `list` is the fallback for everything tabular, so the map only names the
 * exception. A claim's natural reading is the knowledge map: opening Knowledge
 * on a LIST of claim sentences would be the wrong first impression of a feature
 * whose whole point is the shape of the graph — and the page header's own
 * Graph/Library pill would then say "Graph" over a list, which is a UI that
 * lies. List and board are one click away in the view settings.
 *
 * Read through `defaultLayout()` rather than directly.
 */
export const DEFAULT_LAYOUT: Partial<Record<ViewEntityType, ViewLayout>> = {
  claim: 'graph',
}

/** The layout an entity opens in — its own, or the list fallback. */
export function defaultLayout(entityType: ViewEntityType): ViewLayout {
  return DEFAULT_LAYOUT[entityType] ?? 'list'
}

export const DEFAULT_BOARD_GROUP_BY: Record<ViewEntityType, string> = {
  agent: 'visibility',
  skill: 'visibility',
  action: 'status_id',
  capture: 'auto_capture_status',
  contact: 'relationship_type',
  company: 'industry',
  // The pipeline board: one column per stage, in the pipeline's order (the
  // views/query route adds the empty ones), and a drag PATCHes stage_id.
  deal: 'stage_id',
  email_thread: 'folder',
  document: 'status',
  initiative: 'status',
  project: 'status',
  flow: 'enabled',
  sequence: 'status',
  // `purpose` — the one grouping whose columns are the lists' own kinds
  // (Customers / Investors / Partners / Talent / Custom) and whose drag has a
  // real write path: PATCH /api/account/prospecting/lists/[id] takes `purpose`
  // (updateList → asPurpose). Grouping by `status` is still in the picker, but
  // the default query hides archived rows, so that board opens with one
  // column.
  prospect_list: 'purpose',
  // `stage`, now that the board has a write path for it (PR 7). Dragging a
  // card no longer PATCHes the group-by field blindly: `unified-view-layout`'s
  // prospect intercept sends `dismissed` through the reason picker, `saved`
  // through the save route (a stage that asserts a CRM record exists), refuses
  // `discovered`, and lets only `shortlisted` fall through as a plain PATCH.
  // (Grouping by the old fit tier was the previous default; it went with the
  // tier — a machine score no drag may rewrite.)
  prospect_list_entry: 'stage',
  // The board is DISPLAY-ONLY for suites. Outcome is what the last run
  // concluded — a trigger-owned column — so every drag between its columns
  // is refused by unified-view-layout's guard rather than PATCHed.
  eval_suite: 'last_outcome',
  // Both boards are DISPLAY-ONLY, for the same reason the suite board is: the
  // group-by column is a verdict, not a field. `eval_case.last_outcome` is
  // trigger-owned (257) and `eval_run.outcome` belongs to a finished run —
  // every drag between their columns is refused by unified-view-layout's
  // guard rather than PATCHed.
  eval_case: 'last_outcome',
  eval_run: 'outcome',
  // `confirmation` — deliberately NOT `type`. Type is what the extractor
  // decided a statement is; no drag may rewrite it, so a type board would be
  // display-only. Confirmation is the one field on a claim a person sets, and
  // PATCH /api/account/claims/[id] takes it — which makes the claim board the
  // review queue it should be: Suggested on the left, Confirmed on the right,
  // and dragging between them IS confirming. (Dismissed is not a column: a
  // dismissed claim leaves the knowledge universe entirely, so it would be a
  // column you can drag into and never out of. Dismiss stays a row action.)
  claim: 'confirmation',
}

// ============================================================
// Filter field category groupings (for the filter picker UI)
// ============================================================

export const FIELD_CATEGORIES: Record<ViewEntityType, { label: string; fields: string[] }[]> = {
  agent: [{ label: '', fields: LIBRARY_FILTER_FIELDS.map(f => f.field) }],
  skill: [{ label: '', fields: LIBRARY_FILTER_FIELDS.map(f => f.field) }],
  action: [
    { label: '', fields: ['status_id', 'status_type', 'assignee_id', 'user_id', 'priority', 'labels', 'due_at', 'created_at', 'updated_at'] },
    { label: 'Organization', fields: ['project_id', 'milestone_id', 'initiative_id', 'cycle_id', 'team_id'] },
    { label: 'Source', fields: ['source_capture_id', 'confirmation'] },
    { label: 'Content', fields: ['title', 'identifier', 'parent_id'] },
  ],
  capture: [
    { label: '', fields: ['status', 'auto_capture_status', 'ai_processed', 'labels', 'user_id', 'team_id', 'project_id'] },
    { label: 'Time', fields: ['started_at', 'ended_at', 'scheduled_start', 'created_at'] },
    { label: 'Content', fields: ['title', 'calendar_provider'] },
  ],
  contact: [
    { label: '', fields: ['relationship_type', 'relationship_strength', 'company_id', 'tags', 'source'] },
    { label: 'Activity', fields: ['last_interaction_at', 'interaction_count', 'next_followup_at', 'created_at'] },
    { label: 'Identity', fields: ['full_name', 'email', 'job_title'] },
  ],
  company: [
    { label: '', fields: ['name', 'industry', 'domain', 'employee_count_range', 'tags'] },
    { label: 'Activity', fields: ['created_at'] },
  ],
  deal: [
    { label: '', fields: ['stage_id', 'owner_id', 'company_id', 'contact_ids', 'value', 'currency', 'source'] },
    { label: 'Dates', fields: ['expected_close_date', 'closed_at', 'created_at', 'updated_at'] },
    { label: 'Content', fields: ['name'] },
  ],
  email_thread: [
    { label: '', fields: ['folder', 'is_unread', 'is_starred', 'needs_reply', 'has_attachments', 'auto_classified', 'labels'] },
    { label: 'People', fields: ['from_email', 'linked_contact_id'] },
    { label: 'Links', fields: ['linked_capture_id', 'linked_project_id'] },
    { label: 'Content', fields: ['message_count', 'last_message_at', 'created_at'] },
  ],
  document: [
    { label: '', fields: ['created_by', 'project_id', 'team_id', 'is_pinned', 'status'] },
    { label: 'Content', fields: ['title', 'created_at', 'updated_at'] },
  ],
  initiative: [
    { label: '', fields: ['status', 'owner_id', 'labels', 'target_date'] },
    { label: 'Content', fields: ['name', 'created_at', 'updated_at'] },
  ],
  project: [
    { label: '', fields: ['status', 'lead_id', 'initiative_id', 'labels', 'is_pinned', 'is_archived'] },
    { label: 'Dates', fields: ['start_date', 'target_date', 'created_at', 'updated_at'] },
    { label: 'Content', fields: ['name'] },
  ],
  flow: [
    { label: '', fields: ['enabled', 'trigger_entity_type', 'team_id', 'last_run_status'] },
    { label: 'Content', fields: ['name', 'created_at', 'updated_at'] },
  ],
  sequence: [
    { label: '', fields: ['status'] },
    { label: 'Content', fields: ['name', 'created_at', 'updated_at'] },
  ],
  prospect_list: [
    { label: '', fields: ['purpose', 'status', 'last_run_status', 'last_run_kind'] },
    { label: 'Policy', fields: ['exclude_contacted'] },
    { label: 'Content', fields: ['name', 'created_at', 'updated_at'] },
  ],
  // NOTE: no 'list_id' — it is the internal scope the list detail page locks,
  // not a filter a user picks (see the FILTERABLE_FIELDS note above).
  prospect_list_entry: [
    { label: '', fields: ['stage', 'fit_score', 'kind'] },
    { label: 'Identity', fields: ['identity_state'] },
    { label: 'Dismissal', fields: ['dismissed_reason'] },
    { label: 'Content', fields: ['created_at'] },
  ],
  // One uncategorised group: a suite has few enough fields that splitting them
  // into headed sections would cost a scan rather than save one.
  eval_suite: [
    {
      label: '',
      fields: [
        'target_kind', 'suite_kind', 'last_outcome', 'last_run_mode',
        'last_run_at', 'case_count', 'judge_model',
        'name', 'created_at', 'updated_at',
      ],
    },
  ],
  // NOTE: no 'suite_id' in either of these — it is the internal scope the
  // suite detail page locks, not a filter a user picks (see the
  // FILTERABLE_FIELDS notes above).
  eval_case: [
    {
      label: '',
      fields: [
        'polarity', 'modes', 'last_outcome', 'last_run_at',
        'visibility', 'name', 'created_at', 'updated_at',
      ],
    },
  ],
  eval_run: [
    {
      label: '',
      fields: [
        'mode', 'speed', 'status', 'outcome', 'started_at',
        'cost_usd', 'duration_ms', 'trials_per_case', 'target_prompt_hash',
      ],
    },
  ],
  claim: [
    { label: '', fields: ['type', 'confirmation', 'confidence', 'auto_accepted'] },
    { label: 'Origin', fields: ['project_ids', 'created_by', 'scope'] },
    // `event_at` sits with the dates rather than under Origin because that is
    // how it reads to a user: "Created" is when we extracted it, "Happened" is
    // when the meeting it came from actually took place.
    { label: 'Time', fields: ['created_at', 'event_at', 'last_verified_at'] },
    { label: 'Content', fields: ['text'] },
  ],
}

// ============================================================
// API Types
// ============================================================

export interface CreateViewBody {
  name: string
  description?: string
  icon?: string
  color?: string
  entity_type: ViewEntityType
  team_id?: string
  visibility: ViewVisibility
  layout: ViewLayout
  filters: ViewFilter[]
  grouping?: GroupConfig | null
  sub_grouping?: GroupConfig | null
  ordering: SortConfig[]
  display_properties?: string[]
  board_group_by?: string
  show_completed?: boolean
  completed_filter?: 'all' | 'recent' | 'none'
  show_sub_items?: boolean
  nested_sub_items?: boolean
  show_empty_groups?: boolean
}

export interface UpdateViewBody extends Partial<CreateViewBody> {}

export interface ViewListParams {
  entity_type?: ViewEntityType
  team_id?: string
  visibility?: ViewVisibility
  favorites_only?: boolean
}

export interface ViewQueryParams {
  page?: number
  per_page?: number
  override_filters?: ViewFilter[]
}

export interface GroupedResults {
  key: string
  label: string
  items: Record<string, unknown>[]
  subGroups?: GroupedResults[]
  /** Extra data for the group (e.g. status_id for empty workflow state columns) */
  metadata?: Record<string, unknown>
}

export interface ViewQueryResult {
  data: Record<string, unknown>[] | GroupedResults[]
  total: number
  page: number
  per_page: number
  view: Pick<View, 'id' | 'name' | 'entity_type' | 'layout' | 'display_properties' | 'grouping' | 'sub_grouping'>
}
