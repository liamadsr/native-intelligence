import { tool } from 'ai'
import { webText } from './web-derived'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  resolveSince,
  resolveUntil,
  getUserWorkspaces,
  timeWindowParams,
  resolveEntityWorkspace,
  resolveCreateWorkspace,
  workspaceEcho,
  applyCaptureVisibility,
  applyEmbeddedCaptureVisibility,
  captureReadAccess,
  captureRequester,
  GRANTS_TRUNCATED_NOTE,
  grantReader,
  captureVisibleToRequester,
  captureWriteAccess,
  isCaptureVisible,
  readGrants,
  type CreateWorkspacePolicy,
} from './_shared'
import { filterVisibleContacts, isContactVisibleTo } from '@/lib/crm/contact-visibility'
import { hasEditGrant } from '@/lib/entity-access/grants'
import { wrapUntrusted } from '@/lib/email/untrusted'
import { featureGatedRecipeExclusions, resolveWorkspaceEdition } from '@/lib/editions'
import { excludeFeatureGatedRecipes } from '@/lib/library/feature-gate'
import { visibleRecipesFilter } from '@/lib/library/visibility'

const CAPTURE_TIME_FIELDS = ['started_at', 'created_at', 'ended_at'] as const

/**
 * A row a READ returned that is someone else's private capture: only a grant
 * (492) let it through, so the person sees it shared with them, view only.
 */
function sharedOnly(row: { visibility?: unknown; user_id?: unknown }, requester: string | null): boolean {
  return row.visibility === 'private' && row.user_id !== requester
}

/** What a read of a capture shared with the person (a grant) says about it. */
const SHARED_VIEW_ONLY = {
  shared_with_you: true,
  access: 'view' as const,
  access_note: "Another member's private capture, shared with you to read. You can't change it.",
}

/** The same, for one shared with them to EDIT (an edit grant, migration 512). */
const SHARED_TO_EDIT = {
  shared_with_you: true,
  access: 'edit' as const,
  access_note:
    "Another member's private capture, shared with you to edit: you can change its title, text, summary, tags and decisions, and comment on it, but not archive it or change who sees it.",
}

/**
 * get_capture_transcript's default page: ~80K characters, about 20K tokens. A
 * whole transcript (70-100K tokens for a long meeting) in one tool result
 * floods the context, is re-sent on every later step, and can tip a session
 * into a mid-turn compaction that drops the result the model just fetched. An
 * explicit `limit` reads exactly that many lines.
 */
export const TRANSCRIPT_PAGE_CHARS = 80_000

/**
 * A transcript page as a model reads it: what the other speakers said is
 * someone else's words, so it goes inside the untrusted-content marker
 * (src/lib/email/untrusted.ts, A5). Paging counts the raw lines.
 */
function transcriptForModel(text: string): string {
  return wrapUntrusted(text, 'TRANSCRIPT') ?? ''
}

/** get_capture_content's include_transcript: the first page, and where get_capture_transcript continues. */
function transcriptFirstPage(transcript: string | null): Record<string, unknown> {
  if (!transcript) return { transcript }
  const lines = transcript.split('\n')
  const end = transcriptPageEnd(lines, 0)
  if (end >= lines.length) return { transcript: transcriptForModel(transcript) }
  return { transcript: transcriptForModel(lines.slice(0, end).join('\n')), transcript_has_more: true, transcript_next_offset: end, transcript_total_lines: lines.length }
}

/**
 * End (exclusive) of the default page starting at line `start`: whole lines
 * while they fit in TRANSCRIPT_PAGE_CHARS (newlines counted), and always at
 * least one line so paging advances.
 */
export function transcriptPageEnd(lines: readonly string[], start: number): number {
  let end = start
  let chars = 0
  while (end < lines.length) {
    const next = chars + lines[end].length + (end > start ? 1 : 0)
    if (end > start && next > TRANSCRIPT_PAGE_CHARS) break
    chars = next
    end += 1
  }
  return end
}

