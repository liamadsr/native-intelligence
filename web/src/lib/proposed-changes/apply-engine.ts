import type { SupabaseClient } from '@supabase/supabase-js'
import { isAssignableTeammate, FOREIGN_AI_MEMBER_ERROR } from '@/lib/workspace-fences'
import { memberIdForUser } from '@/lib/actions/delegate'
import type { ProposedChange } from './types'
import { findBestActionMatch, resolveActionTarget } from './resolve-action-target'
import { callToolByServerId, McpTokenExpiredError } from '@/lib/mcp-client'
import { GITHUB_INTEGRATION_SERVER_ID } from '@/lib/mcp-client/github-server'
import { emitDecisionClaim } from '@/lib/ai/emit-decision-claim'
import { emitStatusChange } from '@/lib/flows/emit-status-change'
import type { StatusChangeOrigin } from '@/lib/flows/types'
import { findBestNameMatch } from '@/lib/people/name-match'
import { dueAtFromDate } from '@/lib/actions/due-at'
import { fetchAllRows } from '@/lib/supabase/paging'
import { HANDLED_COMBOS, normalizeProposedChange } from './appliable-combos'

export interface ApplyResult {
  success: boolean
  entity_id?: string
  error?: string
  /**
   * Optional machine-readable code so the UI can branch on specific
   * failure modes (e.g. surface a "Reconnect MCP server" CTA instead
   * of a generic toast when code === 'MCP_TOKEN_EXPIRED').
   */
  code?: string
  /**
   * Set when applyChange had to normalize the proposal's change_type before
   * dispatching (e.g. an `assign` with no target entity is applied as a
   * `create`). Callers persist this back onto the proposed_change row so its
   * whole lifecycle — undo eligibility, dismiss-deletes-entity, the action
   * button label — stays consistent with what actually happened.
   */
  applied_change_type?: ProposedChange['change_type']
  /**
   * Set alongside applied_change_type when the normalization ALSO moved the
   * entity_type (a target-less `assign:contact` is applied as `create:action`).
   * Persist it with applied_change_type so the row's entity_type matches the
   * entity that was actually created (undo/dismiss look the row up by it).
   */
  applied_entity_type?: ProposedChange['entity_type']
}

/**
 * Dispatches a proposed change to the appropriate mutation handler.
 * Each handler reuses existing Supabase logic to create/update/delete entities.
 */
