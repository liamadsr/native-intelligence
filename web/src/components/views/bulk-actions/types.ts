import type { ViewEntityType } from '@/lib/views/types'

// ── Bulk action definition ─────────────────────────────────

export type BulkActionId =
  | 'delete'
  | 'archive'
  | 'change_status'
  | 'assign_to'
  | 'set_priority'
  | 'set_project'
  | 'set_initiative'
  | 'add_labels'
  | 'set_owner'
  | 'set_lead'
  | 'set_relationship_type'
  | 'add_tags'
  | 'pin'
  | 'unpin'
  | 'move_to_folder'
  | 'move_to_workspace'
  | 'add_to_sequence'
  | 'mark_read'
  | 'mark_unread'
  | 'star'
  | 'unstar'
  | 'save_to_crm'
  | 'dismiss'
  // Knowledge. Suffixed rather than reusing the bare `dismiss` above, which is
  // the prospect list's own verb and routes through its reason picker — two
  // different writes behind one id would be decided by whichever intercept ran
  // first.
  | 'confirm_claim'
  | 'dismiss_claim'

export interface BulkActionDefinition {
  id: BulkActionId
  label: string
  icon: string // lucide icon name
  /** If true, show a confirmation dialog before executing */
  destructive?: boolean
  /** If true, this action requires a sub-picker (status, member, etc.) */
  requiresValue?: boolean
  /** The type of value picker to show */
  valueType?: 'status' | 'member' | 'priority' | 'project' | 'initiative' | 'labels' | 'tags' | 'relationship_type' | 'folder'
  /** Keyboard shortcut hint */
  shortcut?: string
}

/**
 * An action's "Change status" pick. Workflow states are per team (each team
 * has its own "Done" row), so the pick is a state NAME with each team's own
 * state id; the layout sends every selected action its own team's id, never
 * another team's.
 */
export interface StatusByTeamValue {
  kind: 'status_by_team'
  name: string
  stateIdByTeam: Record<string, string>
}

export function isStatusByTeamValue(value: unknown): value is StatusByTeamValue {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'status_by_team'
}

// ── Actions per entity type ─────────────────────────────────

