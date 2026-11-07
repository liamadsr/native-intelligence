import { inngest } from '@/lib/inngest/client'
import { getServiceClient } from '@/lib/admin'
import { verifyGmailPush } from './push-auth'

export async function POST(request: Request) {
  // Pub/Sub's ID token once GMAIL_PUSH_SERVICE_ACCOUNT is set, else the static ?token= (./push-auth.ts).
  if (!(await verifyGmailPush(request))) {
    return new Response('Unauthorized', { status: 401 })
  }

  try {
    const body = await request.json()

    // Gmail Pub/Sub sends base64-encoded notification data
    const data = JSON.parse(
      Buffer.from(body.message.data, 'base64').toString('utf-8'),
    )

    // data contains: { emailAddress: string, historyId: number }
    const emailAddress = data.emailAddress

    const supabase = getServiceClient()

    // Look up the connected_account by email (preferred) with fallback to legacy tokens
    const { data: account } = await supabase
      .from('connected_account')
      .select('id, user_id, workspace_id')
      .eq('provider', 'google')
      .eq('capability', 'email')
      .eq('account_email', emailAddress)
      .limit(1)
      .maybeSingle()

    if (account) {
      await inngest.send({
        name: 'email/webhook-received',
        data: {
          accountId: account.id,
          userId: account.user_id,
          workspaceId: account.workspace_id,
          provider: 'google',
          historyId: String(data.historyId),
        },
      })
    } else {
      // Legacy fallback: look up by email in user_oauth_tokens
      const { data: tokenRow } = await supabase
        .from('user_oauth_tokens')
        .select('user_id')
        .eq('provider', 'google')
        .eq('email', emailAddress)
        .limit(1)
        .maybeSingle()

      if (!tokenRow) {
        console.warn('Gmail webhook for unknown email:', emailAddress)
        return new Response('OK', { status: 200 })
      }

      const { data: syncState } = await supabase
        .from('email_sync_state')
        .select('workspace_id')
        .eq('user_id', tokenRow.user_id)
        .eq('provider', 'google')
        .maybeSingle()

      if (syncState) {
        await inngest.send({
          name: 'email/webhook-received',
          data: {
            userId: tokenRow.user_id,
            workspaceId: syncState.workspace_id,
            provider: 'google',
            historyId: String(data.historyId),
          },
        })
      }
    }

    // Always return 200 to acknowledge — otherwise Google retries and eventually stops
    return new Response('OK', { status: 200 })
  } catch (err) {
    console.error('Gmail webhook error:', err)
    // Still return 200 to prevent retries
    return new Response('OK', { status: 200 })
  }
}
