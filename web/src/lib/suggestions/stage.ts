import type { SupabaseClient } from '@supabase/supabase-js'
import { canApplyChange } from '@/lib/proposed-changes/appliable-combos'
import { resolveContactIdByName, resolveMemberIdByName } from '@/lib/people/name-match'
import { suggestionFingerprint } from './fingerprint'
import { daysAgoIso, expiresAtFor, MAX_SUGGESTIONS_PER_CALL, RECENTLY_DISMISSED_DAYS } from './lifecycle'
import { resolveSuggestionTarget, type ResolvedTarget } from './target'
import {
  SUGGEST_PRIORITIES,
  suggestionMarker,
  type StagedSuggestion,
  type SuggestionHome,
  type SuggestionInput,
  type SuggestionOrigin,
} from './types'

/**
 * Stage suggestions: the server side of the suggest_changes tool
 * (docs/plans/suggestions-everywhere.md). Each input becomes one pending
 * proposed_change row the person can accept, dismiss or modify, shown where
 * it was staged (its home).
 *
 * Every input is checked before anything is written: the combo must be one the
 * apply engine runs, the target must resolve to exactly one item, the values
 * must be valid, and the change must not already be true. A refused input
 * comes back with the reason so the agent can fix it or drop it; the others
 * still stage.
 *
 * Dedup: the same change (fingerprint) already pending in the same home comes
 * back as `existing`, and one the person dismissed in the last
 * RECENTLY_DISMISSED_DAYS is refused, so an agent doesn't nag.
 *
 * Runs on the service-role client (the internal tool routes), so every read is
 * fenced to the person's own workspaces here.
 */

export interface StageContext {
  supabase: SupabaseClient
  /** The person the suggestions are for (the conversation's or the run's user). */
  userId: string
  /** The conversation's or run's workspace. Wins ties when resolving targets. */
  workspaceId: string
  origin: SuggestionOrigin
  /** Where the suggestions are shown. null: a run's suggestions, re-homed onto
   *  its document at delivery (rehomeRunSuggestions). */
  home: SuggestionHome | null
  trackedJobId?: string | null
  now?: Date
}

/** Combos suggest_changes may stage: each is handled by the apply engine and
 *  checked end to end here. */
const SUGGESTABLE = new Set([
  'create:action',
  'update:action',
  'assign:action',
  'delete:action',
  'update:project',
  'create:milestone',
  'update:milestone',
  'delete:milestone',
  'send_email:contact',
])

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const SELF_NAMES = new Set(['me', 'myself', 'i', 'self'])

interface MemberRow {
  id: string
  workspace_id: string
}

/** The row fields one input resolves to, before home/lifecycle columns. */
type Draft = Record<string, unknown> & {
  workspace_id: string
  change_type: string
  entity_type: string
  entity_id: string | null
}

type Resolved = { ok: true; draft: Draft; note?: string } | { ok: false; refusal: StagedSuggestion['refusal']; note: string }

function refuse(refusal: NonNullable<StagedSuggestion['refusal']>, note: string): Resolved {
  return { ok: false, refusal, note }
}

async function resolvePerson(
  ctx: StageContext,
  workspaceId: string,
  members: MemberRow[],
  name: string,
): Promise<{ memberId: string | null; contactId: string | null; name: string } | null> {
  const trimmed = name.trim()
  if (SELF_NAMES.has(trimmed.toLowerCase())) {
    const self = members.find((m) => m.workspace_id === workspaceId)
    return self ? { memberId: self.id, contactId: null, name: trimmed } : null
  }
  const memberId = await resolveMemberIdByName(ctx.supabase, workspaceId, trimmed)
  if (memberId) return { memberId, contactId: null, name: trimmed }
  const contactId = await resolveContactIdByName(ctx.supabase, workspaceId, trimmed, ctx.userId)
  if (contactId) return { memberId: null, contactId, name: trimmed }
  return null
}

async function resolveStatusName(
  supabase: SupabaseClient,
  teamId: string | null,
  wanted: string,
): Promise<{ name: string } | { error: string }> {
  if (!teamId) return { error: 'This action has no team, so its status cannot be set.' }
  const { data } = await supabase.from('workflow_state').select('name').eq('team_id', teamId)
  const names = ((data as Array<{ name: string }> | null) ?? []).map((s) => s.name)
  const hit = names.find((n) => n.toLowerCase() === wanted.trim().toLowerCase())
  return hit ? { name: hit } : { error: `"${wanted}" is not a status on this team. Use one of: ${names.join(', ')}.` }
}

