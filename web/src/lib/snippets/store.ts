import type { SupabaseClient } from '@supabase/supabase-js'
import { checkSnippetInput, type CheckedSnippet, type Snippet, type SnippetInput, type SnippetVisibility } from './types'

/**
 * Snippets' storage (migration 699, docs/plans/snippets.md §3). The routes, the
 * settings page and the agent's tools all go through here.
 *
 * Every read fences on the workspace AND on "shared, or the caller's own"; every
 * write on "the caller may change it" (its maker; a shared one also an owner or
 * admin). So a service-role client (the agent's tool route) answers as RLS
 * answers the person's own session, and a write the policy would refuse is
 * refused here first, with words.
 */

export interface SnippetCaller {
  workspaceId: string
  /** The person's auth user id. */
  userId: string
}

interface SnippetRow {
  id: string
  workspace_id: string
  created_by: string | null
  name: string
  shortcut: string
  body: string
  visibility: SnippetVisibility
  updated_at: string
}

const COLUMNS = 'id, workspace_id, created_by, name, shortcut, body, visibility, updated_at'

export type SnippetResult<T> = { ok: true; value: T } | { ok: false; status: 400 | 403 | 404 | 409 | 500; error: string }

/** The caller's member row in the workspace: their id and role, or null when they aren't one. */
export async function snippetMember(supabase: SupabaseClient, caller: SnippetCaller): Promise<{ id: string; role: string } | null> {
  const { data } = await supabase.from('member').select('id, role').eq('workspace_id', caller.workspaceId).eq('user_id', caller.userId).maybeSingle()
  return data ? { id: String(data.id), role: String(data.role ?? '') } : null
}

const isAdmin = (role: string) => role === 'owner' || role === 'admin'

function view(row: SnippetRow, member: { id: string; role: string }): Snippet {
  const mine = row.created_by === member.id
  return {
    id: row.id,
    name: row.name,
    shortcut: row.shortcut,
    body: row.body,
    visibility: row.visibility,
    mine,
    canEdit: mine || (row.visibility === 'workspace' && isAdmin(member.role)),
    updatedAt: row.updated_at,
  }
}

function readable(row: SnippetRow, member: { id: string }): boolean {
  return row.visibility === 'workspace' || row.created_by === member.id
}

/** The caller's own and the workspace's shared snippets (`sharedOnly`: the shared ones alone). */
export async function listSnippets(
  supabase: SupabaseClient,
  caller: SnippetCaller,
  opts: { sharedOnly?: boolean } = {},
): Promise<SnippetResult<Snippet[]>> {
  const member = await snippetMember(supabase, caller)
  if (!member) return { ok: false, status: 403, error: 'Not a member of this workspace.' }
  let query = supabase.from('snippet').select(COLUMNS).eq('workspace_id', caller.workspaceId)
  query = opts.sharedOnly ? query.eq('visibility', 'workspace') : query.or(`visibility.eq.workspace,created_by.eq.${member.id}`)
  const { data, error } = await query.order('shortcut', { ascending: true }).limit(1000)
  if (error) return { ok: false, status: 500, error: error.message }
  const rows = ((data ?? []) as SnippetRow[]).filter((r) => readable(r, member))
  return { ok: true, value: rows.map((r) => view(r, member)) }
}

async function readOne(supabase: SupabaseClient, caller: SnippetCaller, id: string) {
  const member = await snippetMember(supabase, caller)
  if (!member) return { member: null, row: null }
  const { data } = await supabase.from('snippet').select(COLUMNS).eq('workspace_id', caller.workspaceId).eq('id', id).maybeSingle()
  const row = data as SnippetRow | null
  return { member, row: row && readable(row, member) ? row : null }
}

