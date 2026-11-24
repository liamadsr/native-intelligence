/**
 * /api/admin/support-chat (migration 715): the support conversation every new
 * account gets, for the deployment's admins.
 *   GET   → { settings, staff } the welcome's words and its sender, and who
 *           is on the support team (the admins who have opened team chat).
 *   PATCH { welcomeTemplate, senderUserId, existingAccounts?,
 *           welcomeExistingTemplate? } → { ok } the welcome every new account
 *           gets ({name} is "@<their name>", {first_name} their first name),
 *           which of the team sends it (null: the longest-standing), and
 *           (migration 719) whether accounts from before support chat get one
 *           too, the next time they use the app, and their own welcome (empty:
 *           the new-account one). Sent ones stay as they were.
 *   POST  { email } | { userId } → { started, channelId, reason } start the
 *           support conversation of an EXISTING account (one that signed up
 *           before this, or before any admin was on the team). Once per
 *           account: a second start changes nothing (reason 'exists'). An
 *           account that deleted theirs gets a fresh one.
 *
 * Always this deployment's own database (getServiceClient), never the admin
 * panel's environment switch: a support conversation is this deployment's.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { getServiceClient, listAllAuthUsers, requireAdmin } from '@/lib/admin'
import { badRequest } from '@/lib/api-errors'
import { isUuid } from '@/lib/team-chat/types'
import { readSupportSettings, saveSupportSettings, startSupportChat, SUPPORT_WELCOME_MAX, tidyWelcomeTemplate } from '@/lib/support-chat/store'
import { teamChatErrorResponse } from '@/lib/team-chat/route-errors'

async function admin() {
  try {
    return await requireAdmin()
  } catch (res) {
    if (res instanceof Response) return res
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}

export async function GET() {
  const user = await admin()
  if (user instanceof Response) return user
  try {
    return NextResponse.json(await readSupportSettings(getServiceClient()))
  } catch (err) {
    return teamChatErrorResponse(err, 'support settings read')
  }
}

export async function PATCH(request: NextRequest) {
  const user = await admin()
  if (user instanceof Response) return user
  let input: Record<string, unknown>
  try {
    input = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  const welcomeTemplate = tidyWelcomeTemplate(input.welcomeTemplate)
  if (!welcomeTemplate) return badRequest(`Write the welcome (up to ${SUPPORT_WELCOME_MAX.toLocaleString('en-US')} characters)`)
  const senderUserId = input.senderUserId == null || input.senderUserId === '' ? null : input.senderUserId
  if (senderUserId !== null && !isUuid(senderUserId)) return badRequest('senderUserId must be a user id')
  // 719: the switch for existing accounts, and their welcome (empty: they get the new-account one).
  if (input.existingAccounts !== undefined && typeof input.existingAccounts !== 'boolean') return badRequest('existingAccounts must be true or false')
  let welcomeExistingTemplate: string | null | undefined
  if (input.welcomeExistingTemplate !== undefined) {
    const raw = typeof input.welcomeExistingTemplate === 'string' ? input.welcomeExistingTemplate.trim() : ''
    welcomeExistingTemplate = raw ? tidyWelcomeTemplate(raw) : null
    if (raw && !welcomeExistingTemplate) return badRequest(`Keep the existing accounts' welcome to ${SUPPORT_WELCOME_MAX.toLocaleString('en-US')} characters`)
  }
  const svc = getServiceClient()
  try {
    if (senderUserId) {
      const { staff } = await readSupportSettings(svc)
      if (!staff.some((s) => s.user_id === senderUserId)) return badRequest('The sender must be on the support team')
    }
    await saveSupportSettings(svc, {
      welcomeTemplate,
      senderUserId: senderUserId as string | null,
      updatedBy: user.id,
      existingAccounts: input.existingAccounts as boolean | undefined,
      welcomeExistingTemplate,
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return teamChatErrorResponse(err, 'support settings save')
  }
}

export async function POST(request: NextRequest) {
  const user = await admin()
  if (user instanceof Response) return user
  let input: Record<string, unknown>
  try {
    input = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  const svc = getServiceClient()
  let userId: string | null = isUuid(input.userId) ? input.userId : null
  if (!userId) {
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : ''
    if (!email || !email.includes('@')) return badRequest('Give the account’s email address')
    const found = (await listAllAuthUsers(svc)).find((u) => u.email?.trim().toLowerCase() === email)
    if (!found) return NextResponse.json({ started: false, channelId: null, reason: 'no_account' })
    userId = found.id
  }
  try {
    // An admin's start is fresh: also for an account that deleted theirs (it clears that).
    return NextResponse.json(await startSupportChat(svc, userId, { fresh: true }))
  } catch (err) {
    return teamChatErrorResponse(err, 'support start')
  }
}
