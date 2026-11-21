import type { SupabaseClient } from '@supabase/supabase-js'
import { requireUser } from '@/lib/api-auth'
import { badRequest, serverError, sessionExpired } from '@/lib/api-errors'
import {
  getCurrentWorkspaceId,
  resolveMemberIdsForUser,
  WorkspaceLookupError,
} from '@/lib/workspace'
import {
  isMentionableType,
  mentionKey,
  type MentionableType,
  type MentionRef,
} from '@/lib/entity-links/mentionable'
import { visibleMentionTargets } from '@/lib/entity-links/mentions'
import { LABEL_TABLE } from '@/lib/knowledge/entity-registry'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * Resolve action identifiers (GEN-297, ENG-42, …) to the live action they name,
 * across EVERY workspace the caller is a member of. This is the authenticated
 * backing for the inline identifier chips an agent writes into chat answers and
 * documents: an identifier that resolves to a real action renders as an
 * interactive chip; one that doesn't (COVID-19, ISO-8601, GEN-9999) stays plain
 * text, so the chip layer can over-match freely and let this endpoint be the
 * arbiter of what is real.
 *
 * GET /api/account/entities/resolve?refs=GEN-297,GEN-262
 *   → { refs: { [identifier]: { id, workspace_id, team_id, identifier, title,
 *        status | null, assignee | null, priority, due_date | null, project | null } } }
 *
 * Scope: the query is constrained to the workspaces the user actually belongs
 * to (member rows by user_id) AND runs on the RLS client, so it can never
 * surface an action from a workspace the caller isn't in. Identifiers are a
 * per-workspace key, so the same identifier can exist in more than one of the
 * caller's workspaces — when it does we prefer the current workspace, and
 * otherwise omit it as ambiguous rather than guess.
 *
 * It also resolves typed MENTION refs for the live chips every kind now draws
 * (docs/plans/mentions-everywhere.md, 3.6):
 *
 * GET /api/account/entities/resolve?mentions=document:<uuid>,action:<uuid>
 *   → { mentions: { "<type>:<id>": { type, id, label, status | null } } }
 *
 * The two are independent: `refs` keeps its exact behaviour and response, and
 * `mentions` is answered only when its param is present. Mentions are fenced in
 * the CURRENT workspace with `visibleMentionTargets` (the same per-kind rules
 * every stored mention is fenced by) and then labelled with `LABEL_TABLE` on
 * the caller's own RLS client, so the answer carries only what the caller may
 * read; anything else is simply absent, and its chip stays the stored words.
 */

const MAX_REFS = 50
const MAX_MENTIONS = 50
// First char a letter, then 1–9 more of [A-Z0-9], a dash, then digits. Matches
// the client-side splitter in remark-entity-refs.ts / entity-ref-decorations.ts.
const REF_RE = /^[A-Z][A-Z0-9]{1,9}-\d+$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Status read where it is one cheap column or join: an action's workflow state name, a project/initiative/campaign status. */
const MENTION_STATUS_SELECT: Partial<Record<MentionableType, string>> = {
  action: 'workflow_state:workflow_state!status_id(name)',
  project: 'status',
  initiative: 'status',
  campaign: 'status',
}

function mentionStatusOf(type: MentionableType, row: Record<string, unknown>): string | null {
  if (type === 'action') {
    const ws = one(row.workflow_state as { name?: unknown } | { name?: unknown }[] | null | undefined)
    return ws && typeof ws.name === 'string' ? ws.name : null
  }
  if (type === 'project' || type === 'initiative' || type === 'campaign') {
    return typeof row.status === 'string' && row.status ? row.status : null
  }
  return null
}

/**
 * Parse `mentions=type:id,type:id`: distinct, well-formed pairs whose type is
 * mentionable and id a uuid. Malformed entries are dropped (the chip layer
 * over-matches, as with refs).
 */
