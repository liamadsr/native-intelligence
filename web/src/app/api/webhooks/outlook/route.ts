import { inngest } from '@/lib/inngest/client'
import { getServiceClient } from '@/lib/admin'
import { timingSafeEqual } from 'crypto'

/**
 * The id a notification's clientState carries, or null when it isn't ours.
 * setupOutlookSubscription signs every subscription's clientState as
 * "<OUTLOOK_WEBHOOK_SECRET>:<id>" (the connected account's id, or a legacy
 * user's), so anything else is refused: a bare id (the old secret-less form;
 * security review 2026-10-31: PROD held no Outlook mail subscription on 10-31,
 * so none was cut off), a wrong secret, or no secret configured at all.
 */
function verifyAndExtractId(clientState: string): string | null {
  const secret = process.env.OUTLOOK_WEBHOOK_SECRET
  if (!secret) return null

  const prefix = `${secret}:`
  if (clientState.length <= prefix.length) return null
  const providedPrefix = clientState.slice(0, prefix.length)
  try {
    const provided = new TextEncoder().encode(providedPrefix)
    const expected = new TextEncoder().encode(prefix)
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null
  } catch {
    return null
  }

  return clientState.slice(prefix.length)
}

export async function POST(request: Request) {
  const url = new URL(request.url)

  // Microsoft sends a validation token on subscription creation — echo it back
  const validationToken = url.searchParams.get('validationToken')
  if (validationToken) {
    return new Response(validationToken, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    })
  }

  try {
    const body = await request.json()

    for (const notification of body.value || []) {
      const rawClientState = notification.clientState
      if (!rawClientState) continue

      // Verify clientState secret and extract actual ID
      const clientState = verifyAndExtractId(rawClientState)
      if (!clientState) {
        console.warn('Outlook webhook: invalid clientState secret')
        continue
      }

      const supabase = getServiceClient()

      // Try to resolve as accountId first (multi-account path)
      const { data: account } = await supabase
        .from('connected_account')
        .select('id, user_id, workspace_id')
        .eq('id', clientState)
        .maybeSingle()

      if (account) {
        // Multi-account path
        await inngest.send({
          name: 'email/webhook-received',
          data: {
            accountId: account.id,
            userId: account.user_id,
            workspaceId: account.workspace_id,
            provider: 'microsoft',
          },
        })
      } else {
        // Legacy fallback: clientState is userId
        const userId = clientState

        const { data: tokenRow } = await supabase
          .from('user_oauth_tokens')
          .select('user_id')
          .eq('user_id', userId)
          .eq('provider', 'microsoft')
          .maybeSingle()

        if (!tokenRow) {
          console.warn('Outlook webhook for unverified clientState:', clientState)
          continue
        }

        const { data: syncState } = await supabase
          .from('email_sync_state')
          .select('workspace_id')
          .eq('user_id', userId)
          .eq('provider', 'microsoft')
          .maybeSingle()

        if (syncState) {
          await inngest.send({
            name: 'email/webhook-received',
            data: {
              userId,
              workspaceId: syncState.workspace_id,
              provider: 'microsoft',
            },
          })
        }
      }
    }

    return new Response('', { status: 202 })
  } catch (err) {
    console.error('Outlook webhook error:', err)
    return new Response('', { status: 202 })
  }
}