async function resolveProjectId(
  supabase: SupabaseClient,
  workspaceId: string,
  project: string,
): Promise<string | null> {
  const p = project.trim()
  if (/^[0-9a-f-]{36}$/i.test(p)) {
    const { data } = await supabase.from('projects').select('id').eq('id', p).eq('workspace_id', workspaceId).maybeSingle()
    return (data as { id: string } | null)?.id ?? null
  }
  const { data } = await supabase
    .from('projects')
    .select('id')
    .eq('workspace_id', workspaceId)
    .ilike('name', p.replace(/[\\%_]/g, (m) => `\\${m}`))
    .limit(2)
  const rows = (data as Array<{ id: string }> | null) ?? []
  return rows.length === 1 ? rows[0].id : null
}

/** Turn one input into the proposed_change fields it stands for, or a refusal. */
async function resolveInput(ctx: StageContext, members: MemberRow[], input: SuggestionInput): Promise<Resolved> {
  const combo = `${input.change}:${input.entity}`
  if (!SUGGESTABLE.has(combo)) {
    return refuse('unsupported', `${combo} can't be suggested. Supported: ${[...SUGGESTABLE].join(', ')}.`)
  }
  if (!input.summary?.trim()) return refuse('invalid', 'summary is required.')
  const set = input.set ?? {}
  const workspaceIds = [...new Set(members.map((m) => m.workspace_id))]

  // ── The target ─────────────────────────────────────────────────────────
  let target: Extract<ResolvedTarget, { ok: true }> | null = null
  if (input.change !== 'create') {
    if (!input.target?.trim()) return refuse('invalid', `${combo} needs a target (an identifier like GEN-42, an id, or a name).`)
    const t = await resolveSuggestionTarget(ctx.supabase, {
      entity: input.entity,
      target: input.target,
      summary: input.summary,
      workspaceIds,
      preferredWorkspaceId: ctx.workspaceId,
      userId: ctx.userId,
    })
    if (!t.ok) return refuse(t.refusal, t.note)
    target = t
  }
  const workspaceId = target?.workspaceId ?? ctx.workspaceId
  if (!workspaceIds.includes(workspaceId)) return refuse('invalid', 'Not a member of that workspace.')

  const draft: Draft = {
    workspace_id: workspaceId,
    change_type: input.change,
    entity_type: input.entity,
    entity_id: target?.entityId ?? null,
    team_id: target?.teamId ?? null,
    base: target?.base ?? null,
  }
  const base = (target?.base ?? {}) as Record<string, unknown>
  const extra: Record<string, unknown> = {}

  // ── The values ─────────────────────────────────────────────────────────
  if (set.title?.trim()) draft.title = set.title.trim()
  if (set.description?.trim()) draft.description = set.description.trim()
  if (input.change === 'create' && !draft.title) draft.title = input.summary.trim()

  if (set.priority) {
    const p = set.priority.trim().toLowerCase()
    if (!(SUGGEST_PRIORITIES as readonly string[]).includes(p)) {
      return refuse('invalid', `priority must be one of ${SUGGEST_PRIORITIES.join(', ')}.`)
    }
    if (input.entity !== 'action') return refuse('invalid', 'priority applies to actions only.')
    draft.priority = p
  }

  if (set.due_date) {
    if (!DATE_RE.test(set.due_date) || Number.isNaN(Date.parse(set.due_date))) {
      return refuse('invalid', 'due_date must be YYYY-MM-DD.')
    }
    draft.due_date = set.due_date
  }

  if (set.status) {
    if (input.entity === 'action') {
      const teamId = (draft.team_id as string | null) ?? null
      if (input.change === 'create') {
        // createAction resolves the status on the team it lands in.
        draft.status_to = set.status.trim()
      } else {
        const s = await resolveStatusName(ctx.supabase, teamId, set.status)
        if ('error' in s) return refuse('invalid', s.error)
        draft.status_to = s.name
        draft.status_from = (base.status as string | null) ?? null
      }
    } else {
      draft.status_to = set.status.trim()
      draft.status_from = (base.status as string | null) ?? null
    }
  }

  if (set.assignee?.trim()) {
    const person = await resolvePerson(ctx, workspaceId, members, set.assignee)
    if (!person) return refuse('invalid', `No member or contact named "${set.assignee}".`)
    draft.assignee_name = person.name
    draft.assignee_member_id = person.memberId
    draft.assignee_contact_id = person.contactId
    if (input.entity === 'project' && !person.memberId) {
      return refuse('invalid', 'A project lead must be a workspace member.')
    }
  }
  if (input.change === 'assign' && !draft.assignee_member_id && !draft.assignee_contact_id) {
    return refuse('invalid', 'assign needs set.assignee.')
  }

  if (set.project?.trim()) {
    const projectId = await resolveProjectId(ctx.supabase, workspaceId, set.project)
    if (!projectId) return refuse('invalid', `No single project named "${set.project}".`)
    if (input.change === 'update' && input.entity === 'action') {
      // Moving an action is explicit: the extractor's project_id on an update
      // is context, never a move, so a move rides in extra.
      extra.move_to_project_id = projectId
    } else {
      draft.project_id = projectId
    }
  }
  if (combo === 'create:milestone' && !draft.project_id) {
    return refuse('invalid', 'A milestone needs set.project.')
  }

  if (input.change === 'send_email') {
    const { data } = await ctx.supabase
      .from('contact')
      .select('email, full_name')
      .eq('id', draft.entity_id as string)
      .maybeSingle()
    const contact = data as { email: string | null; full_name: string | null } | null
    if (!contact?.email) return refuse('invalid', 'That contact has no email address.')
    draft.email_to_address = contact.email
    draft.email_to_name = contact.full_name
    draft.email_subject = set.email_subject?.trim() || input.summary.trim()
    draft.email_context = set.description?.trim() || input.why
  }

  if (input.change === 'update') {
    const changes = ['title', 'description', 'priority', 'due_date', 'status_to', 'assignee_member_id', 'assignee_contact_id']
      .filter((k) => draft[k] !== undefined)
    if (changes.length === 0 && !extra.move_to_project_id) {
      return refuse('invalid', 'An update needs at least one value in set.')
    }
    if (input.entity === 'action' && isAlreadyTrue(draft, base, extra)) {
      return refuse('already_true', `${target?.label ?? 'It'} already has those values.`)
    }
  }

  if (!canApplyChange({ change_type: draft.change_type, entity_type: draft.entity_type, entity_id: draft.entity_id })) {
    return refuse('unsupported', `${combo} can't be applied.`)
  }

  if (Object.keys(extra).length) draft.extra = extra
  return { ok: true, draft, ...(target ? { note: target.label } : {}) }
}

