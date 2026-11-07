import { requireUser } from '@/lib/api-auth'
import { badRequest, serverError, sessionExpired } from '@/lib/api-errors'
import {
  getCurrentWorkspaceId,
  resolveMemberIdsForUser,
  WorkspaceLookupError,
} from '@/lib/workspace'
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
 */

const MAX_REFS = 50
// First char a letter, then 1–9 more of [A-Z0-9], a dash, then digits. Matches
// the client-side splitter in remark-entity-refs.ts / entity-ref-decorations.ts.
const REF_RE = /^[A-Z][A-Z0-9]{1,9}-\d+$/

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

  // Parse, normalise and validate the requested identifiers. Malformed entries
  // are ignored (not an error) — the chip layer deliberately over-matches.
  const raw = request.nextUrl.searchParams.get('refs') ?? ''
  const refs = Array.from(
    new Set(
      raw
        .split(',')
        .map((r) => r.trim().toUpperCase())
        .filter((r) => REF_RE.test(r)),
    ),
  )

  if (refs.length === 0) return NextResponse.json({ refs: {} })
  if (refs.length > MAX_REFS) {
    return badRequest(`Too many refs (max ${MAX_REFS})`)
  }

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

  if (workspaceIds.length === 0) return NextResponse.json({ refs: {} })

  const { data, error } = await supabase
    .from('actions')
    .select(SELECT)
    .in('identifier', refs)
    .in('workspace_id', workspaceIds)

  if (error) return serverError(error.message)

  const currentWorkspaceId = await getCurrentWorkspaceId().catch(() => null)

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

  const result: Record<string, ReturnType<typeof shape>> = {}
  for (const [identifier, rows] of byIdentifier) {
    if (rows.length === 1) {
      result[identifier] = shape(rows[0])
      continue
    }
    // Ambiguous across workspaces → prefer the current one, else omit.
    const preferred = currentWorkspaceId
      ? rows.find((r) => r.workspace_id === currentWorkspaceId)
      : undefined
    if (preferred) result[identifier] = shape(preferred)
  }

  return NextResponse.json({ refs: result })
}
