import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { generateDeviceToken } from '@/lib/device-tokens'

/**
 * GET /api/account/device-tokens
 * List the current user's device tokens (no secrets — only metadata).
 *
 * POST /api/account/device-tokens  { name: string }
 * Mint a new device token. The plaintext token is returned EXACTLY ONCE in
 * this response and never again; only its hash is stored.
 */

export async function GET() {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { user } = auth

  const service = getServiceClient()
  const { data, error } = await service
    .from('device_token')
    .select('id, name, token_prefix, created_at, last_used_at, expires_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  if (error) return serverError(error.message)

  const tokens = (data || []).map((t) => ({
    id: t.id,
    name: t.name,
    token_prefix: t.token_prefix,
    created_at: t.created_at,
    last_used_at: t.last_used_at,
    expires_at: t.expires_at,
    is_expired: t.expires_at ? new Date(t.expires_at) < new Date() : false,
  }))

  return Response.json({ tokens })
}

export async function POST(req: Request) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { user, workspaceId } = auth

  let body: { name?: unknown }
  try {
    body = await req.json()
  } catch {
    return badRequest('Invalid JSON body')
  }

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return badRequest('A device name is required')
  if (name.length > 100) return badRequest('Device name must be 100 characters or fewer')

  const { token, hash, displayPrefix } = generateDeviceToken()

  const service = getServiceClient()
  const { data, error } = await service
    .from('device_token')
    .insert({
      user_id: user.id,
      // Initial active workspace = the one the user is in when minting. The
      // device can switch later (POST device-tokens/switch-workspace) to any
      // workspace the user belongs to.
      active_workspace_id: workspaceId,
      name,
      token_hash: hash,
      token_prefix: displayPrefix,
    })
    .select('id, name, token_prefix, created_at')
    .single()

  if (error || !data) return serverError(error?.message || 'Failed to create device token')

  // `token` is returned once here and never persisted in plaintext.
  return Response.json({
    id: data.id,
    name: data.name,
    token_prefix: data.token_prefix,
    created_at: data.created_at,
    token,
  })
}
