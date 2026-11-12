/**
 * /api/account/seo/ai-visibility/[id]/prompts: the questions a tracker asks.
 *
 *   GET     the prompts, oldest first.
 *   POST    { prompts: [string | { text, source? }], confirmed? }: add them
 *           (new ones only, up to the per-tracker cap). On a scheduled
 *           tracker, adding prompts that raise the monthly cost by more than
 *           CONFIRM_ABOVE_USD answers 409 CONFIRMATION_REQUIRED until
 *           `confirmed: true`.
 *   PATCH   { prompt_ids, active, confirmed? }: turn prompts on or off
 *           (turning them on asks like adding).
 *   DELETE  { prompt_ids }: remove them. Their past answers stay.
 *
 * Any member may read and change. Free.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { aiFailureResponse, jsonBody, UUID } from '@/lib/seo/ai-visibility/http'
import {
  addPromptsRequestSchema,
  removePromptsRequestSchema,
  togglePromptsRequestSchema,
} from '@/lib/seo/ai-visibility/input'
import { getTracker, listPrompts } from '@/lib/seo/ai-visibility/queries'
import {
  addPrompts,
  removePrompts,
  setPromptsActive,
} from '@/lib/seo/ai-visibility/trackers'
import { NextResponse, type NextRequest } from 'next/server'

type Params = { params: Promise<{ id: string }> }

export async function GET(_request: Request, { params }: Params) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!UUID.test(id)) return notFound('Tracker not found')
  try {
    const svc = getServiceClient()
    if (!(await getTracker(svc, auth.workspaceId, id)))
      return notFound('Tracker not found')
    return NextResponse.json({
      prompts: await listPrompts(svc, auth.workspaceId, id),
    })
  } catch (err) {
    console.error('[seo-ai] prompts read failed', err)
    return serverError('Could not load the prompts just now.')
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!UUID.test(id)) return notFound('Tracker not found')
  const parsed = addPromptsRequestSchema.safeParse(await jsonBody(request))
  if (!parsed.success) return badRequest('Those prompts aren’t valid.')
  try {
    const out = await addPrompts(
      getServiceClient(),
      { workspaceId: auth.workspaceId, userId: auth.user.id },
      id,
      parsed.data.prompts,
      { confirmed: parsed.data.confirmed },
    )
    if (!out.ok) return aiFailureResponse(out)
    return NextResponse.json(out, { status: 201 })
  } catch (err) {
    console.error('[seo-ai] add prompts failed', err)
    return serverError('Could not add the prompts just now.')
  }
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!UUID.test(id)) return notFound('Tracker not found')
  const parsed = togglePromptsRequestSchema.safeParse(await jsonBody(request))
  if (!parsed.success) return badRequest('That change isn’t valid.')
  try {
    const out = await setPromptsActive(
      getServiceClient(),
      { workspaceId: auth.workspaceId, userId: auth.user.id },
      id,
      parsed.data.prompt_ids,
      parsed.data.active,
      {
        confirmed: parsed.data.confirmed,
      },
    )
    if (!out.ok) return aiFailureResponse(out)
    return NextResponse.json(out)
  } catch (err) {
    console.error('[seo-ai] toggle prompts failed', err)
    return serverError('Could not change the prompts just now.')
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!UUID.test(id)) return notFound('Tracker not found')
  const parsed = removePromptsRequestSchema.safeParse(await jsonBody(request))
  if (!parsed.success) return badRequest('Name the prompts to remove.')
  try {
    const out = await removePrompts(
      getServiceClient(),
      { workspaceId: auth.workspaceId },
      id,
      parsed.data.prompt_ids,
    )
    if (!out.ok) return aiFailureResponse(out)
    return NextResponse.json(out)
  } catch (err) {
    console.error('[seo-ai] remove prompts failed', err)
    return serverError('Could not remove the prompts just now.')
  }
}
