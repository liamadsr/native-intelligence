/**
 * What a bot's page says about its teammate beyond the roster entry
 * (docs/plans/bots-v4.md, "A bot's page" → About), and which kind of bot
 * Customize opens the one agent editor on (agent-editor-seam.tsx).
 * Read on the caller's (RLS) client by GET /api/account/agent-work?teammate=,
 * once the teammate itself has been checked (visible, reachable).
 *
 *   skills  the skills it always checks, in order (`ai_team_member_skill`):
 *           its workspace's shared ones and the system ones. A personal skill
 *           is left out, as one the caller can't read is (B1: only shared
 *           skills are pinned, and the prompt skips a personal one).
 *   agent   the custom agent it's built on: its persona, when that's an agent
 *           of its own workspace, shared (workspace or public), and neither a
 *           role persona (slug `role-<role>`, migration 284) nor the work-bot
 *           anchor (migration 302). A system teammate's persona is an anchor
 *           no session reads (migration 283), so it comes back null too.
 *   loops   the loops its bot fronts (`flow.ai_team_member_id`), oldest first.
 *
 * Fail-soft, part by part: a failed read is logged and leaves its part empty.
 * It never fails the page.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { WORK_BOT_ANCHOR_SLUG } from '@/lib/flows/flow-bot'

export interface TeammateAbout {
  skills: Array<{ id: string; name: string }>
  agent: { id: string; name: string } | null
  loops: Array<{ id: string; name: string }>
}

/** The persona slug every role teammate's agent carries (migration 284). */
const ROLE_PERSONA_SLUG = /^role-/

interface RecipeRef {
  id: string
  name: string | null
  slug?: string | null
  workspace_id: string | null
  category?: string | null
  visibility?: string | null
  is_system?: boolean | null
}

/** An embed PostgREST may hand back as the row or as a one-row list. */
function one<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

async function readSkills(supabase: SupabaseClient, teammateId: string, workspaceId: string): Promise<TeammateAbout['skills']> {
  const { data, error } = await supabase
    .from('ai_team_member_skill')
    .select('sort_order, skill:skill_recipe_id(id, name, workspace_id, visibility, is_system)')
    .eq('ai_team_member_id', teammateId)
    .order('sort_order', { ascending: true })
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as Array<{ sort_order: number | null; skill: RecipeRef | RecipeRef[] | null }>
  return rows
    .slice()
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((r) => one(r.skill))
    .filter((s): s is RecipeRef => !!s)
    .filter((s) => s.is_system === true || (s.workspace_id === workspaceId && s.visibility !== 'personal'))
    .map((s) => ({ id: s.id, name: s.name?.trim() || 'Untitled skill' }))
}

async function readAgent(supabase: SupabaseClient, teammateId: string, workspaceId: string): Promise<TeammateAbout['agent']> {
  const { data, error } = await supabase
    .from('ai_team_member')
    .select('agent:agent_recipe_id(id, name, slug, workspace_id, category, visibility)')
    .eq('id', teammateId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  const agent = one((data as { agent?: RecipeRef | RecipeRef[] | null } | null)?.agent)
  if (!agent || agent.category !== 'agent' || agent.workspace_id !== workspaceId) return null
  if (agent.visibility !== 'workspace' && agent.visibility !== 'public') return null
  const slug = agent.slug ?? ''
  if (ROLE_PERSONA_SLUG.test(slug) || slug === WORK_BOT_ANCHOR_SLUG) return null
  const name = agent.name?.trim()
  return name ? { id: agent.id, name } : null
}

async function readLoops(supabase: SupabaseClient, teammateId: string, workspaceId: string): Promise<TeammateAbout['loops']> {
  const { data, error } = await supabase
    .from('flow')
    .select('id, name, created_at')
    .eq('workspace_id', workspaceId)
    .eq('ai_team_member_id', teammateId)
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  return ((data ?? []) as Array<{ id: string; name: string | null }>).map((f) => ({ id: f.id, name: f.name?.trim() || 'Untitled loop' }))
}

/** A part's read, logged and left empty when it fails. */
async function soft<T>(what: string, read: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await read()
  } catch (err) {
    console.error(`[teammate-about] ${what} read failed:`, err instanceof Error ? err.message : err)
    return empty
  }
}

export async function loadTeammateAbout(
  supabase: SupabaseClient,
  scope: { teammateId: string; workspaceId: string },
): Promise<TeammateAbout> {
  const { teammateId, workspaceId } = scope
  const [skills, agent, loops] = await Promise.all([
    soft('skills', () => readSkills(supabase, teammateId, workspaceId), [] as TeammateAbout['skills']),
    soft('agent', () => readAgent(supabase, teammateId, workspaceId), null as TeammateAbout['agent']),
    soft('loops', () => readLoops(supabase, teammateId, workspaceId), [] as TeammateAbout['loops']),
  ])
  return { skills, agent, loops }
}