function parseMentions(raw: string): MentionRef[] {
  const out = new Map<string, MentionRef>()
  for (const tok of raw.split(',')) {
    const t = tok.trim()
    if (!t) continue
    const colon = t.indexOf(':')
    if (colon < 0) continue
    const type = t.slice(0, colon)
    const id = t.slice(colon + 1).toLowerCase()
    if (!isMentionableType(type) || !UUID_RE.test(id)) continue
    const ref: MentionRef = { type, id }
    out.set(mentionKey(ref), ref)
  }
  return [...out.values()]
}

interface ResolvedMention {
  type: MentionableType
  id: string
  label: string
  status: string | null
}

/**
 * The visible mentions among `pairs`, labelled. Fenced for the caller in
 * `workspaceId` first (every per-kind rule a stored mention obeys), then each
 * visible kind's label (and a cheap status) read on the caller's RLS client.
 * A kind whose table a session client can't read (the Studio's) simply yields
 * no label — the chip keeps its stored words.
 */
async function resolveMentions(
  supabase: SupabaseClient,
  scope: { workspaceId: string; userId: string },
  pairs: MentionRef[],
): Promise<Record<string, ResolvedMention>> {
  const visible = await visibleMentionTargets(supabase, scope, pairs)
  if (visible.length === 0) return {}
  const byType = new Map<MentionableType, string[]>()
  for (const r of visible) (byType.get(r.type) ?? byType.set(r.type, []).get(r.type)!).push(r.id)

  const out: Record<string, ResolvedMention> = {}
  await Promise.all(
    [...byType.entries()].map(async ([type, ids]) => {
      const spec = LABEL_TABLE[type]
      if (!spec) return
      const statusSelect = MENTION_STATUS_SELECT[type]
      const select = `id, ${spec.columns}${statusSelect ? `, ${statusSelect}` : ''}`
      const { data, error } = await supabase.from(spec.table).select(select).in('id', ids)
      if (error || !data) return
      for (const row of data as unknown as Array<Record<string, unknown>>) {
        const id = typeof row.id === 'string' ? row.id.toLowerCase() : null
        if (!id) continue
        out[`${type}:${id}`] = { type, id, label: spec.label(row), status: mentionStatusOf(type, row) }
      }
    }),
  )
  return out
}

const SELECT = `
  id, workspace_id, team_id, identifier, title, status_id, assignee_id, assignee_contact_id, due_at, priority, project_id,
  workflow_state:workflow_state!status_id(id, name, category, color),
  assignee:member!assignee_id(id, display_name),
  project:projects!project_id(id, name)
`

interface ActionRow {
  id: string
  workspace_id: string
  team_id: string | null
  identifier: string
  title: string | null
  priority: string | null
  due_at: string | null
  workflow_state:
    | { id: string; name: string; category: string; color: string | null }
    | { id: string; name: string; category: string; color: string | null }[]
    | null
  assignee:
    | { id: string; display_name: string | null }
    | { id: string; display_name: string | null }[]
    | null
  project:
    | { id: string; name: string | null }
    | { id: string; name: string | null }[]
    | null
}

/** PostgREST returns an embedded to-one either as an object or a single-element
 *  array depending on how the relationship is inferred — normalise to one. */
function one<T>(embed: T | T[] | null | undefined): T | null {
  if (Array.isArray(embed)) return embed[0] ?? null
  return embed ?? null
}

/** `due_at` is a timestamptz. Return the full instant: the client's date
 *  field shows it as the viewer's LOCAL day. A `YYYY-MM-DD` cut here was the
 *  UTC day, which the client read as a local date (a day off across midnight)
 *  and wrote back on a failed edit's rollback. */