export async function applyChange(
  supabase: SupabaseClient,
  change: ProposedChange,
  workspaceId: string,
  memberId: string,
  userId?: string,
  opts?: ApplyChangeOptions,
): Promise<ApplyResult> {
  // Normalize a structurally-impossible proposal before dispatch. The rules
  // live in appliable-combos.normalizeProposedChange (shared with staging and
  // the card layer so all three agree):
  //   • target-less `assign` of ANY entity_type → create:action. The agent
  //     proposes `assign:action` for a task it only described in conversation,
  //     and `assign:contact` for a follow-up ABOUT a person ("connect with
  //     Nikhil's son") — neither has an entity_id to re-point, and both already
  //     carry title/assignee/priority: a create satisfies the intent.
  //   • target-less `update:decision` → create:decision. The extractor stages
  //     it when a decision is confirmed or refined mid-meeting but never
  //     resolves a decision UUID; recording it satisfies the intent.
  // Report the rewrite so the caller persists it (keeps undo/dismiss/label
  // consistent with what actually happened).
  const normalized = normalizeProposedChange(change)
  let effective = change
  let appliedChangeType: ProposedChange['change_type'] | undefined
  let appliedEntityType: ProposedChange['entity_type'] | undefined
  if (normalized.changed) {
    effective = {
      ...change,
      change_type: normalized.change_type as ProposedChange['change_type'],
      entity_type: normalized.entity_type as ProposedChange['entity_type'],
    }
    appliedChangeType = effective.change_type
    if (effective.entity_type !== change.entity_type) appliedEntityType = effective.entity_type
  }

  const key = `${effective.change_type}:${effective.entity_type}`

  const handler = handlers[key]
  if (!handler) {
    return { success: false, error: `Unsupported change: ${key}` }
  }

  try {
    const result = await handler(supabase, effective, workspaceId, memberId, userId, opts?.origin)
    return appliedChangeType && result.success
      ? {
          ...result,
          applied_change_type: appliedChangeType,
          ...(appliedEntityType ? { applied_entity_type: appliedEntityType } : {}),
        }
      : result
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}

type Handler = (
  supabase: SupabaseClient,
  change: ProposedChange,
  workspaceId: string,
  memberId: string,
  userId?: string,
  origin?: StatusChangeOrigin,
) => Promise<ApplyResult>

/** Options an applyChange caller may pass. */
export interface ApplyChangeOptions {
  /** Who this apply is, for the status-change loop guard (flows/types.ts).
   *  Absent → a person at depth 0. */
  origin?: StatusChangeOrigin
}

// ─── Handlers ────────────────────────────────────────────────

const handlers: Record<string, Handler> = {
  'create:action': createAction,
  'create:decision': createDecision,
  'create:contact': createContact,
  'create:milestone': createMilestone,
  'update:project': updateProject,
  'update:action': updateAction,
  'update:decision': updateDecision,
  'update:contact': updateContact,
  'update:milestone': updateMilestone,
  'assign:action': assignAction,
  'delete:action': deleteAction,
  'delete:milestone': deleteMilestone,
  'send_email:action': sendEmail,
  'send_email:contact': sendEmail,
  // Triage's outreach draft cards (verdict-apply.ts) stage a draft to someone
  // outside the board. sendEmail only reads the email_* fields, so the
  // recipient being "external" changes nothing about the draft it writes.
  'send_email:external': sendEmail,
  'mcp_call:external': mcpCall,
}

// ─── Systemic drift guard ────────────────────────────────────
//
// The extraction schema (propose_change in src/lib/live-agent/tools.ts) can
// PRODUCE any change_type ×
// entity_type combo, but the apply engine only KNOWS how to execute the combos in
// `handlers` (plus the normalized ones). When those sets drift apart, extraction
// stages a proposal whose card renders a one-click Accept that can only ever
// dead-end on "Unsupported change: …" — the exact prod outage this PR fixes.
//
// `canApplyChange` is the single source of truth for "can this combo be applied
// at all". It lives in the client-safe appliable-combos module (no server imports)
// so the 'use client' card layer can call it without dragging the MCP SDK + crypto
// into the client bundle; we re-export it here so apply-engine stays the obvious
// place to find it. The HANDLED_COMBOS data list must stay in lockstep with the
// runtime `handlers` map above — the assertion below fails fast (at module load,
// surfaced by any test that imports apply-engine) if they ever drift.
export { canApplyChange } from './appliable-combos'

if (process.env.NODE_ENV !== 'production') {
  const runtimeKeys = new Set(Object.keys(handlers))
  const declared = HANDLED_COMBOS
  const missingFromList = [...runtimeKeys].filter((k) => !declared.has(k))
  const extraInList = [...declared].filter((k) => !runtimeKeys.has(k))
  if (missingFromList.length || extraInList.length) {
    throw new Error(
      `apply-engine handlers ↔ HANDLED_COMBOS drift. ` +
        `In handlers but not the list: [${missingFromList.join(', ')}]. ` +
        `In the list but no handler: [${extraInList.join(', ')}]. ` +
        `Keep src/lib/proposed-changes/appliable-combos.ts in sync with the handlers map.`,
    )
  }
}

// ─── Workflow-state resolution ───────────────────────────────

/**
 * Resolve the workflow state a proposal-created action should land in.
 * `statusName` (when given) matches by name case-insensitively; otherwise the
 * team's first backlog-category state, then first unstarted. Null when the
 * team has no matching states at all.
 */
async function resolveTeamStatusId(
  supabase: SupabaseClient,
  teamId: string,
  statusName?: string | null,
): Promise<string | null> {
  const { data } = await supabase
    .from('workflow_state')
    .select('id, name, category, sort_order')
    .eq('team_id', teamId)
    .order('sort_order', { ascending: true })

  const states = (data ?? []) as Array<{ id: string; name: string; category: string }>
  if (states.length === 0) return null

  const wanted = statusName?.trim().toLowerCase()
  if (wanted) {
    const byName = states.find((s) => s.name.toLowerCase() === wanted)
    if (byName) return byName.id
  }
  const firstOf = (category: string) => states.find((s) => s.category === category)
  return (firstOf('backlog') ?? firstOf('unstarted'))?.id ?? null
}

// ─── Create action ───────────────────────────────────────────

async function createAction(
  supabase: SupabaseClient,
  change: ProposedChange,
  workspaceId: string,
  memberId: string,
  userId?: string,
): Promise<ApplyResult> {
  // Resolve team — fall back to workspace default if not set
  let teamId = change.team_id
  if (!teamId) {
    const { data: defaultTeam } = await supabase
      .from('team')
      .select('id')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: true })
      .limit(1)
      .single()
    teamId = defaultTeam?.id || null
  }

  // Resolve workflow state. An explicit status_to (staged by the extractor or
  // passed as an accept-time override) wins, matched by name case-insensitively.
  // Otherwise default to the team's first BACKLOG-category state, falling back
  // to first unstarted. Landing in backlog instead of the first unstarted state
  // (usually Todo) matters: workspaces hang status-change automations off Todo
  // (e.g. a Todo→coding-agent webhook), so parking every accepted extraction
  // there left each one a single touch away from firing an agent.
  let statusId: string | null = null
  if (teamId) {
    statusId = await resolveTeamStatusId(supabase, teamId, change.status_to)
  }

  // An agent assignee may arrive as an explicit field or in the extra overflow
  // (proposed_change has no dedicated column yet). When present it is the
  // DELEGATE (decision 9, src/lib/actions/delegate.ts): the person stays
  // responsible — the proposal's member assignee, else the person applying it.
  const aiMemberId =
    change.assignee_ai_member_id ||
    (change.extra?.assignee_ai_member_id as string | undefined) ||
    null
  // A proposal (model- or extraction-authored, or a client edit riding in
  // `extra`) may name any teammate id; only this workspace's teammates apply.
  if (aiMemberId && !(await isAssignableTeammate(supabase, aiMemberId, workspaceId))) {
    return { success: false, error: FOREIGN_AI_MEMBER_ERROR }
  }

  const responsibleMemberId = change.assignee_member_id || (aiMemberId ? memberId || null : null)

  const insert: Record<string, unknown> = {
    workspace_id: workspaceId,
    title: change.title || change.display_text,
    description: change.description || null,
    priority: change.priority || 'none',
    due_at: dueAtFromDate(change.due_date) || null,
    assignee_id: responsibleMemberId,
    // External (CRM) assignee lives in its own column — one source of truth
    // for "who owns this". Mutually exclusive with a member/agent assignee.
    assignee_contact_id:
      aiMemberId || change.assignee_member_id ? null : change.assignee_contact_id || null,
    assignee_ai_member_id: aiMemberId,
    team_id: teamId,
    project_id: change.project_id || null,
    status_id: statusId,
    // The BEFORE INSERT trigger generate_action_identifier (migrations 022/221)
    // bumps team.issue_counter and overwrites this; the placeholder only stands
    // when there is no team. Bumping the counter here too skipped a number.
    identifier: `TEMP-${Date.now()}`,
    source_capture_id: change.capture_id,
    confirmation: 'confirmed',
    ai_confidence: change.confidence,
    // Stamped atomically with creation when a caller auto-applied this change
    // (live-agent confidence policy), so the action is never briefly applied
    // without its audit flag. Defaults false for manual applies.
    auto_accepted: change.auto_accepted ?? false,
    context_data: {
      trigger_quote: change.trigger_quote,
      reasoning: change.reasoning,
      stakes: change.stakes,
      open_questions: change.open_questions,
      original_owner: change.assignee_name,
    },
    user_id: userId || memberId,
  }

  const { data, error } = await supabase
    .from('actions')
    .insert(insert)
    .select('id')
    .single()

  if (error) return { success: false, error: error.message }

  // Sync action_assignee join table (people only — the delegate agent rides in
  // assignee_ai_member_id).
  if (responsibleMemberId) {
    await supabase.from('action_assignee').insert({ action_id: data.id, member_id: responsibleMemberId })
  }

  // Attach labels if provided
  if (change.labels && change.labels.length > 0) {
    await supabase.from('action_label').insert(
      change.labels.map((labelId) => ({ action_id: data.id, label_id: labelId })),
    )
  }

  return { success: true, entity_id: data.id }
}

// ─── Create decision ─────────────────────────────────────────

async function createDecision(
  supabase: SupabaseClient,
  change: ProposedChange,
  workspaceId: string,
  memberId: string,
  userId?: string,
): Promise<ApplyResult> {
  const content = change.title || change.display_text

  const { data, error } = await supabase
    .from('decision')
    .insert({
      capture_id: change.capture_id,
      content,
      confirmation: 'confirmed',
      // Stamped when a caller auto-applied this (live-agent confidence policy),
      // so the UI can distinguish auto-accepted from manually-confirmed.
      auto_accepted: change.auto_accepted ?? false,
      // decision.decided_by is a uuid FK to member(id), not free text — use
      // the resolved member id (null when unresolved). Writing assignee_name
      // here would fail the uuid cast and drop the decider.
      decided_by: change.assignee_member_id || null,
    })
    .select('id')
    .single()

  if (error) return { success: false, error: error.message }

  // Mirror the decision into the knowledge graph (additive, best-effort).
  // A proposed change being applied means the user accepted it — confirm.
  void emitDecisionClaim({
    supabase,
    workspaceId,
    memberId,
    userId,
    text: content,
    captureId: change.capture_id,
    projectId: change.project_id,
    confirmation: 'confirmed',
  })

  return { success: true, entity_id: data.id }
}

