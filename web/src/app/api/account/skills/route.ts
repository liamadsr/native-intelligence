import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace, requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, forbidden, serverError } from '@/lib/api-errors'
import { trackServerEvent } from '@/lib/posthog'
import {
  LIBRARY_ITEM_FIELDS,
  PUBLISH_ROLE_ERROR,
  buildInsertRow,
  canPublishPublic,
  generateSlug,
  listLibraryItemsWithLineage,
  validateSlug,
} from '@/lib/library/queries'
import { ensureUniqueSlug, normalizeSlug } from '@/lib/library/slug'
import { parseAgentConfig } from '@/lib/library/agent-config'
import { parseSkillArea } from '@/lib/packs/registry'

/**
 * Skills (chat-invoked AI presets, e.g. "Weekly Planner").
 * Maps to recipe.category = 'skill' (renamed from 'agent').
 */

export async function GET(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth

  const mine = request.nextUrl.searchParams.get('mine') === 'true'
  // The Flows editor's picker includes the lens skills (F3); every other list leaves them out.
  const includeLenses = request.nextUrl.searchParams.get('for') === 'flows'

  const { data, error } = await listLibraryItemsWithLineage(auth, 'skill', { mine, includeLenses })
  if (error) return serverError(error.message)
  return NextResponse.json({ skills: data || [] })
}

export async function POST(request: NextRequest) {
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth

  const body = await request.json()
  const name = (body.name || '').trim()
  if (!name) return badRequest('Name is required')

  // Publishing to Discover is platform-wide — gate CREATE-as-public on owner/admin
  // (RLS opened member authoring but can't tell publish from an ordinary write).
  if (body.visibility === 'public' && !canPublishPublic(auth.member.role)) {
    return forbidden(PUBLISH_ROLE_ERROR)
  }

  // Slug: explicit (normalized) > derived from name. `validateSlug` still guards
  // reserved names / empties; collisions self-heal via suffixing (the /command
  // namespace tolerates `foo-2`), so a taken user slug never 409s here.
  const requested = body.slug ? normalizeSlug(String(body.slug)) : generateSlug(name)
  const slugError = validateSlug(requested)
  if (slugError) return badRequest(slugError)

  // The area its pack loads it in ("Use it whenever I work on …"), optional.
  const area = parseSkillArea(body.area)
  if (!area.ok) return badRequest(area.error)

  const slug = await ensureUniqueSlug(auth.supabase, auth.workspaceId, requested)

  // agent_config is validated against the one canonical schema, never stored raw
  // (Sequence step 1: this route and PATCH are the only writers left).
  let agentConfig: Record<string, unknown> | null | undefined = undefined
  if (body.agent_config !== undefined) {
    const parsed = parseAgentConfig(body.agent_config)
    if (!parsed.ok) return badRequest(parsed.error)
    agentConfig = parsed.config
  }

  const row = buildInsertRow(auth, {
    name,
    category: 'skill',
    visibility: body.visibility,
    system_prompt: body.system_prompt,
    icon: body.icon,
    color: body.color,
    description: body.description,
    sort_order: body.sort_order,
    model: body.model,
    slug,
    agent_config: agentConfig,
    area: area.area,
  })

  const { data, error } = await auth.supabase
    .from('recipe')
    .insert(row)
    .select(LIBRARY_ITEM_FIELDS)
    .single()

  if (error) return serverError(error.message)

  // Fire-and-forget analytics (never blocks/fails the write). `recipe_published`
  // rides alongside on a public create — the "publishes to every Dial8 user"
  // step is a countable event on both create and the edit that flips it.
  const { user, workspaceId } = auth
  trackServerEvent('recipe_created', { userId: user.id, workspaceId, email: user.email }, {
    category: 'skill',
    visibility: data.visibility,
    recipe_id: data.id,
    workspace_id: workspaceId,
  })
  if (data.visibility === 'public') {
    trackServerEvent('recipe_published', { userId: user.id, workspaceId, email: user.email }, {
      category: 'skill',
      recipe_id: data.id,
      workspace_id: workspaceId,
    })
  }

  return NextResponse.json({ skill: data })
}
