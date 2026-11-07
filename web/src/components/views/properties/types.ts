/**
 * Shared types for row-cell and side-panel property pickers.
 *
 * Each picker in this folder exports three things:
 *   - A headless `<XPickerContent>` — the list of options, used inside a Popover
 *   - A `<XCellTrigger>` — the tight chip trigger for virtualized row cells
 *   - A `<XPanelField>` — the wider trigger for side-panel property rows
 *
 * Both triggers open the SAME `<XPickerContent>`, so selecting a status in a
 * row opens exactly the same dropdown as selecting a status in the detail panel.
 */

export type PickerKind =
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

export interface WorkflowStateOption {
  id: string
  name: string
  category: string
  color: string | null
  team_id?: string
}

export interface MemberOption {
  id: string
  display_name: string
  avatar_url: string | null
  /**
   * 'ai' for AI team members (agents), absent/'member' for humans. Agents are
   * rendered in their own group in the picker and persist to
   * actions.assignee_ai_member_id instead of the human assignee path.
   */
  kind?: 'member' | 'ai'
}

export interface ProjectOption {
  id: string
  name: string
  icon: string | null
  team_id?: string
}

export interface InitiativeOption {
  id: string
  name: string
  icon: string | null
}

export interface CompanyOption {
  id: string
  name: string
  domain: string | null
  logo_url: string | null
}

export interface LabelOption {
  id: string
  name: string
  color: string
}

/**
 * Bundle of lookup data required to render inline pickers in rows.
 * Populated once per view by `usePickerContext` and threaded through
 * `UnifiedViewLayout` → `ViewList` → `EntityRow`.
 */
export interface PickerContext {
  members: MemberOption[]
  projects: ProjectOption[]
  initiatives: InitiativeOption[]
  companies: CompanyOption[]
  labels: LabelOption[]
  /**
   * Workflow states indexed by team_id. Actions and projects may span teams
   * (e.g. My Actions view), so each row resolves its own states via item.team_id.
   */
  workflowStatesByTeam: Record<string, WorkflowStateOption[]>
  /** True while the initial fetch is still in-flight. Pickers should show a
   *  loading indicator rather than "no options" when this is true. */
  loading?: boolean
  /** Current user's member ID — used to show "You" badge on contact rows. */
  currentMemberId?: string | null
}

export type PickerVariant = 'cell' | 'panel'