// ─── Update decision ─────────────────────────────────────────
//
// Only reached with a real entity_id — a target-less update:decision is
// normalized to create:decision in applyChange() (see the normalization block),
// so this handler never has to invent a target. `decision` has no workspace_id
// column (it's scoped through capture), so we fence by resolving the row's
// capture and checking that capture's workspace, mirroring updateAppliedEntity's
// decision path. The editable body is `content`; confirming an update means the
// user accepted a refined decision, so we mark it confirmed and re-mirror it
// into the knowledge graph (best-effort, same as createDecision).

async function updateDecision(
  supabase: SupabaseClient,
  change: ProposedChange,
  workspaceId: string,
  memberId: string,
  userId?: string,
): Promise<ApplyResult> {
  const entityId = change.entity_id
  if (!entityId) return { success: false, error: 'Entity ID required for decision update' }

  // Fence: the decision must belong to a capture in this workspace. decision has
  // no workspace_id, so verify through the capture (mirrors the milestones route
  // fencing pattern).
  const { data: existing } = await supabase
    .from('decision')
    .select('id, capture_id, capture:capture_id(workspace_id)')
    .eq('id', entityId)
    .maybeSingle()
  const cap = existing?.capture as unknown as { workspace_id: string } | null
  if (!existing || cap?.workspace_id !== workspaceId) {
    return { success: false, error: 'Decision not found in this workspace' }
  }

  const content = change.title || change.display_text

  const updates: Record<string, unknown> = { confirmation: 'confirmed' }
  if (content) updates.content = content
  if (change.assignee_member_id) updates.decided_by = change.assignee_member_id

  const { error } = await supabase
    .from('decision')
    .update(updates)
    .eq('id', entityId)

  if (error) return { success: false, error: error.message }

  // Re-mirror the confirmed decision into the knowledge graph (additive,
  // best-effort). emitDecisionClaim dedupes on text + capture cite, so a decision
  // whose wording didn't change won't spawn a duplicate claim.
  if (content) {
    void emitDecisionClaim({
      supabase,
      workspaceId,
      memberId,
      userId,
      text: content,
      captureId: existing.capture_id as string,
      projectId: change.project_id,
      confirmation: 'confirmed',
    })
  }

  return { success: true, entity_id: entityId }
}

// ─── Create contact ──────────────────────────────────────────
//
// This workspace hit a contact-dedup incident (mig 132 / calendar-email
// corruption), so a create MUST NOT blindly insert. We resolve an existing
// contact first — by email when the proposal carries one, else by exact/unique
// name via the same fuzzy matcher members/contacts use — and apply as an
// update/merge on a unique hit rather than spawning a duplicate. Only when no
// existing contact resolves do we insert. Zero DDL: writes only pre-existing
// columns (full_name/first_name/last_name/email/notes/relationship_type).

/** The proposal's descriptive text folded into the contact's notes surface. */
function contactNoteFromChange(change: ProposedChange): string | null {
  const note = change.description || change.display_text
  return note && note.trim() ? note.trim() : null
}

/** Contact email carried by the proposal, if any (overflow-only today — there is
 *  no dedicated column). Lowercased; must look like an address. */
function contactEmailFromChange(change: ProposedChange): string | null {
  const raw =
    (change.extra?.email as string | undefined) ||
    (change.extra?.contact_email as string | undefined) ||
    null
  const email = raw?.trim().toLowerCase() || null
  return email && email.includes('@') ? email : null
}

async function createContact(
  supabase: SupabaseClient,
  change: ProposedChange,
  workspaceId: string,
  memberId: string,
): Promise<ApplyResult> {
  const fullName = (change.title || change.assignee_name || change.display_text || '').trim()
  const email = contactEmailFromChange(change)
  if (!fullName && !email) {
    return { success: false, error: 'Contact needs at least a name or an email' }
  }
  const note = contactNoteFromChange(change)

  // Dedup guard 1: exact email match (the strongest identity signal). Never
  // resolve to a merged-away tombstone.
  if (email) {
    const { data: byEmail } = await supabase
      .from('contact')
      .select('id')
      .eq('workspace_id', workspaceId)
      .is('merged_into_contact_id', null)
      .eq('email', email)
      .limit(1)
      .maybeSingle()
    if (byEmail) {
      return applyContactEnrichment(supabase, byEmail.id as string, workspaceId, note)
    }
  }

  // Dedup guard 2: unique name match via the shared fuzzy matcher. requireUnambiguous
  // so two people with the same first name don't collapse into one — an ambiguous
  // or absent match falls through to a fresh insert.
  if (fullName) {
    const match = await resolveUniqueContactByName(supabase, workspaceId, fullName)
    if (match) {
      return applyContactEnrichment(supabase, match, workspaceId, note)
    }
  }

  const nameParts = fullName.split(' ')
  const { data, error } = await supabase
    .from('contact')
    .insert({
      workspace_id: workspaceId,
      created_by_member_id: memberId,
      visibility: 'private',
      full_name: fullName || email,
      first_name: nameParts[0] || null,
      last_name: nameParts.slice(1).join(' ') || null,
      email,
      notes: note,
      relationship_type: 'contact',
      // contact.source has a CHECK constraint (migrations 033 + 091):
      // ('manual','email_sync','calendar_sync','capture_participant','csv_import',
      // 'member'). 'capture_participant' is the closest fit for a contact born
      // from a capture's extraction — any value outside that set fails the CHECK
      // and turns every genuinely-new-contact accept into a 500.
      source: 'capture_participant',
    })
    .select('id')
    .single()

  if (error) return { success: false, error: error.message }
  return { success: true, entity_id: data.id }
}

// ─── Update contact ──────────────────────────────────────────
//
// entity_id present → fenced update. entity_id null → resolve by contact name
// via the shared fuzzy matcher (requireUnambiguous); a unique hit updates, a zero
// or ambiguous match returns an honest CONTACT_TARGET_UNRESOLVED instead of the
// generic "Unsupported change". "Update" here means folding the proposal's
// display_text/description into the contact's notes surface — the CRM's existing
// context column — never inventing schema.

