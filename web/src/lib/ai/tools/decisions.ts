import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveEntityWorkspace, workspaceEcho, captureReadAccess, captureRequester, captureVisibleToRequester } from './_shared'
import type { CreateWorkspacePolicy } from './_shared'
import { filedByThisRun, LEAVE_FOR_PERSON, type ActionToolRules } from './actions'

/**
 * @param createWorkspacePolicy accepted so ./index.ts threads every create-bearing
 *   factory identically, and INERT here: `create_decision` is PARENT-anchored on a
 *   capture, which names the workspace outright, so no fallback needs arbitrating.
 * @param omitPrivateCaptures unattended runs pass true: only workspace-visible
 *   captures (and so their decisions) are reachable, even the caller's own
 *   private ones (see {@link captureRequester}).
 */
export function createDecisionTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  strictWorkspace = false,
  createWorkspacePolicy: CreateWorkspacePolicy = 'session',
  omitPrivateCaptures = false,
  /**
   * The unattended-run rules the action tools take (CreateToolsOptions
   * .actionRules): with nobody watching, create_decision files suggested and
   * the confirm tools refuse the decisions the run filed itself.
   */
  rules: ActionToolRules = {},
  // A guest's or a linked agent's turn (CreateToolsOptions.omitGrants): what
  // was shared with the person stays theirs, never their guest's.
  omitGrants = false,
) {
  // These tools run on a service-role client for MCP and unattended runs, so
  // this requester — not RLS — is what keeps a teammate's private capture (and
  // the decisions hanging off it) hidden.
  const requester = captureRequester(userId, omitPrivateCaptures)

  /**
   * The workspace a decision's OWNING CAPTURE lives in, or null when the caller
   * may not reach it.
   *
   * `decision` has no workspace_id column of its own (migration 025) — it hangs
   * off `captures.capture_id` and inherits that row's tenant — so the capture is
   * the only thing there is to route by. {@link resolveEntityWorkspace} follows
   * the capture into any workspace the user belongs to (and stops dead under
   * `strictWorkspace`); the visibility re-check then runs IN the workspace it
   * resolved, never in the session's.
   *
   * Visibility, not ownership: a decision belongs to the workspace's meeting,
   * so any member reaches it when the capture is workspace-visible, and only
   * the capture's owner when it is private (RLS on `decision`, migration 223).
   *
   * Returns null for every failure — no such capture, a private capture that
   * isn't the caller's, fenced run — so callers emit one indistinguishable
   * not-found.
   */
  const resolveCaptureWorkspace = async (captureId: string | null | undefined): Promise<string | null> => {
    if (!captureId) return null
    const routed = await resolveEntityWorkspace(supabase, userId, 'captures', captureId, workspaceId, strictWorkspace)
    if (!routed) return null

    const visible = await captureVisibleToRequester(supabase, captureId, routed.workspaceId, requester)
    return visible ? routed.workspaceId : null
  }

  return {
    list_decisions: tool({
      description: 'List decisions for a capture, optionally filtered by confirmation status.',
      inputSchema: z.object({
        capture_id: z.string().describe('UUID of the capture'),
        confirmation: z
          .enum(['suggested', 'confirmed', 'dismissed'])
          .optional()
          .describe('Filter by confirmation status'),
      }),
      execute: async ({ capture_id, confirmation }) => {
        // The capture must be visible to the caller: workspace-visible, their
        // own private one, or a teammate's shared with them (a grant, 492: the
        // decision view policy's arm, 493). Otherwise it reads as absent. A
        // read only: confirming or dismissing asks the ungranted rule.
        const visible = await captureReadAccess(supabase, capture_id, workspaceId, requester, undefined, !omitGrants)
        if (!visible) return { success: false, error: 'Capture not found' }

        let query = supabase
          .from('decision')
          .select(
            'id, capture_id, content, source_timestamp, project_id, confirmation, created_at, decided_by_member:member!decided_by(id, display_name), project:projects!project_id(id, name)',
          )
          .eq('capture_id', capture_id)
          .order('source_timestamp', { ascending: true, nullsFirst: false })
          .order('created_at', { ascending: true })

        if (confirmation) {
          query = query.eq('confirmation', confirmation)
        }

        const { data, error } = await query

        if (error) return { success: false, error: error.message }

        const decisions = (data || []).map((d) => {
          const memberData = d.decided_by_member as unknown as { id: string; display_name: string } | null
          const projectData = d.project as unknown as { id: string; name: string } | null
          return {
            id: d.id,
            capture_id: d.capture_id,
            content: d.content,
            source_timestamp: d.source_timestamp,
            project_id: d.project_id,
            project_name: projectData?.name || null,
            confirmation: d.confirmation,
            decided_by_name: memberData?.display_name || null,
            created_at: d.created_at,
          }
        })

        return { success: true, decisions, count: decisions.length }
      },
    }),

    create_decision: tool({
      description: 'Create a new decision linked to a capture.',
      inputSchema: z.object({
        capture_id: z.string().describe('UUID of the capture'),
        content: z.string().describe('The decision text'),
        source_timestamp: z.number().optional().describe('Timestamp in the recording (seconds)'),
        project_id: z.string().optional().describe('UUID of the project to link to'),
        confirmation: z
          .enum(['suggested', 'confirmed'])
          .optional()
          .default('suggested')
          .describe("'confirmed' for user-stated, 'suggested' for AI-identified"),
      }),
      execute: async ({ capture_id, content, source_timestamp, project_id, confirmation }) => {
        // PARENT-ANCHORED CREATE: the capture names the tenant, so this tool
        // takes no `workspace_id` — it acts wherever the capture lives, once
        // visibility there is proven (the same gate list_decisions /
        // confirm_decision apply, run in the resolved workspace).
        const captureWs = await resolveCaptureWorkspace(capture_id)
        if (!captureWs) return { success: false, error: 'Capture not found' }

        // When a project is supplied, verify it belongs to THE CAPTURE'S
        // workspace. A project resolved in the session workspace and written
        // onto a decision that hangs off a capture elsewhere is a cross-tenant
        // foreign key — `decision.project_id` is workspace-blind.
        if (project_id) {
          const { data: project } = await supabase
            .from('projects')
            .select('id')
            .eq('id', project_id)
            .eq('workspace_id', captureWs)
            .single()
          if (!project) return { success: false, error: 'Project not found' }
        }

        // Resolve current member for decided_by — in the capture's workspace,
        // because `member.id` is workspace-scoped and lands on the row.
        const { data: member } = await supabase
          .from('member')
          .select('id')
          .eq('user_id', userId)
          .eq('workspace_id', captureWs)
          .single()

        const insert: Record<string, unknown> = {
          capture_id,
          content,
          // The promotion guard: nobody watching → a suggestion the person confirms.
          confirmation: rules.unattended ? 'suggested' : confirmation || 'suggested',
        }
        if (source_timestamp !== undefined) insert.source_timestamp = source_timestamp
        if (project_id) insert.project_id = project_id
        if (member?.id) insert.decided_by = member.id

        const { data, error } = await supabase
          .from('decision')
          .insert(insert)
          .select('id, capture_id, content, confirmation, created_at')
          .single()

        if (error) return { success: false, error: error.message }

        // Mirror into the knowledge graph as a decision_summary claim.
        // Follows the decision's own confirmation state.
        const { emitDecisionClaim } = await import('@/lib/ai/emit-decision-claim')
        void emitDecisionClaim({
          supabase,
          // The claim mirrors the decision, so it belongs in the same workspace
          // the decision does — not the one the session happens to point at.
          workspaceId: captureWs,
          memberId: member?.id ?? null,
          userId,
          text: content,
          captureId: capture_id,
          projectId: project_id ?? null,
          confirmation: rules.unattended ? 'suggested' : ((confirmation as 'suggested' | 'confirmed' | undefined) ?? 'suggested'),
        })

        return {
          success: true,
          decision: data,
          message: `Created decision: "${content.substring(0, 60)}${content.length > 60 ? '...' : ''}"`,
          // A `decision` row carries no workspace_id, so this echo is the only
          // in-band proof of which tenant the create landed in.
          ...workspaceEcho(captureWs),
        }
      },
    }),

    confirm_decision: tool({
      description: "Confirm a suggested decision (change from 'suggested' to 'confirmed').",
      inputSchema: z.object({
        decision_id: z.string().describe('UUID of the decision'),
      }),
      execute: async ({ decision_id }) => {
        // Verify the decision belongs to a capture this user may see, in
        // whichever workspace that capture lives in.
        const { data: decision } = await supabase
          .from('decision')
          .select('id, capture_id')
          .eq('id', decision_id)
          .single()
        if (!decision) return { success: false, error: 'Decision not found' }

        const captureWs = await resolveCaptureWorkspace(decision.capture_id as string | null)
        if (!captureWs) return { success: false, error: 'Decision not found' }

        // The promotion guard: an unattended run never confirms a decision
        // one by one; the person does (confirm_action's rule).
        if (rules.unattended) return { success: false, code: 'LEAVE_FOR_PERSON', error: LEAVE_FOR_PERSON }

        const { data, error } = await supabase
          .from('decision')
          .update({ confirmation: 'confirmed' })
          .eq('id', decision_id)
          // Re-pin to the capture the check above cleared: `decision` has no
          // workspace_id, so its capture_id is the only tenant predicate the
          // write can carry.
          .eq('capture_id', decision.capture_id)
          .eq('confirmation', 'suggested')
          .select('id, content')
          .single()

        if (error) return { success: false, error: error.message }
        return { success: true, message: `Confirmed decision: "${data.content.substring(0, 60)}"` }
      },
    }),

    dismiss_decision: tool({
      description: 'Dismiss a suggested decision.',
      inputSchema: z.object({
        decision_id: z.string().describe('UUID of the decision'),
      }),
      execute: async ({ decision_id }) => {
        // Verify the decision belongs to a capture this user may see
        const { data: decisionRow } = await supabase
          .from('decision')
          .select('id, capture_id')
          .eq('id', decision_id)
          .single()
        if (!decisionRow) return { success: false, error: 'Decision not found' }

        const captureWs = await resolveCaptureWorkspace(decisionRow.capture_id as string | null)
        if (!captureWs) return { success: false, error: 'Decision not found' }

        const { data, error } = await supabase
          .from('decision')
          .update({ confirmation: 'dismissed' })
          .eq('id', decision_id)
          .eq('capture_id', decisionRow.capture_id)
          .select('id, content')
          .single()

        if (error) return { success: false, error: error.message }
        return { success: true, message: `Dismissed decision: "${data.content.substring(0, 60)}"` }
      },
    }),

    confirm_all_decisions: tool({
      description: "Confirm all suggested decisions for a capture at once.",
      inputSchema: z.object({
        capture_id: z.string().describe('UUID of the capture'),
      }),
      execute: async ({ capture_id }) => {
        // Verify capture visibility, following the capture to its own workspace.
        const captureWs = await resolveCaptureWorkspace(capture_id)
        if (!captureWs) return { success: false, error: 'Capture not found' }

        // The promotion guard: an unattended run confirms the others, never
        // the decisions it filed itself (the person confirms those).
        let skip: string[] = []
        if (rules.unattended) {
          const { data: pending } = await supabase
            .from('decision')
            .select('id')
            .eq('capture_id', capture_id)
            .eq('confirmation', 'suggested')
          const pendingIds = ((pending ?? []) as Array<{ id: string }>).map((d) => d.id)
          const own = await filedByThisRun(rules, pendingIds)
          skip = pendingIds.filter((id) => own.has(id.toLowerCase()))
          if (pendingIds.length > 0 && skip.length === pendingIds.length) {
            return { success: false, code: 'LEAVE_FOR_PERSON', error: LEAVE_FOR_PERSON, left_for_person: skip.length }
          }
        }

        let update = supabase
          .from('decision')
          .update({ confirmation: 'confirmed' })
          .eq('capture_id', capture_id)
          .eq('confirmation', 'suggested')
        if (skip.length > 0) update = update.not('id', 'in', `(${skip.join(',')})`)
        const { data, error } = await update.select('id')

        if (error) return { success: false, error: error.message }
        return {
          success: true,
          confirmed_count: data?.length || 0,
          ...(skip.length > 0 ? { left_for_person: skip.length } : {}),
          message:
            `Confirmed ${data?.length || 0} decisions` +
            (skip.length > 0 ? `. Left ${skip.length} you filed for the person to confirm.` : ''),
        }
      },
    }),
  }
}
