import { NextResponse } from 'next/server'
import { requireAdmin, getAdminServiceClient } from '@/lib/admin'
import { getPostHogServerClient, serverDefaultProperties } from '@/lib/posthog'

/**
 * Admin "request feedback from a user" endpoint.
 *
 * This is the route the admin SendMessageForm has always POSTed to — it was
 * never implemented, so the request-feedback flow silently 404'd. It inserts
 * an `in_app_messages` row (the per-user, account-tied prompt), which the
 * in-app message channel delivers in realtime (toast → popup, where the person
 * answers). It no longer writes a companion `feedback_requested` notification:
 * that existed for the inbox bell, which went with the notifications page
 * (docs/plans/retire-notifications-page.md).
 *
 * Built on the existing in-app messaging schema (migration 003) — no new tables.
 */
export async function POST(request: Request) {
  let admin
  try {
    admin = await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}))
  const {
    user_id,
    message_title,
    message_body,
    message_type = 'feedback_prompt',
    priority = 'normal',
    cta_text,
    cta_action,
    cta_url,
    expires_after_days = 7,
    feature_request_id,
  } = body as {
    user_id?: string
    message_title?: string
    message_body?: string
    message_type?: string
    priority?: string
    cta_text?: string
    cta_action?: string
    cta_url?: string
    expires_after_days?: number
    feature_request_id?: string
  }

  if (!user_id) {
    return NextResponse.json({ error: 'user_id is required' }, { status: 400 })
  }
  if (!message_title?.trim()) {
    return NextResponse.json({ error: 'message_title is required' }, { status: 400 })
  }
  if (!message_body?.trim()) {
    return NextResponse.json({ error: 'message_body is required' }, { status: 400 })
  }
  // The route is the trust boundary — the form only offers these three, but a
  // raw POST could send anything, and there's no DB CHECK on message_type.
  const ALLOWED_MESSAGE_TYPES = ['announcement', 'tip', 'feedback_prompt']
  if (!ALLOWED_MESSAGE_TYPES.includes(message_type)) {
    return NextResponse.json({ error: 'Invalid message_type' }, { status: 400 })
  }

  const supabase = await getAdminServiceClient()

  const expiresAt = new Date()
  expiresAt.setDate(expiresAt.getDate() + (expires_after_days ?? 7))

  // For a feedback prompt we want the user to answer in-app; the desktop CTA
  // defaults map cleanly: 'respond' opens the answer form in the inbox.
  const resolvedCtaText = cta_text?.trim() || (message_type === 'feedback_prompt' ? 'Share feedback' : 'Got it')
  const resolvedCtaAction = cta_action || (cta_url ? 'url' : message_type === 'feedback_prompt' ? 'respond' : 'dismiss')

  const { data: message, error: insertError } = await supabase
    .from('in_app_messages')
    .insert({
      user_id,
      message_title: message_title.trim(),
      message_body: message_body.trim(),
      message_type,
      cta_text: resolvedCtaText,
      cta_action: resolvedCtaAction,
      cta_url: cta_url?.trim() || null,
      priority,
      status: 'pending',
      sent_by: admin.email,
      expires_at: expiresAt.toISOString(),
    })
    .select()
    .single()

  if (insertError || !message) {
    return NextResponse.json(
      { error: insertError?.message ?? 'Failed to create message' },
      { status: 500 },
    )
  }

  // in_app_messages has no `metadata` column, so a roadmap tie isn't stored on
  // the message (no current caller sends feature_request_id); it still rides
  // on the analytics event below.

  const posthog = getPostHogServerClient()
  posthog?.capture({
    distinctId: admin.id,
    event: 'admin_message_sent',
    properties: {
      ...serverDefaultProperties,
      target_user_id: user_id,
      message_type,
      priority,
      tied_feature_request: !!feature_request_id,
    },
  })

  return NextResponse.json({ message })
}

/**
 * List a user's in-app messages (+ their responses) for the admin user-detail
 * Messages table. Returns newest first.
 */
export async function GET(request: Request) {
  try {
    await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const userId = new URL(request.url).searchParams.get('user_id')
  if (!userId) {
    return NextResponse.json({ error: 'user_id is required' }, { status: 400 })
  }

  const supabase = await getAdminServiceClient()
  const { data, error } = await supabase
    .from('in_app_messages')
    .select('*, message_responses(*)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ messages: data ?? [] })
}