async function updateContact(
  supabase: SupabaseClient,
  change: ProposedChange,
  workspaceId: string,
  _memberId: string,
): Promise<ApplyResult> {
  let entityId = change.entity_id

  if (!entityId) {
    const name = (change.title || change.assignee_name || change.display_text || '').trim()
    if (!name) {
      return {
        success: false,
        code: 'CONTACT_TARGET_UNRESOLVED',
        error: 'Could not find a unique contact to update (the proposal names no one).',
      }
    }
    const match = await resolveUniqueContactByName(supabase, workspaceId, name)
    if (!match) {
      return {
        success: false,
        code: 'CONTACT_TARGET_UNRESOLVED',
        error: `Could not find a unique contact named "${name}".`,
      }
    }
    entityId = match
    // Persist the resolution so the proposal row names its real target
    // (best-effort — the apply itself is what matters).
    await supabase.from('proposed_change').update({ entity_id: entityId }).eq('id', change.id)
  }

  const note = contactNoteFromChange(change)
  return applyContactEnrichment(supabase, entityId, workspaceId, note)
}

/**
 * Fold an enrichment note into a contact's `notes` column (append, don't clobber
 * prior context), workspace-fenced. Shared by create-dedup-merge and update.
 * A null/empty note is a no-op success — the contact already exists and there is
 * nothing new to record.
 */
async function applyContactEnrichment(
  supabase: SupabaseClient,
  contactId: string,
  workspaceId: string,
  note: string | null,
): Promise<ApplyResult> {
  if (!note) return { success: true, entity_id: contactId }

  const { data: existing } = await supabase
    .from('contact')
    .select('id, notes')
    .eq('id', contactId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (!existing) return { success: false, error: 'Contact not found in this workspace' }

  const prior = (existing.notes as string | null)?.trim() || ''
  // Don't append a note that's already present verbatim (re-applying the same
  // proposal, or a create-merge that lands on the note it would have written).
  const nextNotes = prior.includes(note) ? prior : prior ? `${prior}\n${note}` : note

  const { error } = await supabase
    .from('contact')
    .update({ notes: nextNotes, updated_at: new Date().toISOString() })
    .eq('id', contactId)
    .eq('workspace_id', workspaceId)

  if (error) return { success: false, error: error.message }
  return { success: true, entity_id: contactId }
}

/**
 * Resolve a free-text name to a SINGLE workspace contact id, or null when the
 * match is absent or ambiguous. Uses the shared tiered fuzzy matcher with
 * requireUnambiguous — the same guard member resolution uses — so a name shared
 * by two contacts never silently picks one (the dedup-incident hazard). Skips
 * merged-away tombstones.
 */
async function resolveUniqueContactByName(
  supabase: SupabaseClient,
  workspaceId: string,
  name: string,
): Promise<string | null> {
  // Every contact, paged: a response stops at 1000 rows, and the ambiguity
  // guard is only sound when it sees every same-named contact.
  const { data: contacts, error } = await fetchAllRows(
    () =>
      supabase
        .from('contact')
        .select('id, full_name')
        .eq('workspace_id', workspaceId)
        .is('merged_into_contact_id', null)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true }),
    { orderBy: null },
  )
  if (error || !contacts.length) return null
  const match = findBestNameMatch(
    contacts.map((c) => ({ id: c.id as string, name: (c.full_name as string | null) ?? null })),
    name,
    { requireUnambiguous: true },
  )
  return match?.id ?? null
}

// ─── Create milestone ────────────────────────────────────────

async function createMilestone(
  supabase: SupabaseClient,
  change: ProposedChange,
  _workspaceId: string,
  _memberId: string,
): Promise<ApplyResult> {
  if (!change.project_id) return { success: false, error: 'Project ID required for milestone' }

  const { data, error } = await supabase
    .from('milestone')
    .insert({
      project_id: change.project_id,
      name: change.title || change.display_text,
      description: change.description || null,
      target_date: change.due_date || null,
      status: 'pending',
    })
    .select('id')
    .single()

  if (error) return { success: false, error: error.message }
  return { success: true, entity_id: data.id }
}

// ─── Update project ──────────────────────────────────────────

