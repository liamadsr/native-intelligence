/**
 * The account API of booking links (availability phase 4a): what Settings
 * reads and writes, signed in, for the caller's current workspace. Each
 * route under /api/account/booking-links and /api/account/booking-profile is
 * a thin call into a handler here, pure over {@link AccountDeps}.
 *
 *   GET    /api/account/booking-links            → { links, handles, can_manage, user_id }
 *   POST   /api/account/booking-links            { title, …fields, team? } → 201 { link }
 *   GET    /api/account/booking-links/<id>       → { link }
 *   PATCH  /api/account/booking-links/<id>       { …fields } → { link }
 *   DELETE /api/account/booking-links/<id>       → { link, deleted: true } (gone for good; PATCH active false turns one off)
 *   PUT    /api/account/booking-links/<id>/hosts { hosts, host_mode? } → { link }
 *   GET    /api/account/booking-profile          → { handles }
 *   PUT    /api/account/booking-profile          { handle, scope? } → { handles }
 *
 * The fields are ./input.ts's (snake_case); the rules (who may edit, who may
 * host) are ./links.ts's. Errors use the shared shape of @/lib/api-errors.
 *
 * Server only.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { apiError, badRequest, forbidden, notFound, serverError } from '@/lib/api-errors'
import { createLinkInput, handleInput, linkFieldsInput } from './input'
import { changeLink, createLink, deleteLink, linkView, mayEdit, setHandle, type Editor, type LinkFailure } from './links'
import { getLink, getProfile, listLinks } from './store'
import type { BookingLink } from './types'

export interface AccountDeps {
  supabase: SupabaseClient
  origin: string
}

const PRIVATE = { 'Cache-Control': 'private, no-store' }

function failure(result: LinkFailure): Response {
  switch (result.code) {
    case 'BAD_INPUT':
      return badRequest(result.message)
    case 'NOT_FOUND':
      return notFound(result.message)
    case 'NOT_ALLOWED':
      return forbidden(result.message)
    case 'SLUG_TAKEN':
    case 'HANDLE_TAKEN':
    case 'LIMIT':
      return apiError(result.message, { status: 409, code: result.code })
    default:
      return serverError(result.message)
  }
}

async function readBody(request: Request): Promise<Record<string, unknown> | Response> {
  const body = (await request.json().catch(() => null)) as unknown
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : badRequest('Body must be a JSON object')
}

const firstIssue = (issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>) => {
  const issue = issues[0]
  return issue ? `${issue.path.length ? `${issue.path.map(String).join('.')}: ` : ''}${issue.message}` : 'Invalid input'
}

async function roleOf(deps: AccountDeps, editor: Editor): Promise<string | null> {
  const { data, error } = await deps.supabase.from('member').select('role').eq('workspace_id', editor.workspaceId).eq('user_id', editor.userId).maybeSingle<{ role: string | null }>()
  if (error) throw new Error(`member read failed: ${error.message}`)
  return data ? (data.role ?? 'member') : null
}

function view(deps: AccountDeps, link: BookingLink, editor: Editor, role: string | null) {
  return { ...linkView(link, deps.origin), can_edit: mayEdit(link, editor, role) }
}

async function handles(deps: AccountDeps, editor: Editor) {
  const [mine, workspace] = await Promise.all([getProfile(deps.supabase, { workspaceId: editor.workspaceId, userId: editor.userId }), getProfile(deps.supabase, { workspaceId: editor.workspaceId, userId: null })])
  return { me: mine?.handle ?? null, workspace: workspace?.handle ?? null }
}

/** GET /api/account/booking-links: the workspace's links (each with whether the caller may edit it), the handles, whether the caller manages the workspace, and who the caller is (a new link's host). */
export async function handleListLinks(editor: Editor, deps: AccountDeps): Promise<Response> {
  try {
    const [links, role, h] = await Promise.all([listLinks(deps.supabase, { workspaceId: editor.workspaceId }), roleOf(deps, editor), handles(deps, editor)])
    return Response.json({ links: links.map((l) => view(deps, l, editor, role)), handles: h, can_manage: role === 'owner' || role === 'admin', user_id: editor.userId }, { headers: PRIVATE })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Could not read the booking links')
  }
}

