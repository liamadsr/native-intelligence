import { NextResponse } from 'next/server'
import { createStatelessClient } from '@/lib/supabase/stateless'
import { authenticateUser } from '@/lib/ai/auth'
import { isValidProvider, isValidCapability } from '@/lib/oauth/config'
import { disconnectOAuthAccount } from '@/lib/connections/disconnect'

export async function POST(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  try {
    const [{ user }, { provider }] = await Promise.all([
      authenticateUser(req),
      params,
    ])

    if (!isValidProvider(provider)) {
      return NextResponse.json(
        { error: `Invalid provider: ${provider}` },
        { status: 400 },
      )
    }

    const supabase = createStatelessClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )

    const url = new URL(req.url)
    let accountId = url.searchParams.get('account_id')
    let capability = url.searchParams.get('capability')

    if (!accountId || !capability) {
      try {
        const body = await req.json()
        accountId = accountId || body.account_id
        capability = capability || body.capability
      } catch {
        // No body
      }
    }

    if (accountId) {
      // The one disconnect path (src/lib/connections/disconnect.ts), shared
      // with the chat's disconnect card. An account already gone is a success
      // so the UI can move on. What it does, and why:
      //
      // Both task providers register webhooks on THEIR side that outlive us.
      // Deleting the account cascades task_sync_state — and with it the stored
      // registration — away, leaving the provider POSTing to a receiver that can
      // no longer resolve the delivery. So tear them down while the rows still
      // exist, using the token before it's revoked. Strictly best-effort: both
      // helpers swallow everything, and an abandoned registration expires on its
      // own (Asana after 24h of 401s, Jira within 30 days), so a disconnect must
      // never be blocked or failed by this.
      //
      // These are separate branches rather than one loop because the teardown
      // call is genuinely different: Asana deletes by gid alone, every Jira
      // delete has to be addressed to the site the webhook lives on, and Linear
      // revokes a token.
      //
      // DISPATCHED ON THE STORED ROW, NEVER ON THE URL. `account_id` is
      // user-supplied and only correlated with the path's provider by the
      // caller's good behaviour, so /api/oauth/linear/disconnect naming a Google
      // account would otherwise resolve — and actively refresh — that account's
      // live token and hand it to Linear's revoke endpoint: a third-party
      // credential disclosed to a service with no business seeing it, and never
      // revoked at its own provider. The asana/jira teardowns happen to be
      // immune (they load provider-scoped webhook rows and return early when
      // there are none); the gate belongs here so none of them has to be.
      //
      // (The legacy provider-wide branch below has no account id to work from
      // and relies on registration expiry instead.)
      // It also switches off the person's loops that needed the account (the
      // chat's disconnect card does the same), and says which.
      const { loopsSwitchedOff } = await disconnectOAuthAccount(supabase, user.id, accountId)
      return NextResponse.json({ success: true, loops_switched_off: loopsSwitchedOff })
    } else {
      // Legacy disconnect: by provider + optional capability
      let deleteAccountQuery = supabase
        .from('connected_account')
        .delete()
        .eq('user_id', user.id)
        .eq('provider', provider)

      if (capability && isValidCapability(capability)) {
        deleteAccountQuery = deleteAccountQuery.eq('capability', capability)
      }

      await deleteAccountQuery

      return NextResponse.json({ success: true })
    }
  } catch (error) {
    if (error instanceof Response) return error
    console.error('[OAuth Disconnect] Unexpected error:', error)
    return NextResponse.json(
      { error: 'Failed to disconnect' },
      { status: 500 },
    )
  }
}
