import { getServiceClient } from '@/lib/admin'
import { AdminPageHeader } from '@/components/admin/shared'
import { readSupportSettings } from '@/lib/support-chat/store'
import { SupportChatSettingsForm } from './settings-form'

export const dynamic = 'force-dynamic'

/**
 * Support chat (migration 715): the welcome every new account gets in its own
 * support conversation, who sends it, and starting one for an account that
 * signed up before. Always this deployment's own database (never the admin
 * panel's environment switch). The conversations themselves are answered in
 * team chat, under Support.
 */
export default async function SupportChatAdminPage() {
  let data: Awaited<ReturnType<typeof readSupportSettings>> | null = null
  let failed = false
  try {
    data = await readSupportSettings(getServiceClient())
  } catch {
    failed = true
  }
  return (
    <div className="max-w-3xl">
      <AdminPageHeader
        title="Support chat"
        description="Every new account gets its own conversation with the support team, opened with this welcome. Answer them in team chat, under Support."
      />
      {failed || !data?.settings ? (
        <p className="mt-6 text-sm text-destructive">Support chat isn’t set up on this database yet (migration 715).</p>
      ) : (
        <SupportChatSettingsForm settings={data.settings} staff={data.staff} />
      )}
    </div>
  )
}