/** POST /api/account/booking-links. */
export async function handleCreateLink(request: Request, editor: Editor, deps: AccountDeps): Promise<Response> {
  const body = await readBody(request)
  if (body instanceof Response) return body
  const parsed = createLinkInput.safeParse(body)
  if (!parsed.success) return badRequest(firstIssue(parsed.error.issues))
  const result = await createLink(deps.supabase, editor, parsed.data)
  if (!result.ok) return failure(result)
  return Response.json({ link: view(deps, result.link, editor, 'owner') }, { status: 201, headers: PRIVATE })
}

/** GET /api/account/booking-links/<id>. */
export async function handleGetLink(linkId: string, editor: Editor, deps: AccountDeps): Promise<Response> {
  try {
    const [link, role] = await Promise.all([getLink(deps.supabase, linkId, editor.workspaceId), roleOf(deps, editor)])
    if (!link) return notFound('No booking link with that id in this workspace.')
    return Response.json({ link: view(deps, link, editor, role) }, { headers: PRIVATE })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Could not read the booking link')
  }
}

async function answerChange(result: Awaited<ReturnType<typeof changeLink>>, editor: Editor, deps: AccountDeps): Promise<Response> {
  if (!result.ok) return failure(result)
  const role = await roleOf(deps, editor).catch(() => null)
  return Response.json({ link: view(deps, result.link, editor, role) }, { headers: PRIVATE })
}

/** PATCH /api/account/booking-links/<id>. */
export async function handlePatchLink(request: Request, linkId: string, editor: Editor, deps: AccountDeps): Promise<Response> {
  const body = await readBody(request)
  if (body instanceof Response) return body
  const parsed = linkFieldsInput.safeParse(body)
  if (!parsed.success) return badRequest(firstIssue(parsed.error.issues))
  return answerChange(await changeLink(deps.supabase, editor, linkId, parsed.data), editor, deps)
}

/** DELETE /api/account/booking-links/<id>: deleted for good (its bookings stay). */
export async function handleDeleteLink(linkId: string, editor: Editor, deps: AccountDeps): Promise<Response> {
  const result = await deleteLink(deps.supabase, editor, linkId)
  if (!result.ok) return failure(result)
  return Response.json({ link: linkView(result.link, deps.origin), deleted: true }, { headers: PRIVATE })
}

/** PUT /api/account/booking-links/<id>/hosts. */
export async function handleSetHosts(request: Request, linkId: string, editor: Editor, deps: AccountDeps): Promise<Response> {
  const body = await readBody(request)
  if (body instanceof Response) return body
  const parsed = linkFieldsInput.pick({ hosts: true, host_mode: true }).required({ hosts: true }).safeParse(body)
  if (!parsed.success) return badRequest(firstIssue(parsed.error.issues))
  return answerChange(await changeLink(deps.supabase, editor, linkId, parsed.data), editor, deps)
}

/** GET /api/account/booking-profile. */
export async function handleGetHandles(editor: Editor, deps: AccountDeps): Promise<Response> {
  try {
    return Response.json({ handles: await handles(deps, editor) }, { headers: PRIVATE })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Could not read the booking handles')
  }
}

/** PUT /api/account/booking-profile. */
export async function handlePutHandle(request: Request, editor: Editor, deps: AccountDeps): Promise<Response> {
  const body = await readBody(request)
  if (body instanceof Response) return body
  const parsed = handleInput.safeParse(body)
  if (!parsed.success) return badRequest(firstIssue(parsed.error.issues))
  const result = await setHandle(deps.supabase, editor, parsed.data)
  if (!result.ok) return failure(result)
  try {
    return Response.json({ handles: await handles(deps, editor) }, { headers: PRIVATE })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Could not read the booking handles')
  }
}
