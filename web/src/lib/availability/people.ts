/**
 * Who "find a time with Dana and Lee" means: the names or sign-in emails the
 * person gave, matched against the members of the workspace, never guessed.
 *
 *   An email matches the member signed in with it.
 *   A name matches a member's display name: the whole name (any case), or
 *   every word given equal to one of the name's words, a single letter or
 *   "W." standing for a word's initial ("Dana", "dana w"). One member
 *   matching is that member; more than one is ambiguous and comes back
 *   naming them (with their emails, so the next call can be exact); none
 *   comes back naming who is in the workspace.
 *
 * The person asking is always included and is never "another" person, so
 * naming themselves changes nothing. Emails cost an admin lookup per member
 * (src/lib/workspace-member-emails.ts, kept a minute), so they are read only
 * when an email is given or a name is ambiguous.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { listMemberEmails } from '@/lib/workspace-member-emails'
import { readSharingValue, type AvailabilitySharing } from './sharing'

/** The most people one request covers, the person asking included. */
export const TEAM_MAX_PEOPLE = 12
/** The most names an unknown name's error lists. */
const CANDIDATES_MAX = 20

export interface WorkspacePerson {
  memberId: string
  userId: string
  name: string
  role: string
  sharing: AvailabilitySharing
  /** Their sign-in email, lower-cased, when it was read. */
  email?: string
}

export type ResolvedPeople = { ok: true; requester: WorkspacePerson; others: WorkspacePerson[] } | { ok: false; error: string; ambiguous?: boolean }

const norm = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ')
const words = (value: string) => norm(value).split(' ').filter(Boolean)

/** Whether `query` names the member called `name` (see the header). Pure. */
export function nameMatches(query: string, name: string): boolean {
  const q = norm(query)
  if (!q) return false
  if (q === norm(name)) return true
  const nameWords = words(name).map((w) => w.replace(/[.,]/g, ''))
  const queryWords = words(q).map((w) => w.replace(/,/g, ''))
  if (!queryWords.length || !nameWords.length) return false
  const isInitial = (w: string) => /^\p{L}\.?$/u.test(w)
  // Initials alone ("D.") name nobody.
  if (queryWords.every(isInitial)) return false
  return queryWords.every((w) => nameWords.some((n) => (isInitial(w) ? n.startsWith(w[0]) : n === w.replace(/\.$/, ''))))
}

function described(person: WorkspacePerson): string {
  return person.email ? `${person.name} (${person.email})` : person.name
}

/**
 * The members `asked` names, the person asking apart. An unknown or
 * ambiguous name is an error naming the candidates. Pure.
 */
export function resolvePeople(asked: readonly string[], members: readonly WorkspacePerson[], requesterUserId: string): ResolvedPeople {
  const requester = members.find((m) => m.userId === requesterUserId)
  if (!requester) return { ok: false, error: 'You are not a member of this workspace.' }
  const others = new Map<string, WorkspacePerson>()
  const problems: string[] = []
  let ambiguous = false
  for (const raw of asked) {
    const query = raw.trim()
    if (!query) continue
    let hits: WorkspacePerson[]
    if (query.includes('@')) {
      const email = norm(query)
      hits = members.filter((m) => m.email === email)
    } else {
      const exact = members.filter((m) => norm(m.name) === norm(query))
      hits = exact.length ? exact : members.filter((m) => nameMatches(query, m.name))
    }
    if (hits.length === 1) {
      if (hits[0].userId !== requesterUserId) others.set(hits[0].userId, hits[0])
      continue
    }
    if (hits.length > 1) {
      ambiguous = true
      problems.push(`"${query}" could be ${hits.map(described).join(', ')}`)
      continue
    }
    const everyone = members.filter((m) => m.userId !== requesterUserId)
    const list = everyone.slice(0, CANDIDATES_MAX).map((m) => m.name).join(', ')
    problems.push(
      `"${query}" is not a member of this workspace` +
        (everyone.length ? ` (its members: ${list}${everyone.length > CANDIDATES_MAX ? ', and more' : ''})` : ' (nobody else is in it)'),
    )
  }
  if (problems.length) {
    return {
      ok: false,
      ambiguous,
      error: `${problems.join('; ')}. Ask the person which one they mean, or pass the exact name or email; never pick one. Only members of this workspace can be included: an outside guest's calendar cannot be seen.`,
    }
  }
  if (others.size + 1 > TEAM_MAX_PEOPLE) return { ok: false, error: `At most ${TEAM_MAX_PEOPLE} people at once, you included.` }
  return { ok: true, requester, others: [...others.values()] }
}

interface MemberRow {
  id?: unknown
  user_id?: unknown
  display_name?: unknown
  role?: unknown
  availability_sharing?: unknown
}

/** The workspace's members, as resolvePeople reads them. Throws on a failed read. */
export async function readWorkspacePeople(supabase: SupabaseClient, workspaceId: string, options: { emails?: boolean; listEmails?: typeof listMemberEmails } = {}): Promise<WorkspacePerson[]> {
  const [rows, emails] = await Promise.all([
    supabase.from('member').select('id, user_id, display_name, role, availability_sharing').eq('workspace_id', workspaceId),
    options.emails ? (options.listEmails ?? listMemberEmails)(workspaceId) : Promise.resolve([]),
  ])
  if (rows.error) throw new Error(`Workspace members could not be read: ${rows.error.message}`)
  const emailOf = new Map(emails.map((e) => [e.userId, e.email]))
  return ((rows.data as MemberRow[] | null) ?? [])
    .filter((r): r is MemberRow & { id: string; user_id: string } => typeof r.id === 'string' && typeof r.user_id === 'string')
    .map((r) => {
      const email = emailOf.get(r.user_id)
      return {
        memberId: r.id,
        userId: r.user_id,
        name: typeof r.display_name === 'string' && r.display_name.trim() ? r.display_name.trim() : email ?? '(unnamed)',
        role: typeof r.role === 'string' ? r.role : 'member',
        sharing: readSharingValue(r.availability_sharing),
        ...(email ? { email } : {}),
      }
    })
}

/**
 * The members `asked` names in the workspace (see the header): the emails
 * read only when one is given, or to tell an ambiguous name's members apart.
 */
export async function findWorkspacePeople(
  supabase: SupabaseClient,
  workspaceId: string,
  requesterUserId: string,
  asked: readonly string[],
  deps: { listEmails?: typeof listMemberEmails } = {},
): Promise<ResolvedPeople> {
  const withEmails = asked.some((a) => a.includes('@'))
  const first = resolvePeople(asked, await readWorkspacePeople(supabase, workspaceId, { emails: withEmails, listEmails: deps.listEmails }), requesterUserId)
  if (first.ok || !first.ambiguous || withEmails) return first
  return resolvePeople(asked, await readWorkspacePeople(supabase, workspaceId, { emails: true, listEmails: deps.listEmails }), requesterUserId)
}
