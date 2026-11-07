import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'

/**
 * Answer a feedback prompt: stores a message_responses row (optional 1-5 rating
 * + text, optionally tied to a feature_request) and marks the in_app_message
 * `responded`. RLS (migration 003) lets a user insert their own responses and
 * update their own messages.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { supabase, user } = auth

  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const { rating, response_text, feature_request_id } = body as {
    rating?: number
    response_text?: string
    feature_request_id?: string
  }

  const text = response_text?.trim() || null
  const hasRating = typeof rating === 'number'
  if (!text && !hasRating) {
    return badRequest('A rating or response is required')
  }
  if (hasRating && (rating < 1 || rating > 5)) {
    return badRequest('rating must be between 1 and 5')
  }
  if (text && text.length > 5000) {
    return badRequest('response is too long (max 5000 chars)')
  }

  // Confirm the message belongs to the user (RLS already enforces this, but we
  // surface a clean 404 rather than an opaque insert failure).
  const { data: message } = await supabase
    .from('in_app_messages')
    .select('id')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!message) return notFound('Message not found')

  // If the answer is tied to a feature request, only accept an id the caller can
  // actually see. The RLS-scoped client returns no row for a private/foreign
  // post (migration 138), so this rejects linking to a request you can't view.
  let linkedFeatureRequestId: string | null = null
  if (feature_request_id) {
    const { data: fr } = await supabase
      .from('feature_requests')
      .select('id')
      .eq('id', feature_request_id)
      .maybeSingle()
    if (!fr) return badRequest('Invalid feature_request_id')
    linkedFeatureRequestId = fr.id as string
  }

  const { data: response, error: insertError } = await supabase
    .from('message_responses')
    .insert({
      message_id: id,
      user_id: user.id,
      rating: hasRating ? rating : null,
      response_text: text,
      feature_request_id: linkedFeatureRequestId,
    })
    .select()
    .single()

  if (insertError) return serverError(insertError.message)

  await supabase
    .from('in_app_messages')
    .update({ status: 'responded', responded_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', user.id)

  return NextResponse.json({ response })
}

/** Dismiss a feedback prompt without answering. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { supabase, user } = auth

  const { id } = await params
  const { error } = await supabase
    .from('in_app_messages')
    .update({ status: 'dismissed', dismissed_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', user.id)

  if (error) return serverError(error.message)

  return NextResponse.json({ ok: true })
}