async function updateProject(
  supabase: SupabaseClient,
  change: ProposedChange,
  workspaceId: string,
  _memberId: string,
): Promise<ApplyResult> {
  const entityId = change.entity_id
  if (!entityId) return { success: false, error: 'Entity ID required for project update' }

  const updates: Record<string, unknown> = {}
  if (change.status_to) updates.status = change.status_to
  if (change.title) updates.name = change.title
  if (change.description) updates.description = change.description
  if (change.due_date) updates.target_date = change.due_date
  if (change.assignee_member_id) updates.lead_id = change.assignee_member_id

  const hasLabels = change.labels !== null && change.labels !== undefined
  if (Object.keys(updates).length === 0 && !hasLabels) {
    return { success: false, error: 'No fields to update' }
  }

  // entity_id is model-supplied: fence it to the workspace before any write
  // (the project_label writes below are keyed on the id alone).
  const { data: project, error: readErr } = await supabase
    .from('projects')
    .select('id')
    .eq('id', entityId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (readErr) return { success: false, error: readErr.message }
  if (!project) return { success: false, error: 'Project not found in this workspace' }

  if (Object.keys(updates).length > 0) {
    const { error } = await supabase
      .from('projects')
      .update(updates)
      .eq('id', entityId)
      .eq('workspace_id', workspaceId)

    if (error) return { success: false, error: error.message }
  }

  // Replace labels if provided (null/undefined = keep existing, [] = remove
  // all, [...] = replace). Mirrors updateAction's label handling.
  if (hasLabels) {
    await supabase.from('project_label').delete().eq('project_id', entityId)
    if (change.labels!.length > 0) {
      await supabase.from('project_label').insert(
        change.labels!.map((labelId) => ({ project_id: entityId, label_id: labelId })),
      )
    }
  }

  return { success: true, entity_id: entityId }
}

// ─── Update action ───────────────────────────────────────────

async function updateAction(
  supabase: SupabaseClient,
  change: ProposedChange,
  workspaceId: string,
  _memberId: string,
  userId?: string,
  origin?: StatusChangeOrigin,
): Promise<ApplyResult> {
  let entityId = change.entity_id
  if (!entityId) {
    // The extractor stages update:action proposals without a target almost
    // always (it hears the task, never its UUID). Staging-time resolution in
    // propose_change covers most of these, but proposals staged before it —
    // or whose target action was only created later in the same batch —
    // arrive here with entity_id still null. Resolve now rather than hard-fail.
    const target = await resolveActionTarget(supabase, workspaceId, {
      title: change.title,
      displayText: change.display_text,
      projectId: change.project_id,
      teamId: change.team_id,
    })
    if (!target) {
      return {
        success: false,
        error:
          'Could not determine which action this update targets. Set the target action on the proposal and retry.',
        code: 'UPDATE_TARGET_UNRESOLVED',
      }
    }
    entityId = target.id
    // Persist the resolution so the proposal row names its real target
    // (best-effort — the apply itself is what matters).
    await supabase
      .from('proposed_change')
      .update({ entity_id: entityId })
      .eq('id', change.id)
  } else {
    // A proposal-supplied entity_id is model-supplied: fence it to the
    // workspace before any write (the action_assignee / action_label writes
    // below are keyed on the id alone). The resolver above is already fenced.
    const { data: target, error: readErr } = await supabase
      .from('actions')
      .select('id')
      .eq('id', entityId)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    if (readErr) return { success: false, error: readErr.message }
    if (!target) return { success: false, error: 'Action not found in this workspace' }
  }

  const updates: Record<string, unknown> = {}
  if (change.title) {
    // An update proposal's title usually RE-DESCRIBES the target ("Update API
    // docs") rather than renaming it — that same text is what target
    // resolution matches on. Blindly applying it would overwrite the action's
    // real title with the transcript's paraphrase. Only treat it as a rename
    // when it does NOT read as a reference to the action's current title.
    const { data: current } = await supabase
      .from('actions')
      .select('id, title, identifier')
      .eq('id', entityId)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    const currentRow = current as { id: string; title: string | null; identifier: string | null } | null
    const titleIsReference = currentRow
      ? !!findBestActionMatch([currentRow], [change.title]).match
      : false
    if (!titleIsReference) updates.title = change.title
  }
  if (change.description) updates.description = change.description
  if (change.priority) updates.priority = change.priority
  if (change.due_date) updates.due_at = dueAtFromDate(change.due_date)
  // Moving an action to another project is explicit (a suggestion's
  // extra.move_to_project_id, src/lib/suggestions/stage.ts). change.project_id
  // on an update is the extractor's context (the capture's project), never a
  // move, so it is not read here. Fenced to the workspace like the update.
  const moveTo = (change.extra as Record<string, unknown> | null)?.move_to_project_id
  if (typeof moveTo === 'string' && moveTo) {
    const { data: project } = await supabase
      .from('projects')
      .select('id')
      .eq('id', moveTo)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    if (!project) return { success: false, error: 'That project is not in this workspace' }
    updates.project_id = moveTo
  }
  if (change.assignee_member_id) {
    updates.assignee_id = change.assignee_member_id
    updates.assignee_contact_id = null
    // Sync join table
    await supabase.from('action_assignee').delete().eq('action_id', entityId)
    await supabase.from('action_assignee').insert({ action_id: entityId, member_id: change.assignee_member_id })
  } else if (change.assignee_contact_id) {
    // Handing the action to an external contact clears any member assignee
    // (and its join rows) — the two columns are mutually exclusive.
    updates.assignee_contact_id = change.assignee_contact_id
    updates.assignee_id = null
    await supabase.from('action_assignee').delete().eq('action_id', entityId)
  }

  // Status change requires resolving workflow state (case-insensitive by
  // name — the extractor writes whatever casing it heard). No category
  // fallback here: a status UPDATE must hit the named state or leave the
  // status alone.
  //
  // The FROM status is captured here (before the write) because the
  // status-change trigger needs it — applying a proposal is a status writer
  // like any other, and used to skip the emit entirely, so Flows (and now the
  // Asana echo) never fired for accepted proposals.
  let previousStatusId: string | null = null
  if (change.status_to && change.team_id) {
    const { data } = await supabase
      .from('workflow_state')
      .select('id, name')
      .eq('team_id', change.team_id)
    const wanted = change.status_to.trim().toLowerCase()
    const state = ((data ?? []) as Array<{ id: string; name: string }>).find(
      (s) => s.name.toLowerCase() === wanted,
    )
    if (state) {
      const { data: currentRow, error: readErr } = await supabase
        .from('actions')
        .select('status_id')
        .eq('id', entityId)
        .eq('workspace_id', workspaceId)
        .maybeSingle()
      // A failed snapshot read must FAIL the apply, exactly like a failed write
      // below. Swallowing it defaults `from` to null, which the emit reads as a
      // real transition out of "no status" — firing flows scoped to a from-state
      // that never happened and telling the Asana echo the wrong story. Better
      // to leave the action untouched and let the caller retry.
      if (readErr) return { success: false, error: readErr.message }
      previousStatusId = (currentRow?.status_id as string | null) ?? null
      updates.status_id = state.id
    }
  }

  if (Object.keys(updates).length === 0 && !change.labels) {
    return { success: false, error: 'No fields to update' }
  }

  if (Object.keys(updates).length > 0) {
    const { error } = await supabase
      .from('actions')
      .update(updates)
      .eq('id', entityId)
      .eq('workspace_id', workspaceId)

    if (error) return { success: false, error: error.message }

    // Fire the status-change trigger when this apply actually moved the action
    // into a new status — the shared emit every status writer funnels through
    // (GEN-112). Fire-and-forget; self-guards on unchanged status / no team.
    // `userId` is the auth.users id (memberId is the workspace-scoped profile),
    // and it's optional on the handler signature, so an apply invoked without
    // one simply doesn't attribute an actor.
    if (updates.status_id !== undefined && userId) {
      emitStatusChange({
        entityType: 'action',
        entityId,
        workspaceId,
        teamId: change.team_id,
        fromStatusId: previousStatusId,
        toStatusId: updates.status_id as string,
        actorUserId: userId,
        origin,
      })
    }
  }

  // Replace labels if provided (null = keep existing, [] = remove all, [...] = replace)
  if (change.labels !== null && change.labels !== undefined) {
    await supabase.from('action_label').delete().eq('action_id', entityId)
    if (change.labels.length > 0) {
      await supabase.from('action_label').insert(
        change.labels.map((labelId) => ({ action_id: entityId, label_id: labelId })),
      )
    }
  }

  return { success: true, entity_id: entityId }
}

// ─── Update milestone ────────────────────────────────────────

/**
 * milestone has no workspace_id column: a milestone is in the workspace when
 * its project is. Returns an error message when it is not (or the read
 * failed), null when it is.
 */
async function milestoneFenceError(
  supabase: SupabaseClient,
  milestoneId: string,
  workspaceId: string,
): Promise<string | null> {
  const { data: row, error } = await supabase
    .from('milestone')
    .select('id, project:project_id(workspace_id)')
    .eq('id', milestoneId)
    .maybeSingle()
  if (error) return error.message
  const proj = row?.project as unknown as { workspace_id: string } | null
  if (!row || proj?.workspace_id !== workspaceId) return 'Milestone not found in this workspace'
  return null
}

async function updateMilestone(
  supabase: SupabaseClient,
  change: ProposedChange,
  workspaceId: string,
  _memberId: string,
): Promise<ApplyResult> {
  const entityId = change.entity_id
  if (!entityId) return { success: false, error: 'Entity ID required for milestone update' }

  const updates: Record<string, unknown> = {}
  if (change.title) updates.name = change.title
  if (change.description) updates.description = change.description
  if (change.due_date) updates.target_date = change.due_date
  if (change.status_to) updates.status = change.status_to

  if (Object.keys(updates).length === 0) {
    return { success: false, error: 'No fields to update' }
  }

  const fenceError = await milestoneFenceError(supabase, entityId, workspaceId)
  if (fenceError) return { success: false, error: fenceError }

  const { error } = await supabase
    .from('milestone')
    .update(updates)
    .eq('id', entityId)

  if (error) return { success: false, error: error.message }
  return { success: true, entity_id: entityId }
}

// ─── Assign action ───────────────────────────────────────────

async function assignAction(
  supabase: SupabaseClient,
  change: ProposedChange,
  workspaceId: string,
  _memberId: string,
): Promise<ApplyResult> {
  const entityId = change.entity_id
  if (!entityId) return { success: false, error: 'Entity ID required for assignment' }
  // A member assignee wins; otherwise an external CRM contact may own the
  // action. The two columns are mutually exclusive, so the other is cleared.
  const memberId = change.assignee_member_id ?? null
  const contactId = memberId ? null : change.assignee_contact_id ?? null
  if (!memberId && !contactId) {
    return { success: false, error: 'Assignee member ID or contact ID required' }
  }

  const { error } = await supabase
    .from('actions')
    .update({ assignee_id: memberId, assignee_contact_id: contactId })
    .eq('id', entityId)
    .eq('workspace_id', workspaceId)

  if (error) return { success: false, error: error.message }

  // Sync join table — add the assignee (additive, doesn't clear existing).
  // Only members live in action_assignee; contacts have no join row.
  if (memberId) {
    await supabase.from('action_assignee')
      .upsert({ action_id: entityId, member_id: memberId }, { onConflict: 'action_id,member_id' })
  }

  return { success: true, entity_id: entityId }
}

// ─── Delete action ───────────────────────────────────────────

async function deleteAction(
  supabase: SupabaseClient,
  change: ProposedChange,
  workspaceId: string,
  _memberId: string,
): Promise<ApplyResult> {
  const entityId = change.entity_id
  if (!entityId) return { success: false, error: 'Entity ID required for deletion' }

  const { error } = await supabase
    .from('actions')
    .delete()
    .eq('id', entityId)
    .eq('workspace_id', workspaceId)

  if (error) return { success: false, error: error.message }
  return { success: true, entity_id: entityId }
}

// ─── Delete milestone ────────────────────────────────────────
//
// Mirrors deleteAction, but deletion is CONSERVATIVE: require entity_id OR an
// exact (case-insensitive) UNIQUE title match among the workspace's milestones —
// never a fuzzy match. Deleting the wrong milestone is unrecoverable, so an
// ambiguous or absent title returns MILESTONE_TARGET_UNRESOLVED rather than
// guessing. milestone has no workspace_id column, so we fence through the project.

interface MilestoneRow {
  id: string
  name: string | null
  project: { workspace_id: string } | null
}

async function deleteMilestone(
  supabase: SupabaseClient,
  change: ProposedChange,
  workspaceId: string,
  _memberId: string,
): Promise<ApplyResult> {
  let entityId = change.entity_id

  if (entityId) {
    // Fence a directly-targeted milestone to the workspace via its project.
    const { data: row } = await supabase
      .from('milestone')
      .select('id, project:project_id(workspace_id)')
      .eq('id', entityId)
      .maybeSingle()
    const proj = row?.project as unknown as { workspace_id: string } | null
    if (!row || proj?.workspace_id !== workspaceId) {
      return { success: false, error: 'Milestone not found in this workspace' }
    }
  } else {
    // Resolve by EXACT (case-insensitive) title — and only when it's unique.
    const wanted = (change.title || change.display_text || '').trim().toLowerCase()
    if (!wanted) {
      return {
        success: false,
        code: 'MILESTONE_TARGET_UNRESOLVED',
        error: 'Could not determine which milestone to delete (the proposal names none).',
      }
    }
    // Fenced to the workspace in SQL and paged: the uniqueness check below is
    // only safe (a wrong delete is unrecoverable) when it sees every milestone
    // of the workspace, not the first 1000 of the whole platform.
    const { data, error: readError } = await fetchAllRows(() =>
      supabase
        .from('milestone')
        .select('id, name, project:project_id!inner(workspace_id)')
        .eq('project.workspace_id', workspaceId),
    )
    if (readError) return { success: false, error: readError.message }
    const rows = ((data as unknown as MilestoneRow[]) ?? []).filter(
      (r) => r.project?.workspace_id === workspaceId,
    )
    const exact = rows.filter((r) => (r.name ?? '').trim().toLowerCase() === wanted)
    if (exact.length !== 1) {
      return {
        success: false,
        code: 'MILESTONE_TARGET_UNRESOLVED',
        error:
          exact.length === 0
            ? `Could not find a milestone titled "${change.title || change.display_text}".`
            : `Found more than one milestone titled "${change.title || change.display_text}" — delete it from the project instead.`,
      }
    }
    entityId = exact[0].id
  }

  const { error } = await supabase.from('milestone').delete().eq('id', entityId)
  if (error) return { success: false, error: error.message }
  return { success: true, entity_id: entityId }
}

// ─── MCP tool call (external) ────────────────────────────────

interface McpCallExtra {
  server_id?: string
  /**
   * user_id of the user who connected the MCP server when this proposal
   * was created. Apply-time checks that the applying user matches.
   * Lets us surface a "Reconnect" CTA instead of a generic failure when
   * the original connecting user is no longer in the workspace.
   */
  server_user_id?: string
  server_name?: string
  tool_name?: string
  args?: Record<string, unknown>
}

// 50KB cap on the JSON we persist into proposed_change.extra.result.
// Big enough for any reasonable Jira/Linear payload (typical ~5-15KB),
// small enough that proposed-change list endpoints stay snappy.
const MCP_RESULT_MAX_BYTES = 50_000

function truncateMcpResultForStorage(content: unknown): {
  value: unknown
  truncated: boolean
} {
  let json: string
  try {
    json = JSON.stringify(content)
  } catch {
    return { value: String(content).slice(0, MCP_RESULT_MAX_BYTES), truncated: true }
  }
  if (json.length <= MCP_RESULT_MAX_BYTES) return { value: content, truncated: false }
  // Past the cap: store a string preview rather than a corrupted JSON
  // fragment. Keeps the UI rendering safe — it can always show the
  // preview and a "truncated" indicator.
  return {
    value: `${json.slice(0, MCP_RESULT_MAX_BYTES)}\n…[truncated: payload exceeded ${MCP_RESULT_MAX_BYTES} bytes]`,
    truncated: true,
  }
}

async function mcpCall(
  supabase: SupabaseClient,
  change: ProposedChange,
  _workspaceId: string,
  _memberId: string,
  userId?: string,
): Promise<ApplyResult> {
  const extra = (change.extra ?? {}) as McpCallExtra
  const serverId = extra.server_id
  const toolName = extra.tool_name
  if (!serverId) return { success: false, error: 'extra.server_id missing on MCP proposal' }
  if (!toolName) return { success: false, error: 'extra.tool_name missing on MCP proposal' }
  // The GitHub integration's id names whoever applies it (callToolByServerId
  // builds it from the caller's own integration), and nothing proposes on it
  // (propose_mcp_call reads stored apps only): a proposal carrying it was
  // written by hand, so it never runs.
  if (serverId === GITHUB_INTEGRATION_SERVER_ID) return { success: false, error: 'This proposal names a connection nothing proposes on, so it was not applied' }
  if (!userId) return { success: false, error: 'MCP apply requires an authenticated user' }

  // If the proposal stashed who originally connected the server, refuse
  // when the applying user doesn't match. This is the cleaner semantic
  // than relying on callToolByServerId's own ownership assertion —
  // here we know which user_id was actually intended, so we can return
  // an MCP_SERVER_DISCONNECTED that the UI can render as a Reconnect
  // CTA against THAT user.
  if (extra.server_user_id && extra.server_user_id !== userId) {
    return {
      success: false,
      error: `This MCP server was connected by another user and cannot be applied from your account. Reconnect ${extra.server_name ?? 'the server'} to your account first.`,
      code: 'MCP_SERVER_DISCONNECTED',
    }
  }

  const args = extra.args && typeof extra.args === 'object' ? extra.args : {}

  let result
  try {
    result = await callToolByServerId(supabase, serverId, toolName, args, userId)
  } catch (err) {
    if (err instanceof McpTokenExpiredError) {
      return {
        success: false,
        error: err.message,
        // The UI keys off this code to surface a "Reconnect" CTA instead
        // of a generic failure toast.
        code: 'MCP_TOKEN_EXPIRED',
      } as ApplyResult
    }
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }

  // Stash a bounded preview of the result back onto the row so the UI /
  // history can show what happened off-platform without a re-fetch.
  // Remote MCP servers can return arbitrarily large payloads (e.g. a
  // full Confluence page); without a cap they would bloat the row, slow
  // list queries, and ship megabytes to every proposed_change fetch.
  const preview = truncateMcpResultForStorage(result.content)
  const nextExtra: McpCallExtra & Record<string, unknown> = {
    ...extra,
    result: preview.value,
    result_truncated: preview.truncated,
    is_error: result.isError,
    applied_at: new Date().toISOString(),
  }
  await supabase
    .from('proposed_change')
    .update({ extra: nextExtra })
    .eq('id', change.id)

  if (result.isError) {
    return {
      success: false,
      error: `External MCP server returned an error: ${JSON.stringify(result.content).slice(0, 200)}`,
    }
  }
  return { success: true }
}

// ─── Send email (create draft) ───────────────────────────────

async function sendEmail(
  supabase: SupabaseClient,
  change: ProposedChange,
  workspaceId: string,
  memberId: string,
  userId?: string,
): Promise<ApplyResult> {
  const toEmail = change.email_to_address || ''
  const { data, error } = await supabase
    .from('email_draft')
    .insert({
      workspace_id: workspaceId,
      user_id: userId || memberId,
      to_emails: toEmail ? [toEmail] : [],
      subject: change.email_subject || change.title || 'Follow up',
      body_html: null,
      body_text: null,
      context_sources: {
        capture_id: change.capture_id,
        context: change.email_context || change.description,
        trigger_quote: change.trigger_quote,
        to_name: change.email_to_name || null,
      },
      status: 'pending_review',
    })
    .select('id')
    .single()

  if (error) return { success: false, error: error.message }
  return { success: true, entity_id: data.id }
}

// ─── Reach-through edits to ALREADY-APPLIED proposals ─────────
//
// Once a proposal is auto-accepted (status='applied'), it has spawned a real
// entity (proposed_change.result_entity_id). The live agent must still be able
// to refine or retract that entity as the conversation evolves. These helpers
// operate on the CREATED entity, keyed by the proposal's entity_type, rather
// than on the (now-consumed) proposed_change row.

/** Map a create:* proposal entity_type to the table holding the created row. */
const APPLIED_ENTITY_TABLE: Record<string, string> = {
  action: 'actions',
  decision: 'decision',
  milestone: 'milestone',
}

export interface AppliedEditFields {
  title?: string | null
  description?: string | null
  priority?: string | null
  due_date?: string | null
  status_to?: string | null
  assignee_member_id?: string | null
  assignee_ai_member_id?: string | null
  team_id?: string | null
}

/**
 * Update the real entity created by an applied proposal. Only the fields the
 * caller supplies are touched. Workspace-scoped. `decision` has a narrower
 * column set (no priority/due/assignee), so unsupported fields are ignored.
 *
 * `userId` (the auth.users id — memberId is the workspace-scoped profile) is
 * optional and only used to attribute the status-change emit: this is the third
 * writer of `actions.status_id` (beside the actions PATCH and updateAction
 * above), so it funnels through emitStatusChange like the others or a status
 * edited through a proposal card fires no Flow and no Asana echo. Without a
 * userId there is no actor to attribute and the emit is skipped.
 */
export async function updateAppliedEntity(
  supabase: SupabaseClient,
  entityType: string,
  entityId: string,
  workspaceId: string,
  fields: AppliedEditFields,
  userId?: string,
): Promise<ApplyResult> {
  const table = APPLIED_ENTITY_TABLE[entityType]
  if (!table) {
    return { success: false, error: `Cannot edit applied ${entityType} in place` }
  }

  const updates: Record<string, unknown> = {}
  // Captured before the write, for the status-change emit below.
  let resolvedTeamId: string | null = null
  let previousStatusId: string | null = null

  if (entityType === 'action') {
    if (fields.title != null) updates.title = fields.title
    if (fields.description != null) updates.description = fields.description
    if (fields.priority != null) updates.priority = fields.priority
    if (fields.due_date != null) updates.due_at = dueAtFromDate(fields.due_date)
    if (fields.assignee_member_id !== undefined) {
      updates.assignee_id = fields.assignee_member_id
      // The person and the delegate agent coexist (decision 9): assigning a
      // person leaves the agent.
      await supabase.from('action_assignee').delete().eq('action_id', entityId)
      if (fields.assignee_member_id) {
        await supabase
          .from('action_assignee')
          .insert({ action_id: entityId, member_id: fields.assignee_member_id })
      }
    }
    if (fields.assignee_ai_member_id !== undefined) {
      if (
        fields.assignee_ai_member_id &&
        !(await isAssignableTeammate(supabase, fields.assignee_ai_member_id, workspaceId))
      ) {
        return { success: false, error: FOREIGN_AI_MEMBER_ERROR }
      }
      updates.assignee_ai_member_id = fields.assignee_ai_member_id
      // Setting the delegate agent leaves the people responsible
      // (decision 9). With nobody holding the action, the person applying the
      // change becomes responsible.
      if (fields.assignee_ai_member_id && fields.assignee_member_id === undefined && userId) {
        const { data: held } = await supabase.from('action_assignee').select('member_id').eq('action_id', entityId)
        const delegator = !held || held.length === 0 ? await memberIdForUser(supabase, userId, workspaceId) : null
        if (delegator) {
          updates.assignee_id = delegator
          await supabase.from('action_assignee').insert({ action_id: entityId, member_id: delegator })
        }
      }
    }
    if (fields.status_to) {
      // Resolve the workflow state. team_id may be absent on the proposal (it
      // was created without a team context), but the applied action always has
      // one — look it up from the action when not supplied, so a status edit
      // never silently no-ops.
      let teamId = fields.team_id ?? null
      if (!teamId) {
        const { data: actionRow } = await supabase
          .from('actions')
          .select('team_id')
          .eq('id', entityId)
          .eq('workspace_id', workspaceId)
          .maybeSingle()
        teamId = (actionRow?.team_id as string | null) ?? null
      }
      resolvedTeamId = teamId
      if (teamId) {
        const { data: state } = await supabase
          .from('workflow_state')
          .select('id')
          .eq('team_id', teamId)
          .eq('name', fields.status_to)
          .maybeSingle()
        if (state) {
          // Snapshot the FROM status before the write — the emit needs it, and
          // a failed read must fail the edit rather than fabricate a
          // from:null transition (same rule as updateAction above).
          const { data: currentRow, error: readErr } = await supabase
            .from('actions')
            .select('status_id')
            .eq('id', entityId)
            .eq('workspace_id', workspaceId)
            .maybeSingle()
          if (readErr) return { success: false, error: readErr.message }
          previousStatusId = (currentRow?.status_id as string | null) ?? null
          updates.status_id = state.id
        }
      }
    }
  } else if (entityType === 'decision') {
    // decision: content is the editable body (mapped from title/description).
    const content = fields.title ?? fields.description
    if (content != null) updates.content = content
  } else if (entityType === 'milestone') {
    if (fields.title != null) updates.name = fields.title
    if (fields.description != null) updates.description = fields.description
    if (fields.due_date != null) updates.target_date = fields.due_date
    if (fields.status_to != null) {
      // milestone.status is a Postgres ENUM — validate client-side so a bad
      // value returns a clear error instead of a raw DB constraint failure.
      const VALID_MILESTONE_STATUS = ['pending', 'in_progress', 'completed']
      if (!VALID_MILESTONE_STATUS.includes(fields.status_to)) {
        return {
          success: false,
          error: `Invalid milestone status "${fields.status_to}" (expected one of: ${VALID_MILESTONE_STATUS.join(', ')})`,
        }
      }
      updates.status = fields.status_to
    }
  }

  if (Object.keys(updates).length === 0) {
    return { success: true, entity_id: entityId } // nothing to change is not an error
  }

  // Only actions carry workspace_id: decision is scoped via its capture, and
  // milestone through its project (fenced here, before the write).
  if (entityType === 'milestone') {
    const fenceError = await milestoneFenceError(supabase, entityId, workspaceId)
    if (fenceError) return { success: false, error: fenceError }
  }
  let q = supabase.from(table).update(updates).eq('id', entityId)
  if (entityType === 'action') q = q.eq('workspace_id', workspaceId)
  const { error } = await q
  if (error) return { success: false, error: error.message }

  // Editing an applied proposal's status is a status write like any other —
  // fire the shared trigger (GEN-112) so Flows and the Asana echo see it.
  // Fire-and-forget; self-guards on unchanged status / no team.
  if (updates.status_id !== undefined && userId) {
    emitStatusChange({
      entityType: 'action',
      entityId,
      workspaceId,
      teamId: resolvedTeamId,
      fromStatusId: previousStatusId,
      toStatusId: updates.status_id as string,
      actorUserId: userId,
    })
  }

  return { success: true, entity_id: entityId }
}

/**
 * Hard-delete the real entity created by an applied proposal (the conversation
 * retracted it). Workspace-scoped. Best-effort cleanup of join rows.
 *
 * IMPORTANT: only deletes when the proposal CREATED the entity (changeType
 * 'create'). For 'update'/'assign' proposals the target entity pre-existed —
 * deleting it would be destructive and wrong — so those are refused (the caller
 * should just mark the proposal dismissed and leave the entity alone).
 */
export async function deleteAppliedEntity(
  supabase: SupabaseClient,
  changeType: string,
  entityType: string,
  entityId: string,
  workspaceId: string,
): Promise<ApplyResult> {
  if (changeType !== 'create') {
    return {
      success: false,
      error: `Refusing to delete a pre-existing entity from a ${changeType} proposal`,
      code: 'NOT_CREATED_BY_PROPOSAL',
    }
  }
  const table = APPLIED_ENTITY_TABLE[entityType]
  if (!table) {
    return { success: false, error: `Cannot delete applied ${entityType}` }
  }
  // action_assignee.action_id and action_label.action_id are ON DELETE CASCADE
  // (migrations 093 / 020), so deleting the action cleans up its join rows
  // automatically — no fragile manual pre-deletes that could fail silently.
  // Only actions carry workspace_id; milestone is fenced through its project.
  if (entityType === 'milestone') {
    const fenceError = await milestoneFenceError(supabase, entityId, workspaceId)
    if (fenceError) return { success: false, error: fenceError }
  }
  let q = supabase.from(table).delete().eq('id', entityId)
  if (entityType === 'action') q = q.eq('workspace_id', workspaceId)
  const { error } = await q
  if (error) return { success: false, error: error.message }
  return { success: true, entity_id: entityId }
}