export function createCaptureTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  accessToken?: string,
  strictWorkspace = false,
  omitPrivateCaptures = false,
  // Trailing positional, after `accessToken` / `strict` / `omitPrivate`, as
  // ./index.ts threads them. 'session' keeps chat byte-identical; the MCP
  // bridge passes 'explicit'.
  createWorkspacePolicy: CreateWorkspacePolicy = 'session',
  // A guest's or a linked agent's turn (CreateToolsOptions.omitGrants): what
  // was shared with the person stays theirs, never their guest's.
  omitGrants = false,
  // EDIT GRANTS (512): whether a grant shared with the person to edit lets
  // this turn's writes through. createTools derives it once: never on a
  // guest's or linked agent's turn (omitGrants), never on an unattended one
  // (a home turn, a skill or work run, open to injected text). Off unless said.
  editGrants = false,
) {
  // Every capture read below runs on a service-role client in the MCP / unattended
  // paths, so this requester — not RLS — enforces "only me" scope.
  const requester = captureRequester(userId, omitPrivateCaptures)
  // Whom a grant (492) may open a capture to on this turn: the requester, or no one.
  const grantee = grantReader(requester, omitGrants)
  // And a contact (migration 519): no grant on one opens it on such a turn.
  const contactOpts: { grants?: boolean } = omitGrants ? { grants: false } : {}

  /**
   * Resolve a capture id to its workspace AND confirm it is visible to the
   * requester by its own rule. The gate for archiving a capture: no grant,
   * view or edit, passes it (512: an edit grant changes what it says, never
   * whether it is archived).
   */
  const resolveVisibleCapture = async (captureId: string) => {
    const wsResolved = await resolveEntityWorkspace(supabase, userId, 'captures', captureId, workspaceId, strictWorkspace)
    if (!wsResolved) return null
    const visible = await captureVisibleToRequester(supabase, captureId, wsResolved.workspaceId, requester)
    return visible ? wsResolved : null
  }

  /**
   * The gate for a tool that changes what a capture SAYS (update_capture,
   * edit_capture_content): its own rule, or an EDIT grant (512) that shares
   * another member's private capture with the person to edit
   * (captureWriteAccess). Never for archiving it: archive_capture keeps
   * resolveVisibleCapture.
   */
  const resolveEditableCapture = async (captureId: string) => {
    const wsResolved = await resolveEntityWorkspace(supabase, userId, 'captures', captureId, workspaceId, strictWorkspace)
    if (!wsResolved) return null
    const access = await captureWriteAccess(supabase, captureId, wsResolved.workspaceId, requester, editGrants)
    return access ? { ...wsResolved, viaGrant: access === 'grant' } : null
  }

  /**
   * The gate for a tool that only READS a capture: its own rule, or a grant
   * that shares another member's private capture with the person
   * (captureReadAccess). `viaGrant`: readable only through the grant, so the
   * result says it is shared, and `shared` says how (view, or edit: 512).
   */
  const resolveReadableCapture = async (captureId: string) => {
    const wsResolved = await resolveEntityWorkspace(supabase, userId, 'captures', captureId, workspaceId, strictWorkspace)
    if (!wsResolved) return null
    const access = await captureReadAccess(supabase, captureId, wsResolved.workspaceId, requester, undefined, !omitGrants)
    if (!access) return null
    const viaGrant = access === 'grant'
    const toEdit = viaGrant && (await hasEditGrant(supabase, { userId: requester, workspaceId: wsResolved.workspaceId }, 'capture', captureId))
    return { ...wsResolved, viaGrant, shared: viaGrant ? (toEdit ? SHARED_TO_EDIT : SHARED_VIEW_ONLY) : null }
  }

  return {
    list_captures: tool({
      description:
        'List captures, optionally scoped to a project. With no project_id, returns the workspace\'s most recent captures (including those without a project). Use `since` / `until` with a preset (e.g. last_week, past_30_days) or ISO date, plus `time_field` to pick which column to filter on (started_at default).',
      inputSchema: z.object({
        project_id: z
          .string()
          .optional()
          .describe('UUID of a project to scope results to. Omit to list all workspace captures.'),
        ...timeWindowParams,
        time_field: z
          .enum(CAPTURE_TIME_FIELDS)
          .optional()
          .default('started_at')
          .describe(
            'Which date column `since`/`until` apply to. Defaults to `started_at` (when the capture began). ' +
              'Use `created_at` for "captures I created" and `ended_at` for "captures that finished in this window".',
          ),
        limit: z.number().int().min(1).max(200).optional().default(50).describe('Max results (default 50, max 200)'),
      }),
      execute: async ({ project_id, since, until, time_field, limit }) => {
        const cappedLimit = Math.min(limit ?? 50, 200)
        const sinceISO = resolveSince(since)
        const untilISO = resolveUntil(until)
        const timeField = time_field ?? 'started_at'

        let query = supabase
          .from('captures')
          .select(
            'id, workspace_id, project_id, title, content, transcript, duration_seconds, tags, is_pinned, started_at, ended_at, created_at, visibility, user_id',
          )
          .eq('workspace_id', workspaceId)
          .neq('status', 'archived')
          .order('is_pinned', { ascending: false })
          .order('started_at', { ascending: false, nullsFirst: false })
          .order('created_at', { ascending: false })
          .limit(cappedLimit)

        // Plus the private captures shared with the person (a grant, 492): a read.
        const { capture: granted, truncated: grantsTruncated } = await readGrants(supabase, grantee, workspaceId, ['capture'])
        query = applyCaptureVisibility(query, requester, undefined, granted)

        if (project_id) query = query.eq('project_id', project_id)
        if (sinceISO) query = query.gte(timeField, sinceISO)
        if (untilISO) query = query.lte(timeField, untilISO)

        const { data, error } = await query
        if (error) return { success: false, error: error.message }

        const captures = (data || []).map((n) => {
          return {
            id: n.id,
            // Each row names its own workspace, matching list_recent_captures'
            // cross-workspace shape so both lists read the same way.
            workspace_id: n.workspace_id,
            project_id: n.project_id,
            title: n.title,
            content_preview: n.content?.substring(0, 200) || '',
            has_transcript: !!n.transcript,
            duration_seconds: n.duration_seconds,
            tags: n.tags,
            is_pinned: n.is_pinned,
            started_at: n.started_at,
            ended_at: n.ended_at,
            created_at: n.created_at,
            ...(sharedOnly(n, requester) ? { shared_with_you: true } : {}),
          }
        })

        return {
          success: true,
          captures,
          count: captures.length,
          since: sinceISO,
          until: untilISO,
          time_field: timeField,
          ...(grantsTruncated ? { shared_note: GRANTS_TRUNCATED_NOTE } : {}),
        }
      },
    }),

    list_recent_captures: tool({
      description:
        'List the user\'s most recent captures across all workspaces they belong to (or just the active workspace). Use this for "what meetings did I have today/this week" style queries when you don\'t know which workspace the meeting is in.',
      inputSchema: z.object({
        ...timeWindowParams,
        time_field: z
          .enum(CAPTURE_TIME_FIELDS)
          .optional()
          .default('started_at')
          .describe('Which date column `since`/`until` apply to. Defaults to `started_at`.'),
        cross_workspace: z
          .boolean()
          .optional()
          .default(true)
          .describe('Search every workspace the user belongs to. Defaults to true.'),
        limit: z.number().int().min(1).max(100).optional().default(20).describe('Max results (default 20, max 100)'),
      }),
      execute: async ({ since, until, time_field, cross_workspace, limit }) => {
        const sinceISO = resolveSince(since) ?? resolveSince('this_week')
        const untilISO = resolveUntil(until)
        const timeField = time_field ?? 'started_at'
        // A run fenced to one workspace (strictWorkspace) never fans out.
        const targetWorkspaces = cross_workspace && !strictWorkspace
          ? await getUserWorkspaces(supabase, userId)
          : [{ id: workspaceId, name: '' }]

        if (targetWorkspaces.length === 0) {
          return { success: true, captures: [], count: 0, since: sinceISO, until: untilISO }
        }

        const cappedLimit = Math.min(limit ?? 20, 100)

        // Query each workspace independently to avoid skew (one busy workspace
        // dominating the global limit). Each workspace gets `cappedLimit` rows;
        // we merge by started_at and trim to `cappedLimit`.
        const perWorkspace = await Promise.all(
          targetWorkspaces.map(async (w) => {
            let q = supabase
              .from('captures')
              .select(
                'id, workspace_id, project_id, title, duration_seconds, started_at, ended_at, created_at, visibility, user_id',
              )
              .eq('workspace_id', w.id)
              .neq('status', 'archived')
              .order('started_at', { ascending: false, nullsFirst: false })
              .limit(cappedLimit)
            // Grants are per workspace: each one's own (a read).
            const { capture: granted } = await readGrants(supabase, grantee, w.id, ['capture'])
            q = applyCaptureVisibility(q, requester, undefined, granted)
            if (sinceISO) q = q.gte(timeField, sinceISO)
            if (untilISO) q = q.lte(timeField, untilISO)
            const { data, error } = await q
            return { workspace: w, rows: data || [], error: error?.message }
          }),
        )

        const errors = perWorkspace.map((p) => p.error).filter((e): e is string => Boolean(e))
        const merged = perWorkspace
          .flatMap((p) => p.rows.map((c) => ({ row: c, workspace: p.workspace })))
          .sort((a, b) => {
            const ta = a.row.started_at ? new Date(a.row.started_at).getTime() : 0
            const tb = b.row.started_at ? new Date(b.row.started_at).getTime() : 0
            return tb - ta
          })
          .slice(0, cappedLimit)

        const captures = merged.map(({ row: c, workspace }) => {
          return {
            id: c.id,
            workspace_id: c.workspace_id,
            workspace_name: workspace.name,
            project_id: c.project_id,
            title: c.title,
            duration_seconds: c.duration_seconds,
            started_at: c.started_at,
            ended_at: c.ended_at,
            created_at: c.created_at,
            ...(sharedOnly(c, requester) ? { shared_with_you: true } : {}),
          }
        })

        return {
          success: true,
          captures,
          count: captures.length,
          since: sinceISO,
          until: untilISO,
          time_field: timeField,
          searched_workspaces: targetWorkspaces.length,
          ...(errors.length ? { partial_errors: errors } : {}),
        }
      },
    }),

    list_contact_captures: tool({
      description:
        'List captures (meetings) where a specific contact was a participant. Returns captures where the contact spoke, was identified by voice, or was linked manually. Use this to answer "what meetings did I have with X?".',
      inputSchema: z.object({
        contact_id: z.string().describe('UUID of the contact'),
        limit: z.number().int().min(1).max(100).optional().default(20).describe('Max results (default 20, max 100)'),
      }),
      execute: async ({ contact_id, limit }) => {
        const cappedLimit = Math.min(limit ?? 20, 100)

        // `contact_id` is a caller-supplied id, so it ROUTES rather than being
        // pinned to the session: a contact the user can see in another workspace
        // is answerable by id, and a contact in a workspace they do not belong to
        // (or any contact at all, under strictWorkspace) reads as not-found. Every
        // query below is then scoped to the CONTACT's workspace, not the session's
        // — otherwise a routed contact would match captures in the wrong tenant.
        const resolved = await resolveEntityWorkspace(supabase, userId, 'contact', contact_id, workspaceId, strictWorkspace)
        if (!resolved) return { success: false, error: 'Contact not found in this workspace' }

        const { data: contact } = await supabase
          .from('contact')
          .select('id, full_name')
          .eq('id', contact_id)
          .eq('workspace_id', resolved.workspaceId)
          .maybeSingle()

        if (!contact) return { success: false, error: 'Contact not found in this workspace' }
        // Another member's private/team contact: RLS hides it on a user client,
        // but this may run service-role (contact-visibility.ts). Same error as
        // a missing contact, so its existence does not leak either.
        if (!(await isContactVisibleTo(supabase, contact_id, userId, contactOpts))) {
          return { success: false, error: 'Contact not found in this workspace' }
        }

        // Inner-join captures so we can filter by workspace_id on the joined table.
        // The MCP runs under a service-role Supabase client (RLS bypass), so we
        // must enforce workspace isolation ourselves rather than relying on RLS.
        let participantQuery = supabase
          .from('capture_participant')
          .select(
            'speaker_label, voice_match_confidence, capture:capture_id!inner(id, workspace_id, user_id, visibility, title, ai_summary, started_at, ended_at, duration_seconds, status)',
          )
          .eq('contact_id', contact_id)
          .eq('capture.workspace_id', resolved.workspaceId)
          .order('joined_at', { ascending: false, nullsFirst: false })
          .limit(cappedLimit)

        // Plus the private meetings shared with the person (a grant): a read.
        const { capture: grantedList } = await readGrants(supabase, grantee, resolved.workspaceId, ['capture'])
        const granted = new Set(grantedList)
        participantQuery = applyEmbeddedCaptureVisibility(participantQuery, requester, 'capture', undefined, grantedList)

        const { data, error } = await participantQuery

        if (error) return { success: false, error: error.message }

        const captures = (data || [])
          .map((cp) => {
            const c = cp.capture as unknown as
              | {
                  id: string
                  workspace_id: string
                  user_id: string | null
                  visibility: string | null
                  title: string
                  ai_summary: string | null
                  started_at: string | null
                  ended_at: string | null
                  duration_seconds: number | null
                  status: string | null
                }
              | null
            // Defense-in-depth: filter again in TS in case the eq filter failed silently
            if (!c || c.workspace_id !== resolved.workspaceId) return null
            if (!isCaptureVisible(c, requester, undefined, granted)) return null
            return {
              id: c.id,
              workspace_id: c.workspace_id,
              title: c.title,
              started_at: c.started_at,
              ended_at: c.ended_at,
              duration_seconds: c.duration_seconds,
              status: c.status,
              summary_preview: c.ai_summary ? c.ai_summary.substring(0, 280) : null,
              speaker_label: cp.speaker_label,
              voice_match_confidence: cp.voice_match_confidence,
              ...(sharedOnly(c, requester) ? { shared_with_you: true } : {}),
            }
          })
          .filter(Boolean)

        return {
          success: true,
          contact: { id: contact.id, full_name: contact.full_name },
          captures,
          count: captures.length,
          // The contact may have routed this whole read into another workspace.
          workspace_id: resolved.workspaceId,
        }
      },
    }),

    create_capture: tool({
      description: 'Create a new capture in a project.',
      inputSchema: z.object({
        title: z.string().describe('Title of the capture'),
        project_id: z
          .string()
          .optional()
          .describe('UUID of the project (uses default project if not specified)'),
        content: z.string().optional().describe('Capture content (markdown)'),
        tags: z.array(z.string()).optional().describe('Tags'),
        workspace_id: z
          .string()
          .optional()
          .describe('Workspace to create in. Defaults to the active workspace. Copy it from the workspace_id on rows you read, or from active_workspace.'),
      }),
      execute: async ({ title, project_id, content, tags, workspace_id }) => {
        // ROOT create: resolve the tenant BEFORE the default-project lookup —
        // that lookup is the one thing here that reads a workspace, and a default
        // project picked out of the session workspace and written onto a capture
        // in `targetWs` is a cross-tenant FK that also files the meeting under a
        // project nobody in that workspace can open.
        const ws = await resolveCreateWorkspace(supabase, userId, workspaceId, workspace_id, {
          strictWorkspace,
          policy: createWorkspacePolicy,
        })
        if (!ws.ok) return ws.error
        const targetWs = ws.workspaceId

        // If no project_id, get the user's default project IN THE TARGET WORKSPACE.
        let pid = project_id
        if (!pid) {
          const { data: projects } = await supabase
            .from('projects')
            .select('id')
            .eq('user_id', userId)
            .eq('workspace_id', targetWs)
            .eq('is_archived', false)
            .order('created_at')
            .limit(1)
          pid = projects?.[0]?.id
        }

        const { data, error } = await supabase
          .from('captures')
          .insert({
            user_id: userId,
            workspace_id: targetWs,
            project_id: pid,
            title,
            content: content || '',
            tags: tags || [],
          })
          .select('id, title, project_id')
          .single()

        if (error) return { success: false, error: error.message }
        return {
          success: true,
          capture: data,
          message: `Created capture: "${data.title}"`,
          // `visibility` is deliberately absent from the insert: migration 223
          // defaults it to the constant 'workspace' at the column level, so there
          // is no per-workspace setting read here that could carry the session's
          // policy into another tenant.
          ...workspaceEcho(targetWs, ws.workspaceName),
        }
      },
    }),

    update_capture: tool({
      description: 'Update an existing capture.',
      inputSchema: z.object({
        capture_id: z.string().describe('UUID of the capture'),
        title: z.string().optional().describe('New title'),
        content: z.string().optional().describe('New content'),
        tags: z.array(z.string()).optional().describe('New tags'),
        is_pinned: z.boolean().optional().describe('Pin/unpin the capture'),
        summary: z.string().optional().describe('Summary'),
        ai_summary: z.string().optional().describe('AI-generated summary'),
        project_id: z.string().optional().describe('Move to a different project'),
      }),
      execute: async ({
        capture_id,
        title,
        content,
        tags,
        is_pinned,
        summary,
        ai_summary,
        project_id,
      }) => {
        const wsResolved = await resolveEditableCapture(capture_id)
        if (!wsResolved) return { success: false, error: 'Capture not found' }
        // Shared to edit (512): what it says, never where it lives (512's column guard, restated).
        if (wsResolved.viaGrant && (project_id !== undefined || is_pinned !== undefined)) {
          return { success: false, error: 'This capture is shared with you to edit what it says; its project and pin stay its owner\'s.' }
        }

        const updates: Record<string, unknown> = {}
        if (title !== undefined) updates.title = title
        if (content !== undefined) updates.content = content
        if (tags !== undefined) updates.tags = tags
        if (is_pinned !== undefined) updates.is_pinned = is_pinned
        if (summary !== undefined) updates.summary = summary
        if (ai_summary !== undefined) updates.ai_summary = ai_summary
        if (project_id !== undefined) updates.project_id = project_id

        const { data, error } = await supabase
          .from('captures')
          .update(updates)
          .eq('id', capture_id)
          .eq('workspace_id', wsResolved.workspaceId)
          .select('id, title')
          .single()

        if (error) return { success: false, error: error.message }
        return { success: true, capture: data, message: `Updated: "${data.title}"` }
      },
    }),

    archive_capture: tool({
      description: 'Archive a capture (soft delete).',
      inputSchema: z.object({
        capture_id: z.string().describe('UUID of the capture'),
      }),
      execute: async ({ capture_id }) => {
        const wsResolved = await resolveVisibleCapture(capture_id)
        if (!wsResolved) return { success: false, error: 'Capture not found' }

        const { data, error } = await supabase
          .from('captures')
          .update({ status: 'archived' })
          .eq('id', capture_id)
          .eq('workspace_id', wsResolved.workspaceId)
          .select('id, title')
          .single()

        if (error) return { success: false, error: error.message }
        return { success: true, message: `Archived: "${data.title}"` }
      },
    }),

    get_capture_content: tool({
      description:
        'Get a capture\'s metadata, summary, and resolved participants. Does NOT include the raw transcript by default (use include_transcript=true or get_capture_transcript for that). The summary field is whichever of ai_summary/summary/content is non-empty. If you only have a capture name/title, use search first to find the ID.',
      inputSchema: z.object({
        capture_id: z.string().describe('UUID of the capture'),
        include_transcript: z
          .boolean()
          .optional()
          .default(false)
          .describe('Include the transcript\'s first page (about 80K characters). When transcript_has_more is true, continue with get_capture_transcript from transcript_next_offset.'),
        include_raw_fields: z
          .boolean()
          .optional()
          .default(false)
          .describe('Also return the raw content/summary/ai_summary fields. Off by default to avoid duplicating the summary.'),
      }),
      execute: async ({ capture_id, include_transcript, include_raw_fields }) => {
        const wsResolved = await resolveReadableCapture(capture_id)
        if (!wsResolved) return { success: false, error: 'Capture not found' }

        // Always select transcript at the SQL level — it's a single row by id,
        // so the cost is column read, not query plan. The flag only controls
        // whether we include it in the response payload.
        // Sequence the queries: only fetch participants AFTER confirming the
        // capture is in this workspace (MCP runs as service-role, so we must
        // enforce workspace isolation manually).
        const { data, error } = await supabase
          .from('captures')
          .select(
            'id, title, content, transcript, summary, ai_summary, ai_processed, tags, duration_seconds, started_at, ended_at, created_at, project_id',
          )
          .eq('id', capture_id)
          .eq('workspace_id', wsResolved.workspaceId)
          .single()

        if (error) return { success: false, error: error.message }

        const { data: participantRows } = await supabase
          .from('capture_participant')
          .select('speaker_label, role, joined_at, left_at, voice_match_confidence, contact_id, member_id, external_name, external_email, company, job_title, contact:contact_id(id, full_name, email, avatar_url), member:member_id(id, display_name, avatar_url)')
          .eq('capture_id', capture_id)

        const summary = data.ai_summary || data.summary || data.content || ''
        const summaryField: 'ai_summary' | 'summary' | 'content' | 'none' = data.ai_summary
          ? 'ai_summary'
          : data.summary
            ? 'summary'
            : data.content
              ? 'content'
              : 'none'

        // The embedded contact is RLS-hidden on a user client when it is another
        // member's private/team contact; on service role, null it the same way
        // (the participant row's own external_name/email still stand).
        const embeddedContacts = (participantRows || [])
          .map((p) => p.contact as unknown as { id?: unknown } | null)
          .filter((c): c is { id?: unknown } => Boolean(c))
        const visibleContactIds = new Set(
          (await filterVisibleContacts(supabase, userId, embeddedContacts, contactOpts)).map((c) => c.id),
        )

        const participants = (participantRows || []).map((p) => {
          const embedded = p.contact as unknown as { id: string; full_name: string; email: string | null; avatar_url: string | null } | null
          const c = embedded && visibleContactIds.has(embedded.id) ? embedded : null
          const m = p.member as unknown as { id: string; display_name: string | null; avatar_url: string | null } | null
          return {
            speaker_label: p.speaker_label,
            role: p.role,
            joined_at: p.joined_at,
            left_at: p.left_at,
            voice_match_confidence: p.voice_match_confidence,
            contact_id: p.contact_id,
            member_id: p.member_id,
            // Resolved name: contact > member > external_name
            display_name: c?.full_name || m?.display_name || p.external_name || null,
            email: c?.email || p.external_email || null,
            avatar_url: c?.avatar_url || m?.avatar_url || null,
            // Company and job title can come from web enrichment: fenced (web-derived.ts).
            company: webText(p.company),
            job_title: webText(p.job_title),
          }
        })

        return {
          success: true,
          capture: {
            id: data.id,
            // resolveVisibleCapture may have routed this read to another workspace
            // the user belongs to — say which one rather than leaving the agent to
            // assume the active one.
            workspace_id: wsResolved.workspaceId,
            title: data.title,
            summary,
            summary_field: summaryField,
            participants,
            tags: data.tags,
            duration_seconds: data.duration_seconds,
            started_at: data.started_at,
            ended_at: data.ended_at,
            created_at: data.created_at,
            project_id: data.project_id,
            // Another member's private capture, shared with the person (a grant): what they may do with it.
            ...(wsResolved.shared ?? {}),
            ...(include_transcript ? transcriptFirstPage(data.transcript) : {}),
            ...(include_raw_fields
              ? {
                  raw: {
                    content: data.content || null,
                    summary: data.summary || null,
                    ai_summary: data.ai_summary || null,
                  },
                }
              : {}),
          },
        }
      },
    }),

    get_capture_transcript: tool({
      description:
        `Get a capture's raw transcript, a page at a time: about ${TRANSCRIPT_PAGE_CHARS / 1000}K characters from line \`offset\` by default. When \`has_more\` is true, call again with \`offset: next_offset\`. Pass \`limit\` (lines) to read exactly that many lines, uncapped. Prefer get_capture_content's summary unless you need the exact words.`,
      inputSchema: z.object({
        capture_id: z.string().describe('UUID of the capture'),
        offset: z.number().optional().default(0).describe('Line offset to start from (0 = beginning); use next_offset to continue'),
        limit: z
          .number()
          .optional()
          .describe(`Lines to return, with no size cap. Omit for a page of about ${TRANSCRIPT_PAGE_CHARS / 1000}K characters.`),
      }),
      execute: async ({ capture_id, offset, limit }) => {
        const wsResolved = await resolveReadableCapture(capture_id)
        if (!wsResolved) return { success: false, error: 'Capture not found' }

        const { data, error } = await supabase
          .from('captures')
          .select('id, title, transcript, duration_seconds')
          .eq('id', capture_id)
          .eq('workspace_id', wsResolved.workspaceId)
          .single()

        if (error) return { success: false, error: error.message }
        if (!data.transcript) {
          return {
            success: true,
            capture_id,
            workspace_id: wsResolved.workspaceId,
            total_lines: 0,
            transcript: '',
            has_more: false,
          }
        }

        const lines = data.transcript.split('\n')
        const start = Math.max(0, offset ?? 0)
        const end = limit !== undefined ? Math.min(lines.length, start + Math.max(0, limit)) : transcriptPageEnd(lines, start)
        const slice = lines.slice(start, end)
        const hasMore = end < lines.length

        return {
          success: true,
          capture_id: data.id,
          workspace_id: wsResolved.workspaceId,
          title: data.title,
          duration_seconds: data.duration_seconds,
          total_lines: lines.length,
          offset: start,
          returned_lines: slice.length,
          has_more: hasMore,
          ...(hasMore ? { next_offset: end } : {}),
          transcript: transcriptForModel(slice.join('\n')),
        }
      },
    }),

    edit_capture_content: tool({
      description:
        'Make a surgical text edit to a capture field. Finds the exact old_text and replaces it with new_text. Use this instead of update_capture when the user asks to change specific text in a capture they are viewing.',
      inputSchema: z.object({
        capture_id: z.string().describe('UUID of the capture'),
        field: z.enum(['ai_summary', 'content']).describe('Which field to edit. Use the editor_field from get_capture_content or editorSelection context to know which field the user sees.'),
        old_text: z.string().describe('The exact text to find and replace. Must match exactly (including whitespace and punctuation).'),
        new_text: z.string().describe('The replacement text.'),
      }),
      execute: async ({ capture_id, field, old_text, new_text }) => {
        const wsResolved = await resolveEditableCapture(capture_id)
        if (!wsResolved) return { success: false, error: 'Capture not found' }

        // 1. Read the current value of the specific field
        const { data, error } = await supabase
          .from('captures')
          .select(`id, title, ${field}`)
          .eq('id', capture_id)
          .eq('workspace_id', wsResolved.workspaceId)
          .single()

        if (error) return { success: false, error: error.message }

        const currentValue = (data as unknown as Record<string, string | null>)[field] || ''

        // 2. Check old_text exists exactly once
        const occurrences = currentValue.split(old_text).length - 1
        if (occurrences === 0) {
          return {
            success: false,
            error: `Text not found in field "${field}". Make sure old_text matches exactly, including whitespace and punctuation.`,
          }
        }
        if (occurrences > 1) {
          return {
            success: false,
            error: `Found ${occurrences} occurrences of old_text in field "${field}". Provide more surrounding context to make the match unique.`,
          }
        }

        // 3. Replace and write back
        // A function replacement keeps new_text literal: a string replacement
        // would expand `$&`, `$$`, `$'` and `` $` `` inside it.
        const newValue = currentValue.replace(old_text, () => new_text)
        const { error: updateError } = await supabase
          .from('captures')
          .update({ [field]: newValue })
          .eq('id', capture_id)
          .eq('workspace_id', wsResolved.workspaceId)

        if (updateError) return { success: false, error: updateError.message }

        return {
          success: true,
          field,
          old_text,
          new_text,
          message: `Edited ${field} in "${data.title}"`,
        }
      },
    }),

    get_capture_extractions: tool({
      description:
        'Get the AI-extracted actions and decisions from a processed capture, including their confirmation status. ' +
        'Returns both pending proposals (confirmation: "suggested") from the live-agent review queue and ' +
        'items already in the actions/decision tables with their stored confirmation ("confirmed" or "suggested"; dismissed ones are left out).',
      inputSchema: z.object({
        capture_id: z.string().describe('UUID of the capture'),
      }),
      execute: async ({ capture_id }) => {
        const wsResolved = await resolveReadableCapture(capture_id)
        if (!wsResolved) return { success: false, error: 'Capture not found' }

        // Query confirmed/applied items from their final tables AND pending
        // proposals from the proposed_change staging table.
        //
        // Background: the live agent stages all extracted items in `proposed_change`
        // (with status='pending') and embeds <!-- proposal:UUID --> markers in
        // ai_summary. Items only land in `actions`/`decision` after the user clicks
        // Apply. Querying only those tables therefore returns zero results for any
        // capture where the user hasn't yet reviewed the proposals.
        const [
          { data: actions, error: actionsError },
          { data: decisions, error: decisionsError },
          { data: pendingProposalRows, error: proposalsError },
        ] = await Promise.all([
          supabase
            .from('actions')
            .select('id, identifier, title, confirmation, ai_confidence, context_data, assignee_id, due_at')
            .eq('source_capture_id', capture_id)
            .eq('workspace_id', wsResolved.workspaceId),
          supabase
            .from('decision')
            .select('id, content, confirmation, created_at')
            .eq('capture_id', capture_id),
          supabase
            .from('proposed_change')
            .select('id, entity_type, change_type, title, display_text, assignee_name, due_date, confidence, priority, description, status, created_at')
            .eq('capture_id', capture_id)
            .eq('workspace_id', wsResolved.workspaceId)
            .eq('status', 'pending')
            .order('sort_order', { ascending: true }),
        ])
        // The review queue is the capture owner's to work through: its read
        // policy never followed grants (493 left proposed_change as it was),
        // so a capture shared with the person shows what was kept, not what is
        // still waiting on its owner.
        const pendingProposals = wsResolved.viaGrant ? [] : pendingProposalRows

        if (actionsError) return { success: false, error: actionsError.message }
        if (decisionsError) return { success: false, error: decisionsError.message }
        if (proposalsError) return { success: false, error: proposalsError.message }

        // Rows already in actions/decision, with their REAL confirmation: a
        // row there can still be 'suggested' (decision defaults to it), and a
        // dismissed one is not an extraction anyone kept, so it is left out.
        const storedActionsSummary = (actions || [])
          .filter((a) => a.confirmation !== 'dismissed')
          .map((a) => ({
            id: a.id,
            proposal_id: null,
            identifier: a.identifier,
            title: a.title,
            confirmation: a.confirmation as string,
            ai_confidence: a.ai_confidence,
            owner: (a.context_data as Record<string, unknown>)?.original_owner || null,
            due_at: a.due_at,
          }))

        const storedDecisionsSummary = (decisions || [])
          .filter((d) => d.confirmation !== 'dismissed')
          .map((d) => ({
            id: d.id,
            proposal_id: null,
            content: d.content,
            confirmation: d.confirmation as string,
          }))

        // Pending proposals that haven't been reviewed yet — these are the
        // "suggested" items that agents and the UI need to surface.
        const pendingActionsSummary = (pendingProposals || [])
          .filter((p) => p.entity_type === 'action' && p.change_type === 'create')
          .map((p) => ({
            id: p.id,
            proposal_id: p.id,
            identifier: null,
            title: p.title || p.display_text,
            confirmation: 'suggested' as const,
            ai_confidence: p.confidence,
            owner: p.assignee_name || null,
            due_at: p.due_date || null,
            description: p.description || null,
            priority: p.priority || null,
          }))

        const pendingDecisionsSummary = (pendingProposals || [])
          .filter((p) => p.entity_type === 'decision' && p.change_type === 'create')
          .map((p) => ({
            id: p.id,
            proposal_id: p.id,
            content: p.title || p.display_text,
            confirmation: 'suggested' as const,
          }))

        const actionsSummary = [...pendingActionsSummary, ...storedActionsSummary]
        const decisionsSummary = [...pendingDecisionsSummary, ...storedDecisionsSummary]
        const countOf = (rows: Array<{ confirmation: string }>, value: string) =>
          rows.filter((r) => r.confirmation === value).length

        return {
          success: true,
          // Everything below was read from — and belongs to — this workspace,
          // which is not necessarily the session's active one.
          workspace_id: wsResolved.workspaceId,
          ...(wsResolved.shared ?? {}),
          actions: actionsSummary,
          decisions: decisionsSummary,
          summary: {
            total_actions: actionsSummary.length,
            suggested_actions: countOf(actionsSummary, 'suggested'),
            confirmed_actions: countOf(actionsSummary, 'confirmed'),
            total_decisions: decisionsSummary.length,
            suggested_decisions: countOf(decisionsSummary, 'suggested'),
          },
        }
      },
    }),

    list_recipes: tool({
      description:
        'List capture recipes available in this workspace. Recipes define how AI processes a ' +
        'capture (meeting, standup, brainstorm, 1:1, etc.) — each has its own system prompt and ' +
        'extraction config. Returns workspace-specific recipes plus system recipes available to ' +
        'all workspaces.',
      inputSchema: z.object({
        include_system: z
          .boolean()
          .optional()
          .default(true)
          .describe('Include built-in system recipes (Meeting, Standup, etc.). On by default.'),
      }),
      execute: async ({ include_system }) => {
        // Workspace recipes the caller can see. This runs on the SERVICE
        // client, so recipe_select_visibility never fires: without the filter,
        // every member's PERSONAL skills and agents were listed here.
        const { data: workspaceRecipes, error: wsErr } = await supabase
          .from('recipe')
          .select('id, name, icon, color, description, category, is_default, is_system, sort_order')
          .eq('workspace_id', workspaceId)
          .or(visibleRecipesFilter(workspaceId, userId))
          .order('sort_order', { ascending: true })
        if (wsErr) return { success: false, error: wsErr.message }

        let systemRecipes: typeof workspaceRecipes = []
        if (include_system !== false) {
          // System recipes have workspace_id IS NULL — they're shared across
          // all workspaces (e.g. the built-in "Meeting" recipe) — less the
          // feature-owned ones this workspace does not have (feature-gate.ts).
          const { data, error } = await excludeFeatureGatedRecipes(
            supabase
              .from('recipe')
              .select('id, name, icon, color, description, category, is_default, is_system, sort_order')
              .is('workspace_id', null)
              .eq('is_system', true),
            featureGatedRecipeExclusions(await resolveWorkspaceEdition(supabase, workspaceId)),
          ).order('sort_order', { ascending: true })
          if (error) return { success: false, error: error.message }
          systemRecipes = data
        }

        const recipes = [
          ...(workspaceRecipes || []).map((r) => ({ ...r, scope: 'workspace' as const })),
          ...(systemRecipes || []).map((r) => ({ ...r, scope: 'system' as const })),
        ]

        return {
          success: true,
          recipes,
          count: recipes.length,
          // Surface the workspace default explicitly — most agents want this
          // when they only need to pick "the right recipe" without prompting.
          default_recipe_id:
            (workspaceRecipes || []).find((r) => r.is_default)?.id ?? null,
        }
      },
    }),

  }
}