export const BULK_ACTIONS: Record<ViewEntityType, BulkActionDefinition[]> = {
  // Library actions stay in the existing item dialogs and rows.
  agent: [],
  skill: [],
  action: [
    { id: 'change_status', label: 'Change status...', icon: 'Circle', requiresValue: true, valueType: 'status', shortcut: 'S' },
    { id: 'assign_to', label: 'Assign to...', icon: 'User', requiresValue: true, valueType: 'member', shortcut: 'A' },
    { id: 'set_priority', label: 'Set priority...', icon: 'Flag', requiresValue: true, valueType: 'priority', shortcut: 'P' },
    { id: 'set_project', label: 'Move to project...', icon: 'Folder', requiresValue: true, valueType: 'project' },
    { id: 'add_labels', label: 'Add labels...', icon: 'Tag', requiresValue: true, valueType: 'labels', shortcut: 'L' },
    // No requiresValue — the shared move dialog owns destination + confirmation,
    // and unified-view-layout intercepts this id before the bulk API.
    { id: 'move_to_workspace', label: 'Move to workspace...', icon: 'ArrowRightLeft' },
    { id: 'delete', label: 'Delete', icon: 'Trash2', destructive: true },
  ],
  capture: [
    { id: 'archive', label: 'Archive', icon: 'Archive' },
    { id: 'set_project', label: 'Move to project...', icon: 'Folder', requiresValue: true, valueType: 'project' },
    { id: 'delete', label: 'Delete', icon: 'Trash2', destructive: true },
  ],
  contact: [
    { id: 'set_relationship_type', label: 'Set relationship...', icon: 'Users', requiresValue: true, valueType: 'relationship_type' },
    { id: 'add_tags', label: 'Add tags...', icon: 'Tag', requiresValue: true, valueType: 'tags' },
    // No requiresValue — like move_to_workspace, the shared AddToSequenceDialog
    // owns the destination picker + enroll call; unified-view-layout intercepts
    // this id before the bulk API (enrollment has per-contact skip reasons the
    // generic bulk endpoint can't express).
    { id: 'add_to_sequence', label: 'Add to sequence...', icon: 'Send' },
    { id: 'delete', label: 'Delete', icon: 'Trash2', destructive: true },
  ],
  company: [
    { id: 'add_tags', label: 'Add tags...', icon: 'Tag', requiresValue: true, valueType: 'tags' },
    { id: 'delete', label: 'Delete', icon: 'Trash2', destructive: true },
  ],
  document: [
    { id: 'set_project', label: 'Move to project...', icon: 'Folder', requiresValue: true, valueType: 'project' },
    { id: 'pin', label: 'Pin', icon: 'Pin' },
    { id: 'unpin', label: 'Unpin', icon: 'PinOff' },
    { id: 'archive', label: 'Archive', icon: 'Archive' },
    { id: 'delete', label: 'Delete', icon: 'Trash2', destructive: true },
  ],
  initiative: [
    { id: 'change_status', label: 'Change status...', icon: 'Circle', requiresValue: true, valueType: 'status', shortcut: 'S' },
    { id: 'set_owner', label: 'Set owner...', icon: 'User', requiresValue: true, valueType: 'member' },
    { id: 'add_labels', label: 'Add labels...', icon: 'Tag', requiresValue: true, valueType: 'labels', shortcut: 'L' },
    { id: 'delete', label: 'Delete', icon: 'Trash2', destructive: true },
  ],
  project: [
    { id: 'change_status', label: 'Change status...', icon: 'Circle', requiresValue: true, valueType: 'status', shortcut: 'S' },
    { id: 'set_lead', label: 'Set lead...', icon: 'User', requiresValue: true, valueType: 'member' },
    { id: 'set_initiative', label: 'Set initiative...', icon: 'Target', requiresValue: true, valueType: 'initiative' },
    { id: 'add_labels', label: 'Add labels...', icon: 'Tag', requiresValue: true, valueType: 'labels', shortcut: 'L' },
    { id: 'archive', label: 'Archive', icon: 'Archive' },
    { id: 'delete', label: 'Delete', icon: 'Trash2', destructive: true },
  ],
  email_thread: [
    { id: 'move_to_folder', label: 'Move to folder...', icon: 'FolderInput', requiresValue: true, valueType: 'folder' },
    { id: 'mark_read', label: 'Mark as read', icon: 'MailOpen' },
    { id: 'mark_unread', label: 'Mark as unread', icon: 'Mail' },
    { id: 'star', label: 'Star', icon: 'Star' },
    { id: 'unstar', label: 'Unstar', icon: 'StarOff' },
    { id: 'delete', label: 'Delete', icon: 'Trash2', destructive: true },
  ],
  flow: [
    { id: 'delete', label: 'Delete', icon: 'Trash2', destructive: true },
  ],
  sequence: [
    // Archive, NOT delete — sequences refuse hard deletion (the send ledger
    // is history; the single-record DELETE route 400s with 'archive_instead').
    // Destructive because archiving exits every active enrollment.
    { id: 'archive', label: 'Archive', icon: 'Archive', destructive: true },
  ],
  // Delete, and only delete. The dialog that owns it
  // (prospect-list-delete-dialog.tsx, intercepted in unified-view-layout like
  // the company cascade) says what goes and what stays: the list, its
  // candidates and its runs go; companies and people already published to the
  // CRM stay and merely leave the list's group; dismissed candidates may be
  // found again. It never reaches the GENERIC bulk endpoint — each list goes
  // through its own DELETE route, which refuses a list with a run in flight.
  //
  // No `archive`: the generic bulk endpoint's 'archive' case writes
  // `is_archived`, which prospect_list does not have (it has `status`).
  prospect_list: [{ id: 'delete', label: 'Delete', icon: 'Trash2', destructive: true }],
  // NO 'delete' — an entry IS the workspace's suppression record; deleting it
  // would make a rejected candidate re-discoverable on the next run. Removing
  // one from a list is `dismiss` (stage='dismissed'), which keeps suppressing.
  //
  // Neither of these reaches the GENERIC bulk API. Both need per-row outcomes
  // the `{success, failed}` response shape cannot express — save reports
  // created / already_in_crm / no_email per entry, and dismiss must collect a
  // REASON first (two of which suppress workspace-wide). So both are
  // registered WITHOUT `requiresValue`, and list-detail.tsx intercepts them
  // before the bulk endpoint, the way unified-view-layout already does for
  // 'move_to_workspace' and 'add_to_sequence'.
  //
  // NO 'add_to_sequence' either, yet. unified-view-layout's existing intercept
  // hands the selected ids straight to the sequence-enrollment dialog, which
  // reads them as CONTACT ids — but a selection here is prospect ENTRY ids, and
  // most entries have no contact at all until they are saved. Registering it
  // now would render a live control that enrolls the wrong rows. It lands in
  // PR 6 together with the entry→contact translation and the per-row `no_email`
  // disabling §8 requires.
  prospect_list_entry: [
    { id: 'save_to_crm', label: 'Add to CRM', icon: 'UserPlus' },
    { id: 'dismiss', label: 'Dismiss...', icon: 'X', destructive: true },
  ],
  eval_suite: [
    // Delete, not archive: a suite has no archived state, and migration 252
    // cascades the delete to its cases, their template captures and the whole
    // run history — which is why the bulk route mirrors the single-record
    // DELETE (live-run refusal + template-capture cleanup) rather than issuing
    // a bare row delete.
    { id: 'delete', label: 'Delete', icon: 'Trash2', destructive: true },
  ],
  eval_case: [
    // Delete only, same as the suite. The bulk route mirrors the single-record
    // DELETE (/api/account/evals/cases/[id]) — the cascade takes the trials
    // but NOT the case's template capture, which needs its own cleanup or it
    // is left behind as an `is_eval` capture nothing lists.
    { id: 'delete', label: 'Delete', icon: 'Trash2', destructive: true },
  ],
  // A RUN HAS NO BULK ACTIONS AT ALL, and no DELETE route to give it one. A
  // run is the record of what a prompt scored at a moment; deleting it deletes
  // the evidence behind every comparison that cites it. Cancelling a live run
  // is a different verb, and it lives on the run rail where the run is.
  eval_run: [],
  // The review queue's two verbs, on a selection. NO 'delete': a claim is not
  // deleted, it is dismissed — and even that is reversible, because dismissal
  // is a judgement about a statement, not the removal of the evidence behind
  // it. Hard deletion belongs to the capture or document the claim was learned
  // from, which has its own teardown RPC (see the delete case in
  // /api/account/bulk).
  claim: [
    { id: 'confirm_claim', label: 'Confirm', icon: 'Check' },
    { id: 'dismiss_claim', label: 'Dismiss', icon: 'X' },
  ],
  // A table's rows change through its own grid and batch route.
  data_row: [],
}

// ── API request/response types ─────────────────────────────

export interface BulkActionRequest {
  entity_type: ViewEntityType
  ids: string[]
  action: BulkActionId
  value?: unknown
}

export interface BulkActionResponse {
  success: number
  failed: number
  errors?: string[]
}
