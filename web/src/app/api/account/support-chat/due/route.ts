/**
 * /api/account/support-chat/due (migrations 715, 719)
 *   POST → { started } the person's support conversation, started now if
 *          it is due and they have none: an account made since support chat
 *          began, or any account while the owner's "existing accounts" switch
 *          is on (Admin › Support Chat); never our staff, never someone who
 *          deleted theirs (support_chat_start_if_due decides). The dashboard
 *          asks once per browser session, in the background
 *          (src/lib/support-chat/use-support-chat-due.ts), so accounts from
 *          before get theirs one by one as people come back. Its welcome
 *          notifies nobody but them.
 */
import { NextResponse } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { getServiceClient } from '@/lib/admin'
import { isSupportStaffUser } from '@/lib/support-chat/staff'
import { startSupportChatIfDue } from '@/lib/support-chat/store'

export async function POST() {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  // Staff never get one (the database refuses too): no call for them.
  if (isSupportStaffUser(auth.user)) return NextResponse.json({ started: false })
  return NextResponse.json({ started: await startSupportChatIfDue(getServiceClient(), auth.user.id) })
}
