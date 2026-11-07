import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/admin'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { syncEmailThreads, linkThreadsToContacts } from '@/lib/crm/email-sync'
import { inngest } from '@/lib/inngest/client'
import { NextResponse, type NextRequest } from 'next/server'

export const maxDuration = 60

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const body = await request.json().catch(() => ({}))
  const fullSync = body.full_sync === true

  // Fast path: refresh the thread metadata index so the list updates right away.
  const result = await syncEmailThreads(user.id, workspaceId, fullSync)

  // Auto-link threads to contacts (non-blocking)
  linkThreadsToContacts(user.id, workspaceId).catch(() => {})

  // Also kick the full-body sync via the same Inngest path webhooks use, so a
  // manual sync pulls message bodies/attachments and self-heals a stalled
  // initial import. Best-effort; the metadata result above is what the UI shows.
  try {
    const admin = getServiceClient()
    const { data: accounts } = await admin
      .from('connected_account')
      .select('id, provider')
      .eq('user_id', user.id)
      .eq('capability', 'email')
      .eq('is_enabled', true)

    await Promise.all(
      (accounts || []).map(async (account) => {
        const { data: state } = await admin
          .from('email_sync_state')
          .select('initial_import_status, gmail_history_id, ms_delta_link')
          .eq('account_id', account.id)
          .maybeSingle()

        const provider = account.provider as 'google' | 'microsoft'
        const hasCheckpoint =
          provider === 'google' ? !!state?.gmail_history_id : !!state?.ms_delta_link

        await inngest.send({
          name:
            state?.initial_import_status === 'complete' && hasCheckpoint
              ? 'email/incremental-sync'
              : 'email/initial-import',
          data: {
            accountId: account.id,
            userId: user.id,
            workspaceId,
            provider,
          },
        })
      }),
    )
  } catch (err) {
    console.error('[email sync] inngest trigger failed:', err)
  }

  return NextResponse.json(result)
}