function toDueDate(dueAt: string | null): string | null {
  if (!dueAt) return null
  const d = new Date(dueAt)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

function shape(row: ActionRow) {
  const ws = one(row.workflow_state)
  const assignee = one(row.assignee)
  const project = one(row.project)
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    team_id: row.team_id,
    identifier: row.identifier,
    title: row.title ?? '',
    status: ws
      ? { id: ws.id, name: ws.name, category: ws.category, color: ws.color }
      : null,
    assignee:
      assignee && assignee.display_name
        ? { id: assignee.id, name: assignee.display_name }
        : null,
    priority: row.priority ?? null,
    due_date: toDueDate(row.due_at),
    project: project ? { id: project.id, name: project.name ?? '' } : null,
  }
}

export async function GET(request: NextRequest) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { supabase, user } = auth
  const params = request.nextUrl.searchParams

  // Mentions (type:id,…) are answered only when the param is present, so a
  // caller that only sends `refs=` gets exactly today's response.
  const rawMentions = params.get('mentions')
  const mentionsRequested = rawMentions !== null
  const mentionPairs = mentionsRequested ? parseMentions(rawMentions) : []
  if (mentionPairs.length > MAX_MENTIONS) {
    return badRequest(`Too many mentions (max ${MAX_MENTIONS})`)
  }

  // Parse, normalise and validate the requested identifiers. Malformed entries
  // are ignored (not an error) — the chip layer deliberately over-matches.
  const raw = params.get('refs') ?? ''
  const refs = Array.from(
    new Set(
      raw
        .split(',')
        .map((r) => r.trim().toUpperCase())
        .filter((r) => REF_RE.test(r)),
    ),
  )
  if (refs.length > MAX_REFS) {
    return badRequest(`Too many refs (max ${MAX_REFS})`)
  }

  // Both halves want the current workspace: refs for disambiguation, mentions
  // for their fence.
  const currentWorkspaceId = await getCurrentWorkspaceId().catch(() => null)

  // ── refs ──────────────────────────────────────────────────────────────────
  const refResult: Record<string, ReturnType<typeof shape>> = {}
  if (refs.length > 0) {
    // The workspaces the user belongs to (member rows by user_id). Scoping the
    // query to these ids matches the RLS boundary and keeps the lookup honest
    // even if a policy were ever loosened.
    let workspaceIds: string[]
    try {
      const memberships = await resolveMemberIdsForUser(supabase, user.id)
      workspaceIds = memberships.map((m) => m.workspaceId)
    } catch (err) {
      if (err instanceof WorkspaceLookupError) {
        return err.kind === 'session_expired' ? sessionExpired() : serverError()
      }
      throw err
    }

    if (workspaceIds.length > 0) {
      const { data, error } = await supabase
        .from('actions')
        .select(SELECT)
        .in('identifier', refs)
        .in('workspace_id', workspaceIds)

      if (error) return serverError(error.message)

      // Group by identifier so ambiguity (same identifier in >1 of the caller's
      // workspaces) can be resolved deterministically.
      const byIdentifier = new Map<string, ActionRow[]>()
      for (const row of (data ?? []) as unknown as ActionRow[]) {
        const key = row.identifier?.toUpperCase()
        if (!key) continue
        const list = byIdentifier.get(key)
        if (list) list.push(row)
        else byIdentifier.set(key, [row])
      }

      for (const [identifier, rows] of byIdentifier) {
        if (rows.length === 1) {
          refResult[identifier] = shape(rows[0])
          continue
        }
        // Ambiguous across workspaces → prefer the current one, else omit.
        const preferred = currentWorkspaceId
          ? rows.find((r) => r.workspace_id === currentWorkspaceId)
          : undefined
        if (preferred) refResult[identifier] = shape(preferred)
      }
    }
  }

  if (!mentionsRequested) return NextResponse.json({ refs: refResult })

  // ── mentions ──────────────────────────────────────────────────────────────
  // No current workspace, nothing to fence against → an empty answer (every
  // mention stays its stored words).
  const mentions =
    mentionPairs.length > 0 && currentWorkspaceId
      ? await resolveMentions(supabase, { workspaceId: currentWorkspaceId, userId: user.id }, mentionPairs)
      : {}
  return NextResponse.json({ refs: refResult, mentions })
}
