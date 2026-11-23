/**
 * What an import is matched against, read on the PERSON'S OWN client: the
 * teams they can write to, a team's workflow states, the workspace's members,
 * labels and projects. Only members who already exist are ever assigned; an
 * import never invites or makes a person.
 *
 * A member's email lives on auth.users, which only the service client reads;
 * it is used here to match a file's or Linear's assignee and never leaves the
 * server (a preview names people, not addresses).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { MatchContext, MemberOption, NamedOption, StateOption } from './tasks/plan'

export interface TeamOption {
  id: string
  name: string
  key: string | null
}

/**
 * The teams the person can put tasks in: every team of the workspace but a
 * private one they are not on (673's rule, checked here too so it holds on
 * any client).
 */
export async function listTeams(db: SupabaseClient, workspaceId: string, memberId: string): Promise<TeamOption[]> {
  const { data, error } = await db.from('team').select('id, name, issue_prefix, is_private').eq('workspace_id', workspaceId).order('name')
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as Array<{ id: string; name: string; issue_prefix?: string | null; is_private?: boolean | null }>
  let onPrivate = new Set<string>()
  const privateIds = rows.filter((t) => t.is_private).map((t) => t.id)
  if (privateIds.length) {
    const { data: mine } = await db.from('team_member').select('team_id').eq('member_id', memberId).in('team_id', privateIds)
    onPrivate = new Set(((mine ?? []) as Array<{ team_id: string }>).map((r) => r.team_id))
  }
  return rows.filter((t) => !t.is_private || onPrivate.has(t.id)).map((t) => ({ id: t.id, name: t.name, key: t.issue_prefix ?? null }))
}

export async function teamStates(db: SupabaseClient, teamId: string): Promise<StateOption[]> {
  const { data, error } = await db.from('workflow_state').select('id, name, category, is_default, sort_order').eq('team_id', teamId).order('sort_order')
  if (error) throw new Error(error.message)
  return (data ?? []) as StateOption[]
}

export async function workspaceMembers(db: SupabaseClient, svc: SupabaseClient, workspaceId: string): Promise<MemberOption[]> {
  const { data, error } = await db.from('member').select('id, user_id, display_name, role').eq('workspace_id', workspaceId)
  if (error) throw new Error(error.message)
  const rows = ((data ?? []) as Array<{ id: string; user_id: string; display_name: string | null; role: string | null }>).filter((m) => m.role !== 'guest')
  const out: MemberOption[] = []
  for (const m of rows.slice(0, 500)) {
    let email: string | null = null
    try {
      const { data: u } = await svc.auth.admin.getUserById(m.user_id)
      email = u?.user?.email?.toLowerCase() ?? null
    } catch {
      /* matched by name only */
    }
    out.push({ id: m.id, name: m.display_name, email })
  }
  return out
}

export async function workspaceLabels(db: SupabaseClient, workspaceId: string): Promise<NamedOption[]> {
  const { data, error } = await db.from('label').select('id, name').eq('workspace_id', workspaceId).limit(2000)
  if (error) throw new Error(error.message)
  return (data ?? []) as NamedOption[]
}

export async function workspaceProjects(db: SupabaseClient, workspaceId: string): Promise<NamedOption[]> {
  const { data, error } = await db.from('projects').select('id, name').eq('workspace_id', workspaceId).neq('name', '__default__').limit(2000)
  if (error) throw new Error(error.message)
  return (data ?? []) as NamedOption[]
}

/** Everything a task import of one team is matched against. */
export async function loadMatchContext(db: SupabaseClient, svc: SupabaseClient, workspaceId: string, teamId: string): Promise<MatchContext> {
  const [states, members, labels, projects] = await Promise.all([teamStates(db, teamId), workspaceMembers(db, svc, workspaceId), workspaceLabels(db, workspaceId), workspaceProjects(db, workspaceId)])
  return { teamId, states, members, labels, projects }
}