/** Every proposed value on an action update already holds. */
export function isAlreadyTrue(
  draft: Record<string, unknown>,
  base: Record<string, unknown>,
  extra: Record<string, unknown>,
): boolean {
  const same = (a: unknown, b: unknown) =>
    String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase()
  const checks: boolean[] = []
  if (draft.status_to !== undefined) checks.push(same(draft.status_to, base.status))
  if (draft.priority !== undefined) checks.push(same(draft.priority, base.priority))
  if (draft.due_date !== undefined) checks.push(same(draft.due_date, base.due_date))
  if (draft.assignee_member_id) checks.push(same(draft.assignee_member_id, base.assignee_id))
  if (draft.assignee_contact_id) checks.push(same(draft.assignee_contact_id, base.assignee_contact_id))
  if (extra.move_to_project_id) checks.push(same(extra.move_to_project_id, base.project_id))
  // A title or description rewrite can't be compared cheaply; it's never "already true".
  if (draft.title !== undefined || draft.description !== undefined) checks.push(false)
  return checks.length > 0 && checks.every(Boolean)
}

function homeColumns(home: SuggestionHome | null): Record<string, string | null> {
  return {
    capture_id: home?.kind === 'capture' ? home.id : null,
    document_id: home?.kind === 'document' ? home.id : null,
    conversation_id: home?.kind === 'conversation' ? home.id : null,
  }
}

function fingerprintOf(draft: Draft): string {
  // With a target id the title is not the subject, so a title or description
  // rewrite has to count as a proposed value: "rename to B" is not "rename to A".
  const targeted = !!draft.entity_id
  return suggestionFingerprint({
    workspaceId: draft.workspace_id,
    changeType: draft.change_type,
    entityType: draft.entity_type,
    entityId: draft.entity_id,
    title: (draft.title as string | null) ?? null,
    values: {
      status: draft.status_to as string | undefined,
      priority: draft.priority as string | undefined,
      due_date: draft.due_date as string | undefined,
      assignee_member: draft.assignee_member_id as string | undefined,
      assignee_contact: draft.assignee_contact_id as string | undefined,
      project: (draft.project_id as string | undefined) ?? ((draft.extra as Record<string, string> | undefined)?.move_to_project_id),
      email_to: draft.email_to_address as string | undefined,
      title: targeted ? (draft.title as string | undefined) : undefined,
      description: targeted ? (draft.description as string | undefined) : undefined,
    },
  })
}

