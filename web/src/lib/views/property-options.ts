/**
 * Shared option sets and small style tokens for properties that appear
 * across list rows, side panels, and dialogs.
 *
 * Before this module existed each surface redefined `PRIORITY_OPTIONS`,
 * `STATUS_DOT_COLORS`, etc. locally — leading to drift in labels, ordering
 * and colors. This file is the single source of truth. Consumers import the
 * constants; pickers under `components/views/properties/*` render them.
 */

// ── Priority ────────────────────────────────────────────────

export type PriorityValue = 'none' | 'low' | 'medium' | 'high' | 'urgent'

export interface PriorityOption {
  value: PriorityValue
  label: string
  /** Tailwind text-* class applied to the Flag icon */
  color: string
}

/**
 * Canonical priority ordering: none → low → medium → high → urgent.
 * Matches the detail-panel ordering already used by action/project/initiative
 * side panels and `ProjectActionsList`.
 */
export const PRIORITY_OPTIONS: PriorityOption[] = [
  { value: 'none', label: 'None', color: 'text-muted-foreground' },
  { value: 'low', label: 'Low', color: 'text-green-500' },
  { value: 'medium', label: 'Medium', color: 'text-yellow-500' },
  { value: 'high', label: 'High', color: 'text-orange-500' },
  { value: 'urgent', label: 'Urgent', color: 'text-red-500' },
]

export function getPriorityOption(value: string | null | undefined): PriorityOption {
  return PRIORITY_OPTIONS.find(o => o.value === value) ?? PRIORITY_OPTIONS[0]
}

// ── Workflow-state category dots ────────────────────────────

/**
 * Maps workflow-state `category` values to Tailwind background classes used
 * for the small status dot in list rows and pickers.
 *
 * Use this when a row only has a status category (no custom color) — when the
 * workflow_state has its own `color`, prefer that (see `entity-row.tsx`).
 */
export const STATUS_DOT_COLORS: Record<string, string> = {
  backlog: 'bg-gray-400',
  unstarted: 'bg-gray-400',
  started: 'bg-blue-500',
  completed: 'bg-green-500',
  canceled: 'bg-red-500',
}

// ── Project top-level status (distinct from workflow-state category) ──

export interface ProjectStatusOption {
  value: 'planned' | 'active' | 'paused' | 'completed' | 'canceled'
  label: string
  /** Tailwind bg-* class for the dot */
  dot: string
}

export const PROJECT_STATUS_OPTIONS: ProjectStatusOption[] = [
  { value: 'planned', label: 'Planned', dot: 'bg-gray-400' },
  { value: 'active', label: 'Active', dot: 'bg-blue-500' },
  { value: 'paused', label: 'Paused', dot: 'bg-yellow-500' },
  { value: 'completed', label: 'Completed', dot: 'bg-green-500' },
  { value: 'canceled', label: 'Canceled', dot: 'bg-red-500' },
]

// ── Initiative top-level status ─────────────────────────────

export interface InitiativeStatusOption {
  value: 'planned' | 'active' | 'completed' | 'archived'
  label: string
  dot: string
}

export const INITIATIVE_STATUS_OPTIONS: InitiativeStatusOption[] = [
  { value: 'planned', label: 'Planned', dot: 'bg-gray-400' },
  { value: 'active', label: 'Active', dot: 'bg-blue-500' },
  { value: 'completed', label: 'Completed', dot: 'bg-green-500' },
  { value: 'archived', label: 'Archived', dot: 'bg-gray-500' },
]

// ── Contact relationship type / strength ────────────────────

export interface EnumOption {
  value: string
  label: string
  /** Optional Tailwind background class for a leading colored dot (e.g. 'bg-blue-500'). */
  dot?: string
}

export const RELATIONSHIP_TYPE_OPTIONS: EnumOption[] = [
  { value: 'contact', label: 'Contact' },
  { value: 'lead', label: 'Lead' },
  { value: 'customer', label: 'Customer' },
  { value: 'partner', label: 'Partner' },
  { value: 'vendor', label: 'Vendor' },
  { value: 'internal', label: 'Internal' },
]

export const RELATIONSHIP_STRENGTH_OPTIONS: EnumOption[] = [
  { value: 'strong', label: 'Strong' },
  { value: 'warm', label: 'Warm' },
  { value: 'neutral', label: 'Neutral' },
  { value: 'cold', label: 'Cold' },
  { value: 'stale', label: 'Stale' },
]

/** Tailwind text-* class per relationship strength value. */
export const STRENGTH_COLORS: Record<string, string> = {
  strong: 'text-emerald-600 dark:text-emerald-400',
  warm: 'text-amber-600 dark:text-amber-400',
  neutral: 'text-gray-500',
  cold: 'text-blue-500',
  stale: 'text-red-500',
}

// ── Company employee count ──────────────────────────────────

export const EMPLOYEE_COUNT_OPTIONS: EnumOption[] = [
  { value: '1-10', label: '1–10' },
  { value: '11-50', label: '11–50' },
  { value: '51-200', label: '51–200' },
  { value: '201-500', label: '201–500' },
  { value: '501-1000', label: '501–1,000' },
  { value: '1000+', label: '1,000+' },
]

// ── Email folder ────────────────────────────────────────────

export const EMAIL_FOLDER_OPTIONS: EnumOption[] = [
  { value: 'inbox', label: 'Inbox' },
  { value: 'sent', label: 'Sent' },
  { value: 'drafts', label: 'Drafts' },
  { value: 'starred', label: 'Starred' },
  { value: 'archive', label: 'Archive' },
  { value: 'spam', label: 'Spam' },
  { value: 'trash', label: 'Trash' },
]

// ── Shared style tokens ─────────────────────────────────────

/**
 * Consistent pill/chip style for read-only attribute values in list rows.
 * Mirrored by `<*CellTrigger>` components so editable chips look identical
 * to read-only ones until hovered.
 */
export const chipClass =
  'inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground whitespace-nowrap'

/**
 * Trigger style used by cell-variant picker triggers. Matches `chipClass`
 * plus an invisible-until-hover affordance so the row doesn't look busy.
 */
export const cellTriggerClass =
  'inline-flex items-center gap-1 rounded-full border border-transparent hover:border-border/60 hover:bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground whitespace-nowrap transition-colors cursor-pointer'