/** One snippet the caller may read, by id or by shortcut (their own first). */
export async function getSnippet(
  supabase: SupabaseClient,
  caller: SnippetCaller,
  ref: { id?: string; shortcut?: string },
  opts: { sharedOnly?: boolean } = {},
): Promise<SnippetResult<Snippet>> {
  if (ref.id) {
    const { member, row } = await readOne(supabase, caller, ref.id)
    if (!member) return { ok: false, status: 403, error: 'Not a member of this workspace.' }
    if (!row || (opts.sharedOnly && row.visibility !== 'workspace')) return { ok: false, status: 404, error: 'No snippet with that id.' }
    return { ok: true, value: view(row, member) }
  }
  const shortcut = ref.shortcut?.trim().toLowerCase().replace(/^;+/, '')
  if (!shortcut) return { ok: false, status: 400, error: 'Give a snippet id or shortcut.' }
  const list = await listSnippets(supabase, caller, opts)
  if (!list.ok) return list
  const found = list.value.filter((s) => s.shortcut === shortcut).sort((a, b) => Number(b.mine && b.visibility === 'personal') - Number(a.mine && a.visibility === 'personal'))[0]
  return found ? { ok: true, value: found } : { ok: false, status: 404, error: `No snippet with the shortcut ;${shortcut}.` }
}

function duplicate(error: { code?: string } | null): boolean {
  return error?.code === '23505'
}

const TAKEN = (s: string, v: SnippetVisibility) =>
  v === 'workspace' ? `The workspace already has a shared snippet ;${s}.` : `You already have a snippet ;${s}.`

export async function createSnippet(supabase: SupabaseClient, caller: SnippetCaller, input: SnippetInput): Promise<SnippetResult<Snippet>> {
  const checked = checkSnippetInput(input, false)
  if (!checked.ok) return { ok: false, status: 400, error: checked.error }
  const member = await snippetMember(supabase, caller)
  if (!member) return { ok: false, status: 403, error: 'Not a member of this workspace.' }
  const value = checked.value as CheckedSnippet
  const { data, error } = await supabase
    .from('snippet')
    .insert({ workspace_id: caller.workspaceId, created_by: member.id, ...value })
    .select(COLUMNS)
    .single()
  if (duplicate(error)) return { ok: false, status: 409, error: TAKEN(value.shortcut, value.visibility) }
  if (error || !data) return { ok: false, status: 500, error: error?.message ?? 'Could not save the snippet.' }
  return { ok: true, value: view(data as SnippetRow, member) }
}

export async function updateSnippet(
  supabase: SupabaseClient,
  caller: SnippetCaller,
  id: string,
  input: SnippetInput,
): Promise<SnippetResult<Snippet>> {
  const checked = checkSnippetInput(input, true)
  if (!checked.ok) return { ok: false, status: 400, error: checked.error }
  const { member, row } = await readOne(supabase, caller, id)
  if (!member) return { ok: false, status: 403, error: 'Not a member of this workspace.' }
  if (!row) return { ok: false, status: 404, error: 'No snippet with that id.' }
  const current = view(row, member)
  if (!current.canEdit) return { ok: false, status: 403, error: 'Only the person who made this shared snippet, or a workspace admin, can change it.' }
  if (checked.value.visibility && checked.value.visibility !== row.visibility && !current.mine) {
    return { ok: false, status: 403, error: 'Only the person who made a snippet changes who sees it.' }
  }
  const patch = checked.value
  if (!Object.keys(patch).length) return { ok: true, value: current }
  const { data, error } = await supabase.from('snippet').update(patch).eq('workspace_id', caller.workspaceId).eq('id', id).select(COLUMNS).maybeSingle()
  if (duplicate(error)) return { ok: false, status: 409, error: TAKEN(patch.shortcut ?? row.shortcut, patch.visibility ?? row.visibility) }
  if (error) return { ok: false, status: 500, error: error.message }
  if (!data) return { ok: false, status: 404, error: 'No snippet with that id.' }
  return { ok: true, value: view(data as SnippetRow, member) }
}

export async function deleteSnippet(supabase: SupabaseClient, caller: SnippetCaller, id: string): Promise<SnippetResult<{ deleted: true }>> {
  const { member, row } = await readOne(supabase, caller, id)
  if (!member) return { ok: false, status: 403, error: 'Not a member of this workspace.' }
  if (!row) return { ok: false, status: 404, error: 'No snippet with that id.' }
  if (!view(row, member).canEdit) return { ok: false, status: 403, error: 'Only the person who made this shared snippet, or a workspace admin, can delete it.' }
  const { data, error } = await supabase.from('snippet').delete().eq('workspace_id', caller.workspaceId).eq('id', id).select('id')
  if (error) return { ok: false, status: 500, error: error.message }
  if (!data?.length) return { ok: false, status: 404, error: 'No snippet with that id.' }
  return { ok: true, value: { deleted: true } }
}
