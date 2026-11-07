import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest } from '@/lib/api-errors'
import { listWorkspaceTags } from '@/lib/tasks/asana-lens'
import { asanaErrorResponse, requireAsanaToken } from '@/lib/tasks/asana-picker'
import { NextResponse } from 'next/server'

/**
 * GET /api/account/asana/tags?workspace=<gid>
 *
 * The property lens's tag picker: every tag in the Asana workspace, since an Asana
 * tag belongs to a WORKSPACE and is applicable to any task in it. That is the one
 * way this route differs from the sections picker next door, which is project-
 * scoped because a section belongs to exactly one project.
 *
 * Tags are Asana's answer to Jira's labels and Linear's labels, and they are the
 * reason this route had to exist: the lens needs a source of applicable tag gids,
 * and nothing in the codebase enumerated them (the compose panel never offered
 * tags, because `POST /tasks` cannot set them — only the dedicated
 * addTag/removeTag endpoints can, which is a write-to-an-existing-task shape and
 * therefore a lens concern rather than a create one).
 *
 * A 401 from Asana surfaces as 400 `reconnect_required`, matching every other
 * option route — never a bare 401, which would read as the caller's own session
 * expiring.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { workspaceId } = auth

  const asanaWorkspaceGid = new URL(request.url).searchParams.get('workspace')?.trim()
  if (!asanaWorkspaceGid) {
    return badRequest('`workspace` query param required (an Asana workspace gid)')
  }

  const resolved = await requireAsanaToken(workspaceId)
  if (resolved instanceof Response) return resolved

  try {
    const tags = await listWorkspaceTags(resolved.token, asanaWorkspaceGid)
    return NextResponse.json({
      tags: tags
        // A tag with no gid cannot be attached to anything, so it is dropped
        // rather than rendered as an unselectable row — the same rule the users
        // picker applies to a user with no gid.
        .filter((tag) => typeof tag.gid === 'string' && tag.gid.length > 0)
        .map((tag) => ({ gid: tag.gid, name: tag.name ?? tag.gid })),
    })
  } catch (err) {
    return asanaErrorResponse(err, 'list Asana tags')
  }
}