export async function stageSuggestions(ctx: StageContext, inputs: SuggestionInput[]): Promise<StagedSuggestion[]> {
  const now = ctx.now ?? new Date()
  if (inputs.length > MAX_SUGGESTIONS_PER_CALL) {
    return inputs.map((i) => ({
      summary: i.summary,
      result: 'refused' as const,
      refusal: 'invalid' as const,
      note: `At most ${MAX_SUGGESTIONS_PER_CALL} suggestions per call.`,
    }))
  }

  const { data: memberRows } = await ctx.supabase
    .from('member')
    .select('id, workspace_id')
    .eq('user_id', ctx.userId)
  const members = (memberRows as MemberRow[] | null) ?? []
  if (!members.some((m) => m.workspace_id === ctx.workspaceId)) {
    return inputs.map((i) => ({ summary: i.summary, result: 'refused' as const, refusal: 'invalid' as const, note: 'Not a member of this workspace.' }))
  }

  const home = homeColumns(ctx.home)
  const { count } = ctx.home
    ? await ctx.supabase
        .from('proposed_change')
        .select('id', { count: 'exact', head: true })
        .eq(ctx.home.kind === 'capture' ? 'capture_id' : ctx.home.kind === 'document' ? 'document_id' : 'conversation_id', ctx.home.id)
    : { count: 0 }
  let sortOrder = count ?? 0

  const out: StagedSuggestion[] = []
  for (const input of inputs) {
    const summary = input.summary?.trim() ?? ''
    let resolved: Resolved
    try {
      resolved = await resolveInput(ctx, members, input)
    } catch (err) {
      resolved = refuse('invalid', err instanceof Error ? err.message : 'Could not resolve this suggestion.')
    }
    if (!resolved.ok) {
      out.push({ summary, result: 'refused', refusal: resolved.refusal, note: resolved.note })
      continue
    }
    const { draft } = resolved
    const fingerprint = fingerprintOf(draft)

    // Already pending in this home: hand back the same card.
    if (ctx.home) {
      const { data: existing } = await ctx.supabase
        .from('proposed_change')
        .select('id')
        .eq('workspace_id', draft.workspace_id)
        .eq('fingerprint', fingerprint)
        .eq('status', 'pending')
        .eq(ctx.home.kind === 'capture' ? 'capture_id' : ctx.home.kind === 'document' ? 'document_id' : 'conversation_id', ctx.home.id)
        .limit(1)
      const hit = (existing as Array<{ id: string }> | null)?.[0]
      if (hit) {
        out.push({ id: hit.id, marker: suggestionMarker(hit.id), summary, result: 'existing', note: resolved.note })
        continue
      }
    }

    // The person said no to this recently: don't ask again.
    const { data: dismissed } = await ctx.supabase
      .from('proposed_change')
      .select('id')
      .eq('workspace_id', draft.workspace_id)
      .eq('fingerprint', fingerprint)
      .eq('status', 'dismissed')
      .gte('resolved_at', daysAgoIso(now, RECENTLY_DISMISSED_DAYS))
      .limit(1)
    if ((dismissed as unknown[] | null)?.length) {
      out.push({
        summary,
        result: 'refused',
        refusal: 'recently_dismissed',
        note: `This was dismissed in the last ${RECENTLY_DISMISSED_DAYS} days.`,
      })
      continue
    }

    const confidence = typeof input.confidence === 'number' ? Math.min(1, Math.max(0, input.confidence)) : 0.7
    const { data: inserted, error } = await ctx.supabase
      .from('proposed_change')
      .insert({
        ...draft,
        ...home,
        tracked_job_id: ctx.trackedJobId ?? null,
        origin: ctx.origin,
        display_text: summary,
        reasoning: input.why?.trim() || null,
        confidence,
        sort_order: sortOrder++,
        fingerprint,
        expires_at: expiresAtFor(now, input.expires_in_days),
        status: 'pending',
      })
      .select('id')
      .single()
    if (error || !inserted) {
      out.push({ summary, result: 'refused', refusal: 'invalid', note: error?.message ?? 'Could not save the suggestion.' })
      continue
    }
    const id = (inserted as { id: string }).id
    out.push({ id, marker: suggestionMarker(id), summary, result: 'staged', note: resolved.note })
  }
  return out
}

/**
 * Re-home a run's suggestions onto the document it delivered (the brief stages
 * while it works; the document only exists at the end). Returns their ids.
 */
export async function rehomeRunSuggestions(
  supabase: SupabaseClient,
  args: { trackedJobId: string; documentId: string },
): Promise<string[]> {
  const { data } = await supabase
    .from('proposed_change')
    .update({ document_id: args.documentId })
    .eq('tracked_job_id', args.trackedJobId)
    .is('document_id', null)
    .is('capture_id', null)
    .is('conversation_id', null)
    .select('id')
  return ((data as Array<{ id: string }> | null) ?? []).map((r) => r.id)
}
